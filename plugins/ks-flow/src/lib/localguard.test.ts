// Tests for the board's local-only guard (web/lib/localguard.ts, used by web/proxy.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostName, refuseReason, type GuardRequest } from '../../web/lib/localguard.ts';

const req = (r: Partial<GuardRequest>): GuardRequest => ({
  method: 'GET',
  pathname: '/',
  host: 'localhost:4317',
  origin: null,
  secFetchSite: null,
  ...r,
});

test('hostName strips the port, keeps IPv6 brackets', () => {
  assert.equal(hostName('localhost:4317'), 'localhost');
  assert.equal(hostName('127.0.0.1'), '127.0.0.1');
  assert.equal(hostName('[::1]:4317'), '[::1]');
  assert.equal(hostName('LocalHost:4317'), 'localhost');
});

test('the board itself passes: pages, reads and writes from its own origin', () => {
  for (const host of ['localhost:4317', '127.0.0.1:4317', '[::1]:4317']) {
    assert.equal(refuseReason(req({ host })), null);
    assert.equal(refuseReason(req({ host, pathname: '/api/store/live', origin: `http://${host}` })), null);
    assert.equal(refuseReason(req({ host, method: 'POST', pathname: '/api/kill', origin: `http://${host}`, secFetchSite: 'same-origin' })), null);
  }
});

test('a re-pointed domain (DNS rebinding) is refused, even same-origin', () => {
  assert.match(refuseReason(req({ host: 'evil.example:4317' })) ?? '', /host not allowed/);
  assert.match(refuseReason(req({ host: 'evil.example:4317', method: 'POST', pathname: '/api/kill', origin: 'http://evil.example:4317' })) ?? '', /host not allowed/);
  assert.match(refuseReason(req({ host: 'localhost.evil.example' })) ?? '', /host not allowed/);
  assert.match(refuseReason(req({ host: null })) ?? '', /host not allowed/);
  assert.match(refuseReason(req({ host: '192.168.1.20:4317' })) ?? '', /host not allowed/);
});

test('another site, or another localhost port, cannot write or call the API', () => {
  for (const origin of ['https://evil.example', 'http://localhost:3000', 'null', 'http://127.0.0.1:4317']) {
    assert.match(refuseReason(req({ method: 'POST', pathname: '/api/run-command', origin })) ?? '', /cross-origin/, origin);
    assert.match(refuseReason(req({ pathname: '/api/settings', origin })) ?? '', /cross-origin/, origin);
  }
  assert.match(refuseReason(req({ method: 'DELETE', pathname: '/api/notes', secFetchSite: 'cross-site' })) ?? '', /cross-site/);
  assert.match(refuseReason(req({ method: 'POST', pathname: '/settings', secFetchSite: 'same-site' })) ?? '', /cross-site/);
});

test('a link from elsewhere still opens a page; local tools without Origin pass', () => {
  assert.equal(refuseReason(req({ pathname: '/briefing', secFetchSite: 'cross-site' })), null);
  assert.equal(refuseReason(req({ method: 'POST', pathname: '/api/kill' })), null, 'curl on this Mac');
  assert.equal(refuseReason(req({ method: 'POST', pathname: '/api/kill', secFetchSite: 'none' })), null);
});
