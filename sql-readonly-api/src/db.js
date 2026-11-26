'use strict';

const sql = require('mssql');

const TYPE_MAP = {
  int: sql.BigInt,
  float: sql.Float,
  bit: sql.Bit,
  string: sql.NVarChar(sql.MAX),
};

function buildConfig(env) {
  const config = {
    server: env.DB_SERVER || 'localhost',
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 30000,
    connectionTimeout: 15000,
    options: {
      encrypt: String(env.DB_ENCRYPT).toLowerCase() === 'true',
      // SQL Server Express normally uses a self-signed certificate.
      trustServerCertificate: true,
      // Tell SQL Server this connection only reads.
      readOnlyIntent: true,
      appName: 'sql-readonly-api',
    },
  };
  if (env.DB_PORT) {
    config.port = parseInt(env.DB_PORT, 10);
  } else if (env.DB_INSTANCE) {
    config.options.instanceName = env.DB_INSTANCE;
  }
  for (const key of ['DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
    if (!env[key]) throw new Error(`${key} is not set (see .env.example)`);
  }
  return config;
}

async function connect(env) {
  const pool = new sql.ConnectionPool(buildConfig(env));
  pool.on('error', (err) => console.error('SQL pool error:', err.message));
  await pool.connect();
  return pool;
}

async function loadColumns(pool, { schema, table }) {
  const result = await pool
    .request()
    .input('schema', sql.NVarChar(128), schema)
    .input('table', sql.NVarChar(128), table)
    .query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
        ORDER BY ORDINAL_POSITION`
    );
  return result.recordset;
}

async function loadPrimaryKey(pool, { schema, table }) {
  const result = await pool
    .request()
    .input('schema', sql.NVarChar(128), schema)
    .input('table', sql.NVarChar(128), table)
    .query(
      `SELECT k.COLUMN_NAME AS name
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA
          AND k.TABLE_NAME = tc.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
        ORDER BY k.ORDINAL_POSITION`
    );
  return result.recordset.length === 1 ? result.recordset[0].name : null;
}

/** Returns a function that runs a built query and returns its recordsets. */
function makeRunner(pool) {
  return async function run({ text, params }) {
    const request = pool.request();
    for (const p of params) request.input(p.name, TYPE_MAP[p.kind], p.value);
    const result = await request.query(text);
    return result.recordsets;
  };
}

module.exports = { connect, loadColumns, loadPrimaryKey, makeRunner, buildConfig };
