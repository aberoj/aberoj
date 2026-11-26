'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTableName, describeTable, buildListQuery, buildGetQuery, QueryError } = require('../src/query');

const info = describeTable(
  { schema: 'dbo', table: 'Customers' },
  [
    { name: 'Id', dataType: 'int' },
    { name: 'Name', dataType: 'nvarchar' },
    { name: 'City', dataType: 'varchar' },
    { name: 'Balance', dataType: 'money' },
    { name: 'Active', dataType: 'bit' },
    { name: 'Joined', dataType: 'date' },
    { name: 'Photo', dataType: 'varbinary' },
  ],
  'Id'
);

test('parseTableName', () => {
  assert.deepEqual(parseTableName('dbo.Customers'), { schema: 'dbo', table: 'Customers' });
  assert.deepEqual(parseTableName('[sales].[Orders]'), { schema: 'sales', table: 'Orders' });
  assert.deepEqual(parseTableName('Orders'), { schema: 'dbo', table: 'Orders' });
  assert.throws(() => parseTableName('a.b.c'));
});

test('default list query is a paged SELECT ordered by the id', () => {
  const q = buildListQuery(info, {});
  assert.match(q.text, /^SELECT COUNT_BIG\(\*\) AS total FROM \[dbo\]\.\[Customers\];/);
  assert.match(q.text, /SELECT \[Id\], \[Name\], \[City\], \[Balance\], \[Active\], \[Joined\] FROM/);
  assert.doesNotMatch(q.text, /Photo/, 'binary columns are hidden');
  assert.match(q.text, /ORDER BY \[Id\] ASC OFFSET @p1 ROWS FETCH NEXT @p0 ROWS ONLY;$/);
  assert.equal(q.limit, 50);
  assert.equal(q.offset, 0);
});

test('filters become typed parameters, never inline SQL', () => {
  const q = buildListQuery(info, {
    city: "O'Brien'; DROP TABLE x;--",
    'Balance.gte': '10.5',
    'Id.in': '1,2,3',
    'Active': 'true',
    'Name.contains': '50%',
    'Joined.null': 'false',
  });
  assert.doesNotMatch(q.text, /DROP|O'Brien/);
  assert.match(q.text, /\[City\] = @p0/);
  assert.match(q.text, /\[Balance\] >= @p1/);
  assert.match(q.text, /\[Id\] IN \(@p2, @p3, @p4\)/);
  assert.match(q.text, /\[Active\] = @p5/);
  assert.match(q.text, /CAST\(\[Name\] AS NVARCHAR\(MAX\)\) LIKE @p6/);
  assert.match(q.text, /\[Joined\] IS NOT NULL/);
  const values = q.params.map((p) => [p.kind, p.value]);
  assert.deepEqual(values.slice(0, 7), [
    ['string', "O'Brien'; DROP TABLE x;--"],
    ['float', 10.5],
    ['int', 1], ['int', 2], ['int', 3],
    ['bit', true],
    ['string', '%50[%]%'],
  ]);
});

test('search covers text columns only', () => {
  const q = buildListQuery(info, { search: 'ann' });
  assert.match(q.text, /\(\[Name\] LIKE @p0 OR \[City\] LIKE @p0\)/);
  assert.equal(q.params[0].value, '%ann%');
});

test('fields, sort, order and paging', () => {
  const q = buildListQuery(info, { fields: 'name,city', sort: 'city', order: 'DESC', limit: '9999', offset: '20' }, { maxRows: 100 });
  assert.match(q.text, /SELECT \[Name\], \[City\] FROM/);
  assert.match(q.text, /ORDER BY \[City\] DESC/);
  assert.equal(q.limit, 100, 'limit is capped');
  assert.equal(q.offset, 20);
});

test('bad input is rejected with QueryError', () => {
  const bad = [
    { nope: '1' },
    { sort: 'Name; DROP TABLE x' },
    { 'Id': 'abc' },
    { 'Balance.gt': 'lots' },
    { 'Active': 'maybe' },
    { order: 'sideways' },
    { limit: '-1' },
    { fields: 'Photo' },
  ];
  for (const query of bad) {
    assert.throws(() => buildListQuery(info, query), QueryError, JSON.stringify(query));
  }
});

test('get by id', () => {
  const q = buildGetQuery(info, '42');
  assert.match(q.text, /^SELECT TOP \(1\) .* FROM \[dbo\]\.\[Customers\] WHERE \[Id\] = @p0;$/);
  assert.deepEqual(q.params, [{ name: 'p0', kind: 'int', value: 42 }]);
  assert.throws(() => buildGetQuery(info, 'x'), QueryError);
});

test('closing brackets in names are escaped', () => {
  const odd = describeTable({ schema: 'dbo', table: 'a]b' }, [{ name: 'c]d', dataType: 'int' }], null);
  assert.equal(odd.sqlName, '[dbo].[a]]b]');
  assert.match(buildListQuery(odd, {}).text, /SELECT \[c\]\]d\]/);
});
