// /api/run-command — run the user's configured worktree-removal command and
// STREAM its output back to the board.
//
// POST { path, identifier?, title? }
//   Loads the stored removeCommand from board-settings.json, substitutes the
//   {{path}} / {{identifier}} / {{title}} placeholders, and runs it via
//   `zsh -c` from the tracked project root (so `git worktree remove …`
//   resolves). Output is streamed as newline-delimited JSON (NDJSON):
//     {"type":"stdout","data":"…"}  {"type":"stderr","data":"…"}
//     {"type":"exit","code":0}
//   Pre-exec failures (no command configured) still return a normal JSON 400.
//
// TRUST BOUNDARY: this executes a shell command authored by the user in their
// own Settings page, on their own machine, against a localhost single-user
// board. It is intentionally arbitrary — the user is running their own command.
// The placeholder values are ALSO exposed as env vars so the command can avoid
// string interpolation (KS_WORKTREE / KS_IDENTIFIER / KS_TITLE).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: { path?: string; identifier?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const worktree = (body.path ?? '').trim();
  if (!worktree) {
    return NextResponse.json({ error: 'A worktree path is required.' }, { status: 400 });
  }

  const { removeCommand } = readJson(join(dataDir(), 'board-settings.json'), {
    removeCommand: '',
  });
  if (!removeCommand.trim()) {
    return NextResponse.json(
      { error: 'No remove command configured. Set one in Settings.', needsConfig: true },
      { status: 400 },
    );
  }

  const identifier = (body.identifier ?? '').trim();
  const title = (body.title ?? '').trim();
  const command = removeCommand
    .replaceAll('{{path}}', worktree)
    .replaceAll('{{identifier}}', identifier)
    .replaceAll('{{title}}', title);

  // cwd = tracked project root so relative git invocations resolve.
  const { projectPath } = readJson(join(dataDir(), 'project.conf'), { projectPath: '' });
  const cwd = projectPath && existsSync(projectPath) ? projectPath : undefined;

  // Run in zsh (macOS default login shell) so the user's command behaves the
  // same as it would in their terminal. Stream stdout/stderr as NDJSON.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: unknown): void => {
        if (!closed) controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      };
      const finish = (code: number): void => {
        if (closed) return;
        send({ type: 'exit', code });
        closed = true;
        controller.close();
      };

      // Echo the resolved command first so the panel shows what ran.
      send({ type: 'stdout', data: `$ ${command}\n` });

      // `zsh -c` is non-interactive + non-login, so it loads only ~/.zshenv —
      // not ~/.zprofile/.zshrc, where the user's PATH, aliases, and shell
      // functions usually live. Source them manually (login order: zprofile
      // then zshrc) so the command behaves like it would in their terminal.
      // Source errors are swallowed so interactive-only widget warnings (zle,
      // compinit) don't pollute the output. NOTE: a `.zshrc` guarded with
      // `[[ -o interactive ]] || return` will still no-op here.
      //
      // The command itself runs through `eval "$KS_CMD"` rather than being
      // concatenated into this -c string. Aliases are a PARSE-TIME substitution:
      // if the command were in the same -c buffer, it would be parsed before the
      // source runs and the alias wouldn't exist yet. eval re-parses at runtime,
      // after sourcing, so aliases/functions defined in .zshrc resolve.
      const prelude =
        '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
        '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null; ';

      const child = spawn('/bin/zsh', ['-c', prelude + 'eval "$KS_CMD"'], {
        cwd,
        env: {
          ...process.env,
          KS_CMD: command,
          KS_WORKTREE: worktree,
          KS_IDENTIFIER: identifier,
          KS_TITLE: title,
        },
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        send({ type: 'stderr', data: '\n[ks-flow] command timed out after 120s\n' });
        finish(-1);
      }, 120_000);

      child.stdout.on('data', (d: Buffer) => send({ type: 'stdout', data: d.toString() }));
      child.stderr.on('data', (d: Buffer) => send({ type: 'stderr', data: d.toString() }));
      child.on('error', (e) => {
        clearTimeout(timer);
        send({ type: 'stderr', data: `\n[ks-flow] ${e.message}\n` });
        finish(-1);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code ?? 0);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
