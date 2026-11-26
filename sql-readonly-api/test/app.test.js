'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeTable } = require('../src/query');
const { createApp } = require('../src/app');
const { isLanAddress } = require('../src/lan');

const info = describeTable(
  { schema: 'dbo', table: 'Customers' },
  [
    { name: 'Id', dataType: 'int' },
    { name: 'Name', dataType: 'nvarchar' },
  ],
  'Id'
);

const DATA = [
  { Id: 1, Name: 'Ann' },
  { Id: 2, Name: 'Bob' },
];

const calls = [];
async function fakeRun(q) {
  calls.push(q);
  if (q.text.startsWith('SELECT TOP (1)')) {
    return [DATA.filter((r) => r.Id === q.params[0].value)];
  }
  return [[{ total: String(DATA.length) }], DATA];
}

async function withServer(settings, fn) {
  const app = createApp({ info, run: fakeRun, settings: { defaultLimit: 50, maxRows: 500, ...settings } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('read endpoints', async () => {
  await withServer({ lanOnly: true }, async (base) => {
    let res = await fetch(base + '/api/rows?Name.contains=a');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { total: 2, limit: 50, offset: 0, rows: DATA });

    res = await fetch(base + '/api/rows/2');
    assert.deepEqual(await res.json(), { Id: 2, Name: 'Bob' });

    res = await fetch(base + '/api/rows/99');
    assert.equal(res.status, 404);

    res = await fetch(base + '/api/columns');
    assert.deepEqual(await res.json(), {
      table: 'dbo.Customers',
      idColumn: 'Id',
      columns: [{ name: 'Id', type: 'int' }, { name: 'Name', type: 'nvarchar' }],
    });

    res = await fetch(base + '/api/rows?bogus=1');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown column/);

    res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Table Viewer<\/title>/);
  });
});

test('every write method is refused', async () => {
  const before = calls.length;
  await withServer({ lanOnly: true }, async (base) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(base + '/api/rows/1', { method, body: '{}' });
      assert.equal(res.status, 405, method);
    }
  });
  assert.equal(calls.length, before, 'the database was never called');
});

test('API key', async () => {
  await withServer({ lanOnly: true, apiKey: 's3cret' }, async (base) => {
    assert.equal((await fetch(base + '/api/rows')).status, 401);
    assert.equal((await fetch(base + '/api/rows', { headers: { 'X-API-Key': 'wrong' } })).status, 401);
    assert.equal((await fetch(base + '/api/rows', { headers: { 'X-API-Key': 's3cret' } })).status, 200);
    assert.equal((await fetch(base + '/api/rows?key=s3cret')).status, 200);
    assert.equal((await fetch(base + '/api/health')).status, 200, 'health needs no key');
  });
});

test('LAN address detection', () => {
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.50', '::ffff:192.168.0.9', 'fe80::1', 'fd00::5']) {
    assert.equal(isLanAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2001:4860::8888', '', undefined]) {
    assert.equal(isLanAddress(ip), false, String(ip));
  }
});
