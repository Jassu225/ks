import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { leftoverRoutes, linkOnline, linkRows, loopbackPort, serveRoutes } from './inbox-check.js';

const STATUS = JSON.stringify({
  TCP: { '8443': { HTTPS: true }, '57113': { HTTPS: true }, '443': { HTTPS: true } },
  Web: {
    'mac.tail0f0f78.ts.net:57113': { Handlers: { '/': { Proxy: 'http://127.0.0.1:57245' } } },
    'mac.tail0f0f78.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:57298' } } },
    'mac.tail0f0f78.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
  },
});

test('serveRoutes: every web route with its target; unreadable output → undefined; none → []', () => {
  assert.deepEqual(serveRoutes(STATUS), [
    { port: 57113, target: 'http://127.0.0.1:57245' },
    { port: 8443, target: 'http://127.0.0.1:57298' },
    { port: 443, target: 'http://127.0.0.1:3000' },
  ]);
  assert.equal(serveRoutes('not json'), undefined);
  assert.deepEqual(serveRoutes(''), []);
  assert.deepEqual(serveRoutes('{}'), []);
});

test('loopbackPort: loopback targets only', () => {
  assert.equal(loopbackPort('http://127.0.0.1:57298'), 57298);
  assert.equal(loopbackPort('http://localhost:80/'), 80);
  assert.equal(loopbackPort('http://10.0.0.5:80'), null);
  assert.equal(loopbackPort('https+insecure://127.0.0.1:5'), null);
});

test('leftoverRoutes: only the Inbox port and door ports, only dead loopback targets', () => {
  const routes = serveRoutes(STATUS)!;
  // 57245 dead, 57298 alive, 3000 dead but not ours.
  const listening = (p: number) => p === 57298;
  assert.deepEqual(leftoverRoutes(routes, 57113, listening), [{ port: 57113, target: 'http://127.0.0.1:57245' }]);
  // Nothing alive: the door's dead mapping is a leftover too; 443 never.
  assert.deepEqual(
    leftoverRoutes(routes, 57113, () => false).map((r) => r.port),
    [57113, 8443],
  );
  // The Inbox's port unknown: only the door ports count.
  assert.deepEqual(
    leftoverRoutes(routes, null, () => false).map((r) => r.port),
    [8443],
  );
});

test('linkRows: names with spaces, states, the self row and a complaint', () => {
  const out = [
    "Jaswanth’s MacBook Pro  ibx_01M7MP60KX4R73MHWFWATYCKZM  this computer  jaswanths-macbook-pro.tail0f0f78.ts.net:8443  Another tailscale serve mapping now uses port 8443",
    "Jassu & Chinnodu's MacBook Pro  ibx_01M7B84E74SFCJWT73KM5CW3J2  online, both ways  jassu--chinnodus-macbook-pro.tail0f0f78.ts.net:8443",
    '',
  ].join('\n');
  const rows = linkRows(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].self, true);
  assert.match(rows[0].note, /Another tailscale serve mapping/);
  assert.equal(rows[1].name, "Jassu & Chinnodu's MacBook Pro");
  assert.equal(rows[1].id, 'ibx_01M7B84E74SFCJWT73KM5CW3J2');
  assert.equal(linkOnline(rows[1]), true);
  assert.equal(rows[1].address, 'jassu--chinnodus-macbook-pro.tail0f0f78.ts.net:8443');
});
