'use strict';

/**
 * Builds parameterized, read-only SELECT statements for a single table.
 *
 * Safety rules:
 *  - The only statement ever generated is SELECT.
 *  - Column and table names are never taken from the request as-is: they are
 *    matched against the column list read from the database at startup and
 *    then bracket-quoted.
 *  - Every user-supplied value is sent as a typed parameter, never
 *    concatenated into SQL text.
 */

class QueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Query-string names that are not column filters.
const RESERVED = new Set(['limit', 'offset', 'sort', 'order', 'search', 'fields', 'key']);

const OPERATORS = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  contains: 'LIKE',
  startswith: 'LIKE',
  in: 'IN',
  null: 'IS NULL',
};

// SQL Server types that do not serialize sensibly to JSON; hidden from output.
const HIDDEN_TYPES = new Set([
  'binary', 'varbinary', 'image', 'timestamp', 'rowversion',
  'geography', 'geometry', 'hierarchyid', 'sql_variant',
]);

const INT_TYPES = new Set(['bigint', 'int', 'smallint', 'tinyint']);
const FLOAT_TYPES = new Set(['decimal', 'numeric', 'float', 'real', 'money', 'smallmoney']);
const TEXT_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext']);

/** Maps a SQL Server data type to the parameter kind used for binding. */
function kindOf(dataType) {
  const t = String(dataType).toLowerCase();
  if (INT_TYPES.has(t)) return 'int';
  if (FLOAT_TYPES.has(t)) return 'float';
  if (t === 'bit') return 'bit';
  return 'string';
}

function quoteIdent(name) {
  return '[' + String(name).replace(/]/g, ']]') + ']';
}

/** "dbo.Customers" -> "[dbo].[Customers]" (defaults schema to dbo). */
function parseTableName(fullName) {
  const parts = String(fullName || '').split('.').map((p) => p.trim().replace(/^\[|\]$/g, ''));
  if (parts.length === 1 && parts[0]) return { schema: 'dbo', table: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1]) return { schema: parts[0], table: parts[1] };
  throw new Error(`DB_TABLE must look like "schema.table", got "${fullName}"`);
}

function escapeLike(value) {
  return value.replace(/[\[\]%_]/g, (ch) => '[' + ch + ']');
}

function convertValue(raw, column) {
  const value = String(raw);
  switch (column.kind) {
    case 'int':
      if (!/^-?\d+$/.test(value.trim())) {
        throw new QueryError(`"${column.name}" expects a whole number, got "${value}"`);
      }
      // Bound as BIGINT; very large values stay strings to avoid precision loss.
      return Number.isSafeInteger(Number(value)) ? Number(value) : value.trim();
    case 'float': {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) {
        throw new QueryError(`"${column.name}" expects a number, got "${value}"`);
      }
      return n;
    }
    case 'bit': {
      const v = value.trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return true;
      if (['0', 'false', 'no'].includes(v)) return false;
      throw new QueryError(`"${column.name}" expects true/false, got "${value}"`);
    }
    default:
      return value;
  }
}

/**
 * Describes the table once, from INFORMATION_SCHEMA rows.
 * @param {{schema:string, table:string}} name
 * @param {{name:string, dataType:string}[]} rawColumns
 * @param {string|null} idColumn
 */
function describeTable(name, rawColumns, idColumn) {
  if (!rawColumns.length) {
    throw new Error(`Table ${name.schema}.${name.table} not found, or the login cannot see it`);
  }
  const columns = rawColumns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    kind: kindOf(c.dataType),
    hidden: HIDDEN_TYPES.has(String(c.dataType).toLowerCase()),
    text: TEXT_TYPES.has(String(c.dataType).toLowerCase()),
  }));
  const byLower = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  let id = null;
  if (idColumn) {
    id = byLower.get(idColumn.toLowerCase());
    if (!id) throw new Error(`ID_COLUMN "${idColumn}" is not a column of ${name.schema}.${name.table}`);
  }
  const visible = columns.filter((c) => !c.hidden);
  return {
    schema: name.schema,
    table: name.table,
    sqlName: quoteIdent(name.schema) + '.' + quoteIdent(name.table),
    columns,
    visible,
    byLower,
    idColumn: id,
    defaultSort: id || visible[0],
  };
}

function lookupColumn(info, name) {
  const col = info.byLower.get(String(name).toLowerCase());
  if (!col || col.hidden) throw new QueryError(`Unknown column "${name}"`);
  return col;
}

function toInt(raw, fallback, { min, max, label }) {
  if (raw === undefined || raw === '') return fallback;
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(String(s))) throw new QueryError(`"${label}" must be a whole number`);
  return Math.min(Math.max(parseInt(s, 10), min), max);
}

/**
 * Builds the SELECT for /api/rows.
 * @returns {{ text: string, params: {name:string, kind:string, value:any}[], limit:number, offset:number }}
 */
function buildListQuery(info, query, { defaultLimit = 50, maxRows = 500 } = {}) {
  const params = [];
  const where = [];
  const addParam = (kind, value) => {
    const name = 'p' + params.length;
    params.push({ name, kind, value });
    return '@' + name;
  };

  // Column selection
  let selected = info.visible;
  if (query.fields) {
    const names = String(query.fields).split(',').map((s) => s.trim()).filter(Boolean);
    selected = [...new Set(names.map((n) => lookupColumn(info, n)))];
    if (!selected.length) throw new QueryError('"fields" is empty');
  }

  // Free-text search over all text columns
  if (query.search !== undefined && String(query.search) !== '') {
    const textCols = info.visible.filter((c) => c.text);
    if (!textCols.length) throw new QueryError('This table has no text columns to search');
    const p = addParam('string', '%' + escapeLike(String(query.search)) + '%');
    where.push('(' + textCols.map((c) => `${quoteIdent(c.name)} LIKE ${p}`).join(' OR ') + ')');
  }

  // Column filters: Column=value or Column.op=value
  for (const [key, rawValue] of Object.entries(query)) {
    if (RESERVED.has(key.toLowerCase())) continue;
    const dot = key.lastIndexOf('.');
    let colName = key;
    let op = 'eq';
    if (dot > 0 && OPERATORS[key.slice(dot + 1).toLowerCase()]) {
      colName = key.slice(0, dot);
      op = key.slice(dot + 1).toLowerCase();
    }
    const col = lookupColumn(info, colName);
    const ident = quoteIdent(col.name);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const value of values) {
      if (op === 'null') {
        const v = String(value).toLowerCase();
        if (!['true', 'false', '1', '0'].includes(v)) throw new QueryError(`"${key}" expects true or false`);
        where.push(`${ident} IS ${v === 'true' || v === '1' ? '' : 'NOT '}NULL`);
      } else if (op === 'in') {
        const items = String(value).split(',');
        if (items.length > 100) throw new QueryError(`"${key}" accepts at most 100 values`);
        const ps = items.map((item) => addParam(col.kind, convertValue(item, col)));
        where.push(`${ident} IN (${ps.join(', ')})`);
      } else if (op === 'contains' || op === 'startswith') {
        const pattern = (op === 'contains' ? '%' : '') + escapeLike(String(value)) + '%';
        where.push(`CAST(${ident} AS NVARCHAR(MAX)) LIKE ${addParam('string', pattern)}`);
      } else {
        where.push(`${ident} ${OPERATORS[op]} ${addParam(col.kind, convertValue(value, col))}`);
      }
    }
  }

  // Sorting
  const sortCol = query.sort ? lookupColumn(info, query.sort) : info.defaultSort;
  const orderRaw = String(query.order || 'asc').toLowerCase();
  if (orderRaw !== 'asc' && orderRaw !== 'desc') throw new QueryError('"order" must be asc or desc');

  // Paging
  const limit = toInt(query.limit, defaultLimit, { min: 1, max: maxRows, label: 'limit' });
  const offset = toInt(query.offset, 0, { min: 0, max: Number.MAX_SAFE_INTEGER, label: 'offset' });
  const pLimit = addParam('int', limit);
  const pOffset = addParam('int', offset);

  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const cols = selected.map((c) => quoteIdent(c.name)).join(', ');
  const text =
    `SELECT COUNT_BIG(*) AS total FROM ${info.sqlName}${whereSql};\n` +
    `SELECT ${cols} FROM ${info.sqlName}${whereSql}` +
    ` ORDER BY ${quoteIdent(sortCol.name)} ${orderRaw.toUpperCase()}` +
    ` OFFSET ${pOffset} ROWS FETCH NEXT ${pLimit} ROWS ONLY;`;

  return { text, params, limit, offset };
}

/** Builds the SELECT for /api/rows/:id. */
function buildGetQuery(info, id) {
  if (!info.idColumn) {
    throw new QueryError('No ID column: the table has no primary key, so set ID_COLUMN in .env');
  }
  const col = info.idColumn;
  const cols = info.visible.map((c) => quoteIdent(c.name)).join(', ');
  return {
    text: `SELECT TOP (1) ${cols} FROM ${info.sqlName} WHERE ${quoteIdent(col.name)} = @p0;`,
    params: [{ name: 'p0', kind: col.kind, value: convertValue(id, col) }],
  };
}

module.exports = {
  QueryError,
  parseTableName,
  describeTable,
  buildListQuery,
  buildGetQuery,
  quoteIdent,
  escapeLike,
};
