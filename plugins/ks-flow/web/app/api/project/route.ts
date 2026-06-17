// /api/project — read or re-point the tracked project from the board.
//
// GET  → the current project.conf (projectPath / commonDir / projectId).
// POST {path} → validate the dir is a git repo, derive its git-common-dir +
//   projectId (the same way bootstrap.sh does), rewrite project.conf, and
//   restart the daemon so it re-points and re-backfills. Errors with 400 if the
//   path is missing, absent, or not a git repository.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
const LABEL = 'com.ksflow.ingester';

function dataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}
const confPath = (): string => join(dataDir(), 'project.conf');

// The data dir for a *specific* project, via the shared single source of truth
// (src/lib/datadir.mjs). Re-pointing to a different repo must write that repo's
// own derived dir — not the board's inherited CLAUDE_PLUGIN_DATA (the current
// project's dir). Falls back to the current dataDir() if the shim is absent.
function dataDirForProject(projectPath: string): string {
  const root = process.env.KS_FLOW_PLUGIN_ROOT;
  if (root) {
    try {
      const shim = join(root, 'src', 'lib', 'datadir.mjs');
      const out = execFileSync('node', [shim, '--project', projectPath], {
        encoding: 'utf8',
      }).trim();
      if (out) return out;
    } catch {
      /* fall through to the current data dir */
    }
  }
  return dataDir();
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const conf = JSON.parse(readFileSync(confPath(), 'utf8'));
    return NextResponse.json({
      projectPath: conf.projectPath ?? '',
      commonDir: conf.commonDir ?? '',
      projectId: conf.projectId ?? '',
    });
  } catch {
    return NextResponse.json({ projectPath: '', commonDir: '', projectId: '' });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const raw = (body.path ?? '').trim();
  if (!raw) return NextResponse.json({ error: 'A project path is required.' }, { status: 400 });

  const projectPath = expandTilde(raw);
  if (!existsSync(projectPath)) {
    return NextResponse.json(
      { error: `Directory does not exist: ${projectPath}` },
      { status: 400 },
    );
  }

  // git-common-dir — this is the check that fails for non-repos.
  let commonRaw: string;
  try {
    commonRaw = execFileSync('git', ['-C', projectPath, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return NextResponse.json(
      { error: `Not a git repository: ${projectPath}` },
      { status: 400 },
    );
  }

  const absCommon = isAbsolute(commonRaw) ? commonRaw : join(projectPath, commonRaw);
  const commonDir = join(safeRealpath(dirname(absCommon)), basename(absCommon));
  const projectId = createHash('sha256').update(commonDir).digest('hex').slice(0, 16);
  const canonicalPath = safeRealpath(projectPath);

  // Worktree paths (realpath'd), mirroring bootstrap's enumeration.
  let worktreePaths: string[] = [];
  try {
    const out = execFileSync('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    worktreePaths = out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((p) => p && existsSync(p))
      .map(safeRealpath);
  } catch {
    // no worktrees / older git — fine
  }

  // Write project.conf into the NEW project's own derived data dir (bootstrap
  // below re-derives the same dir; this also covers the kickstart fallback).
  const targetDataDir = dataDirForProject(projectPath);
  mkdirSync(targetDataDir, { recursive: true });
  writeFileSync(
    join(targetDataDir, 'project.conf'),
    JSON.stringify(
      { projectPath: canonicalPath, commonDir, projectId, worktreePaths },
      null,
      2,
    ),
  );

  // Install/refresh + (re)start the daemon. Prefer the full bootstrap (builds
  // the daemon, downloads PocketBase, loads the launchd agent) when we can
  // locate it via KS_FLOW_PLUGIN_ROOT (exported by `ks-flow open`); this is
  // what makes setting a project from a fresh install actually start things.
  // Fall back to kickstart, which only works if the agent is already loaded.
  let daemon = 'not restarted';
  const bootstrap = process.env.KS_FLOW_PLUGIN_ROOT
    ? join(process.env.KS_FLOW_PLUGIN_ROOT, 'scripts', 'bootstrap.sh')
    : '';
  if (bootstrap && existsSync(bootstrap)) {
    try {
      execFileSync(bootstrap, [], {
        env: { ...process.env, CLAUDE_PLUGIN_OPTION_project_path: canonicalPath },
        stdio: 'ignore',
        timeout: 300_000, // first run downloads PocketBase + builds the daemon
      });
      daemon = 'installed/started';
    } catch {
      daemon = 'bootstrap failed — run `ks-flow set-project` in a terminal to see logs';
    }
  } else {
    try {
      const uid = process.getuid?.() ?? 0;
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
      daemon = 'restarted';
    } catch {
      daemon = 'not running — run `ks-flow start`';
    }
  }

  return NextResponse.json({
    ok: true,
    projectPath: canonicalPath,
    commonDir,
    projectId,
    worktrees: worktreePaths.length,
    daemon,
  });
}
