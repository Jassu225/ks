// lib/streamproc.ts — run a child process and stream it as NDJSON.
//
// The line protocol /api/run-command established, factored out so the backup and
// restore routes speak it too and the board's one log panel can read any of
// them:
//   { type: 'stdout' | 'stderr', data: string }
//   { type: 'exit', code: number }
import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';

export interface StreamProcOpts {
  /** Absolute path to the executable (usually process.execPath). */
  command: string;
  args: string[];
  cwd?: string;
  /** Killed with SIGKILL after this many ms. */
  timeoutMs?: number;
  /** Emitted as the first stdout line, before the child starts. */
  banner?: string;
}

/**
 * NDJSON response streaming a child process's output.
 *
 * stdout and stderr are interleaved in arrival order, which is what makes the
 * log readable — a failure line lands next to the work that caused it rather
 * than in a separate block at the end.
 */
export function streamProcess(opts: StreamProcOpts): NextResponse {
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

      if (opts.banner) send({ type: 'stdout', data: opts.banner });

      const child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            send({ type: 'stderr', data: `\n[ks-flow] timed out after ${opts.timeoutMs}ms — killing.\n` });
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : null;

      child.stdout.on('data', (d: Buffer) => send({ type: 'stdout', data: d.toString() }));
      child.stderr.on('data', (d: Buffer) => send({ type: 'stderr', data: d.toString() }));
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        send({ type: 'stderr', data: `\n[ks-flow] could not start: ${e.message}\n` });
        finish(-1);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        finish(code ?? -1);
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
    },
  });
}
