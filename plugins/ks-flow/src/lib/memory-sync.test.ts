import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, homeToTilde, isIndexPath, MemorySync, plainGit, QUIET_MS, RETRY_MS, whatToDo } from './memory-sync.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
Object.assign(process.env, ENV); // plainGit's commits

/** A bare remote seeded like `ks-setup memory init`, and two clones (Mac A, Mac B). */
function setup(): { remote: string; a: string; b: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'memsync-'));
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, '.gitattributes'), 'MEMORY.md merge=union\n');
  mkdirSync(join(seed, 'ks'));
  writeFileSync(join(seed, 'ks', 'MEMORY.md'), '# Memory Index\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', '-u', 'origin', 'HEAD');
  const a = join(root, 'a');
  const b = join(root, 'b');
  git(root, 'clone', '-q', remote, a);
  git(root, 'clone', '-q', remote, b);
  return { remote, a, b, home: '/Users/someone' };
}

const sync = (dir: string, home: string, label = 'A') => new MemorySync(dir, plainGit, { home, label });

test('isIndexPath: only a project folder MEMORY.md', () => {
  assert.equal(isIndexPath('ks/MEMORY.md'), true);
  assert.equal(isIndexPath('ks/feedback_x.md'), false);
  assert.equal(isIndexPath('MEMORY.md'), false);
  assert.equal(isIndexPath('ks/sub/MEMORY.md'), false);
});

test('homeToTilde: the home folder, never a longer name that starts with it', () => {
  assert.equal(homeToTilde('see /Users/jassu/git/ks and /Users/jassu/x', '/Users/jassu'), 'see ~/git/ks and ~/x');
  assert.equal(homeToTilde('/Users/jassuX/git', '/Users/jassu'), '/Users/jassuX/git');
  assert.equal(homeToTilde('/Users/jassu/a', '/Users/jassu/'), '~/a');
});

test('changedFiles: porcelain -z, renames give the new path', () => {
  assert.deepEqual(changedFiles(' M ks/MEMORY.md\0?? ks/new.md\0R  ks/b.md\0ks/a.md\0'), ['ks/MEMORY.md', 'ks/new.md', 'ks/b.md']);
});

test('whatToDo: the quiet window, a wanted pull, the retry wait', () => {
  const s = { dirtySince: 1000, pullWanted: false, retryAt: 0 };
  assert.equal(whatToDo(s, 1000 + QUIET_MS - 1), null);
  assert.equal(whatToDo(s, 1000 + QUIET_MS), 'push');
  assert.equal(whatToDo({ ...s, pullWanted: true }, 1000), 'pull');
  assert.equal(whatToDo({ ...s, retryAt: 1000 + QUIET_MS + 5 }, 1000 + QUIET_MS), null);
  assert.equal(whatToDo({ dirtySince: null, pullWanted: false, retryAt: 0 }, 9e12), null);
});

test('changed: an index change (re)starts the window; another file alone does not', () => {
  const m = sync('/nowhere', '/h');
  m.state.pullWanted = false;
  m.changed('ks/feedback_x.md', 10);
  assert.equal(m.state.dirtySince, null);
  m.changed('ks/MEMORY.md', 10);
  m.changed('ks/MEMORY.md', 50);
  assert.equal(m.state.dirtySince, 50);
});

test('sync: A pushes its memory (home path as ~), B pulls it on seeing A’s head', async () => {
  const { a, b, home } = setup();
  writeFileSync(join(a, 'ks', 'feedback_x.md'), `path ${home}/git/ks\n`);
  writeFileSync(join(a, 'ks', 'MEMORY.md'), '# Memory Index\n- [x](feedback_x.md)\n');
  const ma = sync(a, home);
  ma.state.pullWanted = false;
  ma.changed('ks/MEMORY.md', 0);
  const out = await ma.tick(QUIET_MS);
  assert.ok(out && out.committed === 2 && out.changed);
  assert.equal(ma.state.dirtySince, null);
  assert.equal(readFileSync(join(a, 'ks', 'feedback_x.md'), 'utf8'), 'path ~/git/ks\n');

  const mb = sync(b, '/Users/other', 'B');
  mb.state.pullWanted = false;
  assert.equal(await mb.seen(out!.head), true);
  await mb.tick(1);
  assert.equal(readFileSync(join(b, 'ks', 'feedback_x.md'), 'utf8'), 'path ~/git/ks\n');
  assert.equal(await mb.seen(out!.head), false, 'B has it now');
});

test('sync: nothing changed and no pull wanted → no commit, no network', async () => {
  const { a } = setup();
  const m = sync(a, '/h');
  assert.equal(await m.sync(false), null);
});

test('sync: index lines added on both Macs merge (union), no conflict', async () => {
  const { a, b } = setup();
  writeFileSync(join(a, 'ks', 'a.md'), 'a\n');
  writeFileSync(join(a, 'ks', 'MEMORY.md'), '# Memory Index\n- [a](a.md)\n');
  writeFileSync(join(b, 'ks', 'b.md'), 'b\n');
  writeFileSync(join(b, 'ks', 'MEMORY.md'), '# Memory Index\n- [b](b.md)\n');
  await sync(a, '/h').sync(false);
  await sync(b, '/h', 'B').sync(false);
  const idx = readFileSync(join(b, 'ks', 'MEMORY.md'), 'utf8');
  assert.match(idx, /\[a\]\(a\.md\)/);
  assert.match(idx, /\[b\]\(b\.md\)/);
  assert.ok(existsSync(join(b, 'ks', 'a.md')));
});

test('sync: a real conflict aborts the rebase, throws, and retries 2 min later', async () => {
  const { a, b } = setup();
  writeFileSync(join(a, 'ks', 'same.md'), 'from A\n');
  await sync(a, '/h').sync(false);
  writeFileSync(join(b, 'ks', 'same.md'), 'from B\n');
  writeFileSync(join(b, 'ks', 'MEMORY.md'), '# Memory Index\n- [s](same.md)\n');
  const mb = sync(b, '/h', 'B');
  mb.state.pullWanted = false;
  mb.changed('ks/MEMORY.md', 0);
  await assert.rejects(mb.tick(QUIET_MS), /memory conflict in ks\/same\.md/);
  assert.equal(existsSync(join(b, '.git', 'rebase-merge')), false, 'rebase aborted');
  assert.equal(mb.state.retryAt, QUIET_MS + RETRY_MS);
  assert.notEqual(mb.state.dirtySince, null, 'still wanted');
});
