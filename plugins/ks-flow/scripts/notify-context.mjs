#!/usr/bin/env node
// notify-context.mjs — resolve the ks workflow unit for a working directory, so
// the bash notify hooks can show ticket/project context (not a generic line).
//
// Zero-dep (no `yaml` package — hooks must run without a build), so it does a
// deliberately minimal, line-based read of just the four fields it needs:
// the ticket/project block's `identifier` + `name`, and top-level `worktree_dir`
// (to pick the right state.yaml when a checkout holds several).
//
// Usage:  node notify-context.mjs --cwd <path>
// Prints: "<type>\t<identifier>\t<title>" on success, nothing on no match.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const cwd = arg('--cwd') || process.cwd();

function gitToplevel(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function canon(p) {
  if (!p) return null;
  let s = p.trim();
  if (s.startsWith('~')) s = join(homedir(), s.slice(1));
  try {
    return realpathSync(s);
  } catch {
    return s;
  }
}

function strip(v) {
  let s = (v ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    s = s.slice(1, -1);
  return s;
}

// Minimal parse: type, identifier, title, worktree_dir.
function parseStateYaml(text) {
  const lines = text.split('\n');
  let type = null;
  let inBlock = null; // 'ticket' | 'project' | null
  let identifier = null;
  let title = null;
  let worktreeDir = null;
  for (const raw of lines) {
    const top = raw.match(/^([A-Za-z][\w-]*):\s*(.*)$/); // unindented key
    if (top) {
      const key = top[1];
      if (key === 'ticket' || key === 'project') {
        if (!type) type = key;
        inBlock = key;
      } else {
        inBlock = null;
        if (key === 'worktree_dir' && top[2]) worktreeDir = strip(top[2]);
      }
      continue;
    }
    if (inBlock) {
      const m = raw.match(/^\s+(identifier|name):\s*(.*)$/);
      if (m) {
        if (m[1] === 'identifier' && !identifier) identifier = strip(m[2]);
        else if (m[1] === 'name' && !title) title = strip(m[2]);
      }
    }
  }
  if (!type) return null;
  return { type, identifier, title, worktreeDir };
}

// Collect every workflow/**/state.yaml under the repo root (bounded walk).
function findStateYamls(root) {
  const base = join(root, 'workflow');
  const out = [];
  const stack = [base];
  let budget = 5000; // guardrail against a pathological tree
  while (stack.length && budget-- > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'state.yaml') out.push(p);
    }
  }
  return out;
}

function main() {
  const root = gitToplevel(cwd);
  if (!root) return;
  const rootCanon = canon(root);
  const paths = findStateYamls(root);
  if (!paths.length) return;

  let best = null; // { unit, mtimeMs, exact }
  for (const p of paths) {
    let text;
    let mtimeMs;
    try {
      text = readFileSync(p, 'utf8');
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    const unit = parseStateYaml(text);
    if (!unit) continue;
    const exact = unit.worktreeDir != null && canon(unit.worktreeDir) === rootCanon;
    const cand = { unit, mtimeMs, exact };
    if (!best) best = cand;
    else if (exact && !best.exact) best = cand; // worktree match wins
    else if (exact === best.exact && mtimeMs > best.mtimeMs) best = cand; // else freshest
  }
  if (!best) return;
  const { type, identifier, title } = best.unit;
  process.stdout.write(`${type}\t${identifier ?? ''}\t${title ?? ''}`);
}

main();
