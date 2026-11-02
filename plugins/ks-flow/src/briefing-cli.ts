// briefing-cli.ts — `ks-flow briefing …`: the master session's only way to read
// and write the Briefing (docs/briefing.md). The work is in lib/briefing/cli.ts;
// this file parses argv, reads JSON input and prints.
//
//   context [--json]                         what the master needs for a pass (always JSON)
//   find --group <groupKey> | --thread <threadUrl|messageUrl|ts> | --key <key>   (always JSON)
//   add <file.json | ->                      upsert one item or an array
//   evidence <uid> --text <t> [--url <u>]    append one "looks done" hint
//   run start --trigger <t> [--slot HH:MM]
//   run finish <runUid> --cursor <iso> --added <n> --updated <n> [--summary <s>] [--failed <error>]
//   daily set <YYYY-MM-DD> --part log-in|log-off <file.json | ->
//   daily get [<YYYY-MM-DD>]
//
// There is no archive, delete or un-archive: the person does that on the board.
// Exit: 0 done (an archived item skipped counts as done); 1 the item or run
// named doesn't exist, or the run already finished; 2 usage, bad input, or the
// store can't answer.
import { readFileSync } from 'node:fs';
import { briefingSettings } from './lib/boardsettings.js';
import {
  add,
  boardSummary,
  context,
  dailyGet,
  dailySet,
  evidence,
  find,
  InputError,
  NotFoundError,
  parseInput,
  runFinish,
  runStart,
  type BriefingEnv,
  type FindBy,
} from './lib/briefing/cli.js';
import { loadConfig, readProjectConf } from './lib/config.js';
import { createProvider } from './lib/db/index.js';

const USAGE = `usage: ks-flow briefing <command>
  context [--json]
  find --group <groupKey> | --thread <threadUrl|messageUrl|ts> | --key <key>
  add <file.json | ->
  evidence <uid> --text <t> [--url <u>]
  run start --trigger schedule|button|log-in|log-off|manual [--slot HH:MM]
  run finish <runUid> --cursor <iso> --added <n> --updated <n> [--summary <s>] [--failed <error>]
  daily set <YYYY-MM-DD> --part log-in|log-off <file.json | ->
  daily get [<YYYY-MM-DD>]
Add --json to any command for JSON output (context and find always print JSON).`;

function fail(code: number, msg: string): never {
  console.error(`ks-flow briefing: ${msg}`);
  process.exit(code);
}

/** Positionals and `--flag value` pairs; `--json` and `--help` are bare. A lone
 * `-` is a positional (stdin). */
function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string>; json: boolean } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') flags.set('help', '');
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const v = argv[i + 1];
        if (v === undefined) throw new InputError(`${a} needs a value`);
        flags.set(a.slice(2), v);
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags, json };
}

function readJson(path: string | undefined): unknown {
  if (!path) throw new InputError('give a JSON file, or - for stdin');
  let raw: string;
  try {
    raw = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (e) {
    throw new InputError(`can't read ${path === '-' ? 'stdin' : path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new InputError(`${path === '-' ? 'stdin' : path}: not JSON (${(e as Error).message})`);
  }
}

function count(flags: Map<string, string>, name: string): number {
  const v = flags.get(name);
  if (v === undefined) throw new InputError(`--${name} is required`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InputError(`--${name}: a whole number ≥ 0`);
  return n;
}

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main(): Promise<void> {
  const { pos, flags, json } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.has('help')) {
    console.log(USAGE);
    process.exit(cmd ? 0 : 2);
  }

  const conf = readProjectConf();
  if (!conf) fail(2, 'no project.conf — run `ks-flow start` first');
  const provider = createProvider(loadConfig());
  const env: BriefingEnv = {
    store: provider.briefing(),
    projectId: conf.projectId,
    settings: briefingSettings(),
    now: () => new Date(),
  };

  switch (cmd) {
    case 'context': {
      const source = provider.source();
      const [project, units] = await Promise.all([
        source.getProject(conf.projectId),
        source.getWorkUnits(conf.projectId),
      ]);
      out(await context(env, boardSummary(project, units)));
      return;
    }

    case 'find': {
      const by: FindBy[] = [];
      if (flags.has('group')) by.push({ group: flags.get('group')! });
      if (flags.has('thread')) by.push({ thread: flags.get('thread')! });
      if (flags.has('key')) by.push({ key: flags.get('key')! });
      if (by.length !== 1) throw new InputError('find takes exactly one of --group, --thread, --key');
      out(await find(env, by[0]));
      return;
    }

    case 'add': {
      const body = readJson(rest[0]);
      const inputs = Array.isArray(body) ? body.map((v, i) => parseInput(v, `item[${i}]`)) : [parseInput(body)];
      const results = await add(env, inputs);
      if (json) out(Array.isArray(body) ? results : results[0]);
      else
        for (const r of results)
          console.log('skipped' in r ? `skipped (archived)  ${r.uid}` : `${r.action.padEnd(9)} ${r.uid}  due ${r.dueAt}${r.dueKept ? '  (due kept: set by you)' : ''}`);
      return;
    }

    case 'evidence': {
      const uid = rest[0];
      if (!uid) throw new InputError('evidence <uid> --text <t> [--url <u>]');
      const text = flags.get('text');
      if (!text) throw new InputError('--text is required');
      const r = await evidence(env, uid, text, flags.get('url'));
      if (json) out(r);
      else console.log('skipped' in r ? `skipped (archived)  ${uid}` : `${uid}: ${r.evidence.length} evidence line(s)`);
      return;
    }

    case 'run': {
      const [sub, runUid] = rest;
      if (sub === 'start') {
        const trigger = flags.get('trigger');
        if (!trigger) throw new InputError('--trigger is required');
        const run = await runStart(env, trigger, flags.get('slot') ?? null);
        if (json) out(run);
        else console.log(`${run.uid}  previous cursor ${run.previousCursor ?? '(none)'}`);
        return;
      }
      if (sub === 'finish') {
        if (!runUid) throw new InputError('run finish <runUid> --cursor <iso> --added <n> --updated <n>');
        const run = await runFinish(env, runUid, {
          cursor: flags.get('cursor'),
          added: count(flags, 'added'),
          updated: count(flags, 'updated'),
          summary: flags.get('summary'),
          failed: flags.get('failed'),
        });
        if (json) out(run);
        else console.log(`${run.uid}  ${run.status}  cursor ${run.slackCursor ?? '(unchanged)'}`);
        return;
      }
      throw new InputError('run start | run finish');
    }

    case 'daily': {
      const [sub, date] = rest;
      if (sub === 'set') {
        if (!date) throw new InputError('daily set <YYYY-MM-DD> --part log-in|log-off <file.json | ->');
        const part = flags.get('part');
        if (!part) throw new InputError('--part is required');
        const doc = await dailySet(env, date, part, readJson(rest[2]));
        if (json) out(doc);
        else console.log(`${doc.date}: ${part} written`);
        return;
      }
      if (sub === 'get') {
        const doc = await dailyGet(env, date);
        if (json || doc) out(doc);
        else console.log(`no daily log for ${date ?? 'today'}`);
        return;
      }
      throw new InputError('daily set | daily get');
    }

    default:
      throw new InputError(`unknown command ${JSON.stringify(cmd)}\n${USAGE}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof InputError) fail(2, e.message);
    if (e instanceof NotFoundError) fail(1, e.message);
    fail(2, `${(e as Error).message} — is the daemon running? \`ks-flow start\``);
  });
