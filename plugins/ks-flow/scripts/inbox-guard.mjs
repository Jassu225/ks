#!/usr/bin/env node
// inbox-guard.mjs — PreToolUse guard for the Plannotator Inbox tool.
//
// The Inbox files a message under `project_path` when one is given, and ks-flow
// shows a card's Inbox threads by the asking session. Without this guard any
// session could post into another checkout's project (e.g. a worktree another
// session is working in). So a write — send_message, submit_guide — may only
// name a folder in the session's own checkout: the same git toplevel as the
// session's cwd (a subfolder is fine; a nested or sibling worktree is not).
// No project_path means the session's own folder, which is always allowed.
// Reads (read_thread, search, wait_for_reply) and resolve_message pass.
//
// Zero-dep, like notify-context.mjs. Fails open on input it can't read: a
// broken guard must not take the Inbox away.
//
// Hook input (stdin): { cwd, tool_name, tool_input: { action?, project_path } }
// Output: a PreToolUse "deny" decision on stdout, or nothing (allow).
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const WRITES = new Set(['send_message', 'submit_guide']);

function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function gitToplevel(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? realpathOr(out) : null;
  } catch {
    return null;
  }
}

const sameOrUnder = (child, parent) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Why this call is refused, or null to let it through. `toplevel` is
 * injectable for tests.
 */
export function refusal(input, toplevel = gitToplevel) {
  const ti = input?.tool_input;
  if (!ti || typeof ti !== 'object') return null;
  // The mod's one tool takes `action`; the stdio server (`plannotator inbox mcp`)
  // has a tool per action: mcp__<server>__send_message.
  const action = typeof ti.action === 'string' ? ti.action : String(input.tool_name ?? '').split('__').pop();
  if (!WRITES.has(action)) return null;
  const given = typeof ti.project_path === 'string' ? ti.project_path.trim() : '';
  if (!given) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? realpathOr(input.cwd) : null;
  if (!cwd) return null;

  const target = realpathOr(isAbsolute(given) ? given : resolve(cwd, given));
  const own = toplevel(cwd);
  const theirs = toplevel(target);
  // Both in git: the same checkout. Otherwise the session's folder or below it.
  const ok = own && theirs ? own === theirs : sameOrUnder(target, own ?? cwd);
  if (ok) return null;
  const home = own ?? cwd;
  return (
    `The Inbox only takes messages for this session's own checkout (${home}); ` +
    `project_path ${given} is outside it. Leave project_path out, or name a folder inside ${home}. ` +
    `A message for another checkout belongs to the session working there.`
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // unreadable input: allow
  }
  const why = refusal(input);
  if (!why) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: why,
      },
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
