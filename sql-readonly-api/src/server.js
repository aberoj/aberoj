'use strict';

const os = require('node:os');
const path = require('node:path');
const { parseTableName, describeTable } = require('./query');
const db = require('./db');
const { createApp } = require('./app');

// Load .env from the project folder (Node 20.12+ built-in, no extra package).
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.warn('No .env file found; using environment variables only.');
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function main() {
  const env = process.env;
  const tableName = parseTableName(env.DB_TABLE);

  const pool = await db.connect(env);
  const columns = await db.loadColumns(pool, tableName);
  const idColumn = env.ID_COLUMN || (await db.loadPrimaryKey(pool, tableName));
  const info = describeTable(tableName, columns, idColumn);

  const settings = {
    apiKey: env.API_KEY || '',
    lanOnly: String(env.LAN_ONLY || 'true').toLowerCase() !== 'false',
    defaultLimit: parseInt(env.DEFAULT_LIMIT || '50', 10),
    maxRows: parseInt(env.MAX_ROWS || '500', 10),
  };

  const app = createApp({ info, run: db.makeRunner(pool), settings });
  const port = parseInt(env.PORT || '8080', 10);
  const host = env.HOST || '0.0.0.0';

  const server = app.listen(port, host, () => {
    console.log(`Serving ${info.schema}.${info.table} (${info.visible.length} columns, read-only)`);
    if (!settings.apiKey) console.warn('WARNING: API_KEY is empty, so anyone on your network can read this table.');
    console.log('Open on your phone:');
    for (const ip of lanAddresses()) console.log(`  http://${ip}:${port}/`);
  });

  const shutdown = () => {
    server.close(() => pool.close().finally(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
