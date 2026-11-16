// liveRoot finds a KS plugin's current folder from Claude Code's records (see
// lib/ksroot.ts). The board carries a twin (web/lib/ksroot.ts): both must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, liveRoot, projectPathFromEnvFile, type RootContext, type RootFs } from './ksroot.js';
import { liveRoot as boardLiveRoot } from '../../web/lib/ksroot.ts';

const HOME = '/h';
const CLAUDE = '/h/.claude';
const CONFIG = '/h/.config/ks';
const CHECKOUT = '/w/karmasuite';
const CLONE = '/g/ks';
const CACHE = (name: string, v: string) => `${CLAUDE}/plugins/cache/karmasuite/${name}/${v}`;

/** An in-memory fs: files by path; every parent of a file, and each listed dir, is a folder. */
function memFs(files: Record<string, unknown>, dirs: string[] = []): RootFs {
  const text = new Map(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  const folders = new Set(dirs);
  for (const p of [...text.keys(), ...dirs]) {
    let d = p;
    while (d.lastIndexOf('/') > 0) {
      d = d.slice(0, d.lastIndexOf('/'));
      folders.add(d);
    }
  }
  return { read: (p) => text.get(p) ?? null, isDir: (p) => folders.has(p) };
}

const pluginJson = (dir: string, name: string) => ({ [`${dir}/.claude-plugin/plugin.json`]: { name } });
const directoryMarket = { karmasuite: { source: { source: 'directory', path: CLONE }, installLocation: CLONE } };
const githubMarket = {
  karmasuite: { source: { source: 'github', repo: 'x/ks' }, installLocation: `${CLAUDE}/plugins/marketplaces/karmasuite` },
};
const entry = (scope: string, installPath: string, version: string, projectPath?: string, lastUpdated = '2026-11-01') => ({
  scope,
  ...(projectPath ? { projectPath } : {}),
  installPath,
  version,
  lastUpdated,
});
const installed = (plugins: Record<string, unknown[]>) => ({ version: 2, plugins });

interface Case {
  name: string;
  plugin: string;
  files: Record<string, unknown>;
  dirs?: string[];
  ctx?: Partial<RootContext>;
  want: string | null;
}

const base = (files: Record<string, unknown>, dirs: string[] = [], ctx: Partial<RootContext> = {}): RootContext => ({
  home: HOME,
  configDir: CONFIG,
  cwd: '/',
  claudeDir: CLAUDE,
  pluginsDir: null,
  env: {},
  fs: memFs(files, dirs),
  ...ctx,
});

const cases: Case[] = [
  {
    name: 'directory marketplace beats a stale cache entry',
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/known_marketplaces.json`]: directoryMarket,
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@karmasuite': [entry('local', CACHE('ks', '1.0.0'), '1.0.0', CHECKOUT)],
      }),
      ...pluginJson(`${CLONE}/plugins/ks`, 'ks'),
    },
    dirs: [CACHE('ks', '1.0.0')],
    ctx: { cwd: CHECKOUT, projectPath: CHECKOUT },
    want: `${CLONE}/plugins/ks`,
  },
  {
    name: 'KS_ROOT_<NAME> beats everything',
    plugin: 'ks-flow',
    files: {
      [`${CLAUDE}/plugins/known_marketplaces.json`]: directoryMarket,
      ...pluginJson(`${CLONE}/plugins/ks-flow`, 'ks-flow'),
    },
    dirs: ['/override/ks-flow'],
    ctx: { env: { KS_ROOT_KS_FLOW: '/override/ks-flow' } },
    want: '/override/ks-flow',
  },
  {
    name: 'KS_ROOT_<NAME> naming a missing folder is ignored',
    plugin: 'ks',
    files: { [`${CLAUDE}/plugins/known_marketplaces.json`]: directoryMarket, ...pluginJson(`${CLONE}/plugins/ks`, 'ks') },
    ctx: { env: { KS_ROOT_KS: '/gone' } },
    want: `${CLONE}/plugins/ks`,
  },
  {
    name: 'directory marketplace folder whose plugin.json names another plugin falls through',
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/known_marketplaces.json`]: directoryMarket,
      ...pluginJson(`${CLONE}/plugins/ks`, 'not-ks'),
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@karmasuite': [entry('user', CACHE('ks', '1.0.6'), '1.0.6')],
      }),
    },
    dirs: [CACHE('ks', '1.0.6')],
    want: CACHE('ks', '1.0.6'),
  },
  {
    name: "cwd's entry beats the checkout's",
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/known_marketplaces.json`]: githubMarket,
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@karmasuite': [
          entry('local', CACHE('ks', '1.0.7'), '1.0.7', CHECKOUT),
          entry('local', CACHE('ks', '1.0.6'), '1.0.6', '/w/worktrees/kar-1'),
          entry('user', CACHE('ks', '1.0.8'), '1.0.8'),
        ],
      }),
    },
    dirs: [CACHE('ks', '1.0.6'), CACHE('ks', '1.0.7'), CACHE('ks', '1.0.8')],
    ctx: { cwd: '/w/worktrees/kar-1/apps/web', projectPath: CHECKOUT },
    want: CACHE('ks', '1.0.6'),
  },
  {
    name: 'the longest containing projectPath wins',
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@karmasuite': [
          entry('project', CACHE('ks', '1.0.7'), '1.0.7', '/w'),
          entry('local', CACHE('ks', '1.0.6'), '1.0.6', '/w/inner'),
        ],
      }),
    },
    dirs: [CACHE('ks', '1.0.6'), CACHE('ks', '1.0.7')],
    ctx: { cwd: '/w/inner/x' },
    want: CACHE('ks', '1.0.6'),
  },
  {
    name: 'a sibling folder sharing a name prefix does not contain cwd',
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@karmasuite': [
          entry('local', CACHE('ks', '1.0.6'), '1.0.6', '/w/proj'),
          entry('local', CACHE('ks', '1.0.7'), '1.0.7', CHECKOUT),
        ],
      }),
    },
    dirs: [CACHE('ks', '1.0.6'), CACHE('ks', '1.0.7')],
    ctx: { cwd: '/w/proj-2', projectPath: CHECKOUT },
    want: CACHE('ks', '1.0.7'),
  },
  {
    name: "the KS checkout's entry when cwd is in none (daemon)",
    plugin: 'ks-flow',
    files: {
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks-flow@karmasuite': [
          entry('local', CACHE('ks-flow', '0.3.0'), '0.3.0', '/w/worktrees/kar-2'),
          entry('local', CACHE('ks-flow', '0.2.2'), '0.2.2', CHECKOUT),
          entry('user', CACHE('ks-flow', '0.3.1'), '0.3.1'),
        ],
      }),
    },
    dirs: [CACHE('ks-flow', '0.3.0'), CACHE('ks-flow', '0.2.2'), CACHE('ks-flow', '0.3.1')],
    ctx: { projectPath: `${CHECKOUT}/` },
    want: CACHE('ks-flow', '0.2.2'),
  },
  {
    name: "the KS checkout comes from ks.env when not given",
    plugin: 'ks-flow',
    files: {
      [`${CONFIG}/ks.env`]: `# ks\nKS_PROJECT_ROOT_PATH=/old\nKS_PROJECT_ROOT_PATH="${CHECKOUT}"\nKS_DEVICE_ID=abc\n`,
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks-flow@karmasuite': [
          entry('local', CACHE('ks-flow', '0.3.0'), '0.3.0', '/old'),
          entry('local', CACHE('ks-flow', '0.2.2'), '0.2.2', CHECKOUT),
        ],
      }),
    },
    dirs: [CACHE('ks-flow', '0.3.0'), CACHE('ks-flow', '0.2.2')],
    ctx: { projectPath: undefined },
    want: CACHE('ks-flow', '0.2.2'),
  },
  {
    name: 'a user/managed entry when neither cwd nor the checkout has one',
    plugin: 'ks-master',
    files: {
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks-master@karmasuite': [
          entry('local', CACHE('ks-master', '0.9.0'), '0.9.0', '/elsewhere'),
          entry('user', CACHE('ks-master', '0.1.0'), '0.1.0'),
        ],
      }),
    },
    dirs: [CACHE('ks-master', '0.9.0'), CACHE('ks-master', '0.1.0')],
    ctx: { projectPath: CHECKOUT },
    want: CACHE('ks-master', '0.1.0'),
  },
  {
    name: 'else the highest version (numeric, 1.0.10 > 1.0.9)',
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@karmasuite': [
          entry('local', CACHE('ks', '1.0.9'), '1.0.9', '/a'),
          entry('local', CACHE('ks', '1.0.10'), '1.0.10', '/b'),
        ],
      }),
    },
    dirs: [CACHE('ks', '1.0.9'), CACHE('ks', '1.0.10')],
    want: CACHE('ks', '1.0.10'),
  },
  {
    name: "an entry whose installPath is gone is skipped, even cwd's",
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@karmasuite': [
          entry('local', CACHE('ks', '1.0.6'), '1.0.6', CHECKOUT),
          entry('user', CACHE('ks', '1.0.7'), '1.0.7'),
        ],
      }),
    },
    dirs: [CACHE('ks', '1.0.7')],
    ctx: { cwd: CHECKOUT, projectPath: CHECKOUT },
    want: CACHE('ks', '1.0.7'),
  },
  {
    name: 'another marketplace’s entry is not ours',
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/installed_plugins.json`]: installed({
        'ks@elsewhere': [entry('user', '/x/ks', '9.9.9')],
      }),
    },
    dirs: ['/x/ks'],
    want: null,
  },
  {
    name: 'a mode=marketplace registry entry is ignored',
    plugin: 'ks',
    files: { [`${CONFIG}/plugins.json`]: { ks: { root: CACHE('ks', '1.0.0'), mode: 'marketplace' } } },
    dirs: [CACHE('ks', '1.0.0')],
    want: null,
  },
  {
    name: 'a mode=local registry entry is used when nothing is installed',
    plugin: 'ks',
    files: { [`${CONFIG}/plugins.json`]: { ks: { root: '/clone/plugins/ks', mode: 'local' } } },
    dirs: ['/clone/plugins/ks'],
    want: '/clone/plugins/ks',
  },
  {
    name: 'a mode=local registry entry whose folder is gone is skipped',
    plugin: 'ks',
    files: { [`${CONFIG}/plugins.json`]: { ks: { root: '/gone/ks', mode: 'local' } } },
    want: null,
  },
  {
    name: 'the sibling folder last, when its plugin.json names the plugin',
    plugin: 'ks',
    files: { ...pluginJson('/p/plugins/ks', 'ks') },
    ctx: { pluginsDir: '/p/plugins' },
    want: '/p/plugins/ks',
  },
  {
    name: 'a sibling folder naming another plugin is not used',
    plugin: 'ks',
    files: { ...pluginJson('/p/plugins/ks', 'ks-old') },
    ctx: { pluginsDir: '/p/plugins' },
    want: null,
  },
  {
    name: 'malformed files are ignored',
    plugin: 'ks',
    files: {
      [`${CLAUDE}/plugins/known_marketplaces.json`]: '{nope',
      [`${CLAUDE}/plugins/installed_plugins.json`]: '[',
      [`${CONFIG}/plugins.json`]: 'x',
    },
    want: null,
  },
];

for (const c of cases) {
  test(`liveRoot: ${c.name}`, () => {
    const ctx = base(c.files, c.dirs, c.ctx);
    assert.equal(liveRoot(c.plugin, ctx), c.want);
  });
  test(`liveRoot twins agree: ${c.name}`, () => {
    const ctx = base(c.files, c.dirs, c.ctx);
    assert.equal(boardLiveRoot(c.plugin, ctx), liveRoot(c.plugin, ctx));
  });
}

test('liveRoot on a real folder tree (default fs), both twins', () => {
  const root = mkdtempSync(join(tmpdir(), 'ksroot-'));
  try {
    const home = join(root, 'home');
    const clone = join(root, 'clone');
    const write = (p: string, v: unknown) => {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
    };
    write(join(home, '.claude/plugins/known_marketplaces.json'), {
      karmasuite: { source: { source: 'directory', path: clone }, installLocation: clone },
    });
    write(join(clone, 'plugins/ks/.claude-plugin/plugin.json'), { name: 'ks' });
    const stale = join(home, '.claude/plugins/cache/karmasuite/ks-flow/0.1.0');
    mkdirSync(stale, { recursive: true });
    write(join(home, '.claude/plugins/installed_plugins.json'), {
      version: 2,
      plugins: { 'ks-flow@karmasuite': [{ scope: 'user', installPath: stale, version: '0.1.0' }] },
    });
    const ctx: RootContext = { home, configDir: join(home, '.config/ks'), cwd: root };
    assert.equal(liveRoot('ks', ctx), join(clone, 'plugins/ks'));
    // no plugins/ks-flow in the clone → the installed entry
    assert.equal(liveRoot('ks-flow', ctx), stale);
    assert.equal(liveRoot('ks-master', ctx), null);
    for (const n of ['ks', 'ks-flow', 'ks-master']) assert.equal(boardLiveRoot(n, ctx), liveRoot(n, ctx));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('liveRoot matches cwd and the checkout through symlinks (process.cwd() is the real path)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ksroot-')));
  try {
    const home = join(root, 'home');
    const real = join(root, 'real', 'wt');
    const link = join(root, 'link');
    mkdirSync(real, { recursive: true });
    symlinkSync(join(root, 'real'), link);
    const a = join(home, '.claude/plugins/cache/karmasuite/ks/1.0.6');
    const b = join(home, '.claude/plugins/cache/karmasuite/ks/1.0.7');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    mkdirSync(join(home, '.claude/plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'ks@karmasuite': [
            { scope: 'local', projectPath: join(link, 'wt'), installPath: a, version: '1.0.6' },
            { scope: 'user', installPath: b, version: '1.0.7' },
          ],
        },
      }),
    );
    const ctx = (cwd: string, projectPath: string | null = null): RootContext => ({
      home,
      configDir: join(home, '.config/ks'),
      cwd,
      projectPath,
    });
    // entry recorded through the link, cwd as the real path (a Node process)
    assert.equal(liveRoot('ks', ctx(join(real, 'sub'))), a);
    assert.equal(liveRoot('ks', ctx(real)), a);
    // the checkout named through the real path, cwd elsewhere (the daemon)
    assert.equal(liveRoot('ks', ctx('/', `${real}/`)), a);
    assert.equal(liveRoot('ks', ctx('/')), b);
    for (const c of [ctx(real), ctx('/', real), ctx('/')]) assert.equal(boardLiveRoot('ks', c), liveRoot('ks', c));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectPathFromEnvFile: last assignment, quotes, export, ~', () => {
  assert.equal(projectPathFromEnvFile(null, '/h'), null);
  assert.equal(projectPathFromEnvFile('A=1\n', '/h'), null);
  assert.equal(projectPathFromEnvFile("export KS_PROJECT_ROOT_PATH='~/x'\n", '/h'), '/h/x');
  assert.equal(projectPathFromEnvFile('KS_PROJECT_ROOT_PATH = /a\nKS_PROJECT_ROOT_PATH="/b"', '/h'), '/b');
});

test('compareVersions', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.2.2', '0.3.0'), -1);
});
