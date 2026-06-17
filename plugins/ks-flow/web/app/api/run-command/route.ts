// /api/run-command — run the user's configured worktree-removal command and
// STREAM its output back to the board.
//
// POST { path, identifier?, title? }
//   If GCS archiving is enabled (board-settings.json gcsArchive.enabled), FIRST
//   runs `dist/archive.js <path> <identifier> <title>` to zip the worktree's
//   transcript + workflow folders and push them to GCS — and ABORTS the removal
//   if that fails (so nothing is deleted un-archived). Then loads the stored
//   removeCommand, substitutes the {{path}} / {{identifier}} / {{title}}
//   placeholders, and runs it via `zsh -c` from the tracked project root.
//   Output is streamed as newline-delimited JSON (NDJSON):
//     {"type":"stdout","data":"…"}  {"type":"stderr","data":"…"}
//     {"type":"exit","code":0}
//   Pre-exec failures (no command configured) still return a normal JSON 400.
//
// TRUST BOUNDARY: this executes a shell command authored by the user in their
// own Settings page, on their own machine, against a localhost single-user
// board. It is intentionally arbitrary — the user is running their own command.
// The placeholder values are ALSO exposed as env vars so the command can avoid
// string interpolation (KS_WORKTREE / KS_IDENTIFIER / KS_TITLE).
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
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

type Send = (obj: unknown) => void;

/** Spawn a child, stream its stdout/stderr as NDJSON via `send`, resolve with
 * the exit code (-1 on spawn error or timeout). */
function runStreaming(
  send: Send,
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let settled = false;
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      send({ type: 'stderr', data: `\n[ks-flow] command timed out after ${Math.round(timeoutMs / 1000)}s\n` });
      done(-1);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => send({ type: 'stdout', data: d.toString() }));
    child.stderr?.on('data', (d: Buffer) => send({ type: 'stderr', data: d.toString() }));
    child.on('error', (e) => {
      send({ type: 'stderr', data: `\n[ks-flow] ${e.message}\n` });
      done(-1);
    });
    child.on('close', (code) => done(code ?? 0));
  });
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

  const settings = readJson(join(dataDir(), 'board-settings.json'), {
    removeCommand: '',
    gcsArchive: { enabled: false } as { enabled?: boolean },
  });
  const removeCommand = typeof settings.removeCommand === 'string' ? settings.removeCommand : '';
  if (!removeCommand.trim()) {
    return NextResponse.json(
      { error: 'No remove command configured. Set one in Settings.', needsConfig: true },
      { status: 400 },
    );
  }
  const archiveEnabled = settings.gcsArchive?.enabled === true;

  const identifier = (body.identifier ?? '').trim();
  const title = (body.title ?? '').trim();
  const command = removeCommand
    .replaceAll('{{path}}', worktree)
    .replaceAll('{{identifier}}', identifier)
    .replaceAll('{{title}}', title);

  // cwd = tracked project root so relative git invocations resolve.
  const { projectPath } = readJson(join(dataDir(), 'project.conf'), { projectPath: '' });
  const cwd = projectPath && existsSync(projectPath) ? projectPath : undefined;

  // Compiled archive entrypoint (bootstrap copies src → $CLAUDE_PLUGIN_DATA/daemon).
  const archiveScript = join(dataDir(), 'daemon', 'dist', 'archive.js');

  // `zsh -c` is non-interactive + non-login, so it loads only ~/.zshenv — not
  // ~/.zprofile/.zshrc, where the user's PATH, aliases, and shell functions
  // usually live. Source them manually (login order: zprofile then zshrc) so
  // the command behaves like it would in their terminal. The command runs
  // through `eval "$KS_CMD"` so aliases (a parse-time substitution) resolve
  // after sourcing rather than before.
  const prelude =
    '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
    '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null; ';

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send: Send = (obj) => {
        if (!closed) controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      };
      const finish = (code: number): void => {
        if (closed) return;
        send({ type: 'exit', code });
        closed = true;
        controller.close();
      };

      void (async () => {
        // 1) Archive to GCS first. A non-zero exit aborts the whole operation —
        //    we never delete a worktree we failed to archive.
        if (archiveEnabled) {
          send({ type: 'stdout', data: '[ks-flow] archiving transcript + workflow to GCS…\n' });
          const code = await runStreaming(
            send,
            process.execPath, // the board's own node
            [archiveScript, worktree, identifier, title],
            { cwd, env: process.env },
            600_000, // zstd --ultra -22 on a long transcript can take minutes
          );
          if (code !== 0) {
            send({
              type: 'stderr',
              data: `\n[ks-flow] archive failed (exit ${code}) — removal ABORTED. Fix GCS settings/creds (or disable archiving), then retry.\n`,
            });
            finish(code || -1);
            return;
          }
          send({ type: 'stdout', data: '[ks-flow] archive complete.\n\n' });
        }

        // 2) Run the user's remove command (echo it first).
        send({ type: 'stdout', data: `$ ${command}\n` });
        const code = await runStreaming(
          send,
          '/bin/zsh',
          ['-c', prelude + 'eval "$KS_CMD"'],
          {
            cwd,
            env: {
              ...process.env,
              KS_CMD: command,
              KS_WORKTREE: worktree,
              KS_IDENTIFIER: identifier,
              KS_TITLE: title,
            },
          },
          120_000,
        );
        finish(code);
      })();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
