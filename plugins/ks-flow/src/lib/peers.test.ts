// Tests for lib/peers.ts (`ks-flow peers`): what a device publishes, the rows, the tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PeerSession } from './db/types.js';
import type { LiveProcess } from './claude-sessions.js';
import { formatPeers, formatPeersMarkdown, peerRows, peerSessions, peerSessionsSig, type PeerSource } from './peers.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const proc = (p: Partial<LiveProcess> & { pid: number; cwd: string }): LiveProcess => ({
  sessionId: `sid-${p.pid}`,
  procStart: 'x',
  startedAt: ago(3600_000),
  tmuxPane: null,
  name: null,
  bridgeSessionId: null,
  status: null,
  statusAt: null,
  ...p,
});
const sess = (p: Partial<PeerSession> & { sessionId: string }): PeerSession => ({
  name: null,
  bridgeSessionId: null,
  pid: 1,
  unitId: null,
  title: null,
  folder: 'f',
  tmuxPane: null,
  startedAt: ago(60_000),
  status: null,
  statusAt: null,
  waiting: null,
  ...p,
});

test('peerSessions: card by folder (deepest worktree wins), title, waiting, folder name only, oldest first', () => {
  const cards = [
    { unitId: 'karmasuite', title: 'KarmaSuite', worktreeDir: '/k' },
    { unitId: 'KAR-1', title: 'Fix export', worktreeDir: '/k/wt/KAR-1' },
  ];
  const out = peerSessions(
    [
      proc({ pid: 2, cwd: '/k/wt/KAR-1/src', startedAt: ago(60_000), name: ' A:KAR-1 ', bridgeSessionId: 'session_x', status: 'busy', tmuxPane: '%3' }),
      proc({ pid: 1, cwd: '/Users/me/git/ks', startedAt: ago(7200_000), name: 'ks-91', status: 'idle' }),
    ],
    cards,
    (id) => (id === 'sid-2' ? { waitingTool: 'AskUserQuestion', waitingSince: ago(30_000) } : { waitingTool: null, waitingSince: null }),
  );
  assert.deepEqual(out.map((s) => s.pid), [1, 2], 'oldest first');
  assert.deepEqual(out[1], {
    name: 'A:KAR-1',
    sessionId: 'sid-2',
    bridgeSessionId: 'session_x',
    pid: 2,
    unitId: 'KAR-1',
    title: 'Fix export',
    folder: 'src',
    tmuxPane: '%3',
    startedAt: ago(60_000),
    status: 'busy',
    statusAt: null,
    waiting: { tool: 'AskUserQuestion', since: ago(30_000) },
  });
  assert.equal(out[0].unitId, null, 'off any card');
  assert.equal(out[0].folder, 'ks');
  assert.equal(out[0].waiting, null);
  assert.notEqual(peerSessionsSig(out), peerSessionsSig([out[0]]));
  assert.equal(peerSessionsSig(undefined), peerSessionsSig([]));
});

test('peerRows: this device first; state, address, you; a device with none still shows; forgotten left out', () => {
  const devices: PeerSource[] = [
    { deviceId: 'b', label: 'B', name: 'Mini', lastSeenAt: ago(30_000), sessions: [sess({ sessionId: 's3', name: 'B:KAR-2', status: 'idle' })] },
    {
      deviceId: 'a',
      label: 'A',
      defaultName: 'MacBook',
      lastSeenAt: ago(10_000),
      sessions: [
        sess({ sessionId: 's1', pid: 11, name: 'A:KAR-1', bridgeSessionId: 'session_1', status: 'busy' }),
        sess({ sessionId: 's2', pid: 12, name: 'ks-91', status: 'idle', waiting: { tool: 'ExitPlanMode', since: ago(5000) } }),
        sess({ sessionId: 's4', pid: 13, name: null }),
      ],
    },
    { deviceId: 'c', label: 'C', name: 'Old', lastSeenAt: ago(2 * 3600_000), sessions: [sess({ sessionId: 's5', status: 'busy' })] },
    { deviceId: 'd', label: 'D', name: 'Empty', lastSeenAt: ago(1000) },
    { deviceId: 'e', label: 'E', name: 'Gone', lastSeenAt: ago(1000), forgotten: true, sessions: [sess({ sessionId: 's6' })] },
  ];
  const rows = peerRows(devices, 'a', NOW, 12);
  assert.deepEqual(
    rows.map((r) => [r.device.deviceId, r.session?.sessionId ?? null, r.state, r.address, r.you]),
    [
      ['a', 's1', 'working', 'bridge:session_1', false],
      ['a', 's2', 'waiting on you', 'ks-91', true],
      ['a', 's4', 'running', null, false],
      ['b', 's3', 'idle', null, false],
      ['c', 's5', 'last seen 2h ago', null, false],
      ['d', null, 'no sessions', null, false],
    ],
  );
  assert.equal(rows[0].device.name, 'MacBook', 'default name without a user name');
  assert.equal(rows[0].device.self, true);
  assert.equal(rows[4].device.stale, true);
});

test('formatPeersMarkdown: one table, device named once per group, addresses in code', () => {
  const rows = peerRows(
    [
      {
        deviceId: 'a',
        label: 'A',
        name: 'MacBook',
        lastSeenAt: ago(1000),
        sessions: [
          sess({ sessionId: 's1', name: 'A:KAR-1', unitId: 'KAR-1', title: 'Fix | export', bridgeSessionId: 'session_1', status: 'busy', tmuxPane: '%3' }),
          sess({ sessionId: 's2', name: 'ks-master', status: 'idle' }),
        ],
      },
      { deviceId: 'b', label: 'B', name: 'Mini', lastSeenAt: ago(1000), sessions: [sess({ sessionId: 's3', name: 'B:KAR-2', folder: 'KAR-2' })] },
    ],
    'a',
    NOW,
  );
  const lines = formatPeersMarkdown(rows, NOW).split('\n');
  assert.equal(lines[0], '| Device | Peer | Ticket | Title | State | Address | Pane | Started |');
  assert.equal(lines[2], '| A · MacBook (this Mac) | `A:KAR-1` | KAR-1 | Fix \\| export | working | `bridge:session_1` | %3 | 1m ago |');
  assert.equal(lines[3], '|  | `ks-master` | — | master session | idle | `ks-master` | — | 1m ago |');
  assert.equal(lines[4], '| B · Mini | `B:KAR-2` | — | folder KAR-2 | running | — (no Remote Control) | — | 1m ago |');
  assert.equal(formatPeersMarkdown([], NOW), 'No device on the board yet.');
});

test('formatPeers: aligned text; "as of" only from the cache', () => {
  const rows = peerRows([{ deviceId: 'a', label: 'A', name: 'Mac', lastSeenAt: ago(1000), sessions: [sess({ sessionId: 's1', name: 'A:KAR-1' })] }], 'a', NOW);
  const lines = formatPeers(rows, NOW).split('\n');
  assert.match(lines[0], /^DEVICE\s+PEER\s+TICKET\s+TITLE\s+STATE\s+ADDRESS\s+PANE\s+STARTED$/);
  assert.equal(lines[1].indexOf('A:KAR-1'), lines[0].indexOf('PEER'));
  assert.doesNotMatch(formatPeers(rows, NOW), /as of/);
  assert.match(formatPeers(rows, NOW, ago(120_000)), /as of 2m ago/);
});
