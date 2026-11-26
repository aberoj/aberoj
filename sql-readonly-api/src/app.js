'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { QueryError, buildListQuery, buildGetQuery } = require('./query');
const { isLanAddress } = require('./lan');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {object} opts
 * @param {object} opts.info      table description from describeTable()
 * @param {Function} opts.run     async ({text, params}) => recordsets
 * @param {object} opts.settings  { apiKey, lanOnly, defaultLimit, maxRows }
 */
function createApp({ info, run, settings }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('json spaces', 0);

  // 1. Only devices on your local network may connect.
  if (settings.lanOnly) {
    app.use((req, res, next) => {
      if (isLanAddress(req.socket.remoteAddress)) return next();
      res.status(403).json({ error: 'Only local network clients are allowed' });
    });
  }

  // 2. Read-only: any method other than GET/HEAD is refused outright.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.set('Allow', 'GET, HEAD').status(405).json({ error: 'This API is read-only' });
  });

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  // The phone-friendly web page (contains no data on its own).
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 3. Optional shared API key for everything under /api (except health).
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  if (settings.apiKey) {
    app.use('/api', (req, res, next) => {
      const given = req.get('x-api-key') || req.query.key || '';
      if (given && safeEqual(given, settings.apiKey)) return next();
      res.status(401).json({ error: 'Missing or wrong API key' });
    });
  }

  app.get('/api/columns', (req, res) => {
    res.json({
      table: `${info.schema}.${info.table}`,
      idColumn: info.idColumn ? info.idColumn.name : null,
      columns: info.visible.map((c) => ({ name: c.name, type: c.dataType })),
    });
  });

  app.get('/api/rows', async (req, res, next) => {
    try {
      const q = buildListQuery(info, req.query, settings);
      const [countSet, rows] = await run(q);
      res.json({
        total: Number(countSet[0].total),
        limit: q.limit,
        offset: q.offset,
        rows,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/rows/:id', async (req, res, next) => {
    try {
      const [rows] = await run(buildGetQuery(info, req.params.id));
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof QueryError) return res.status(400).json({ error: err.message });
    // SQL Server conversion errors (e.g. comparing a date column to "abc")
    if (err && [241, 242, 245, 8114, 8115].includes(err.number)) {
      return res.status(400).json({ error: 'A filter value does not match the column type' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

module.exports = { createApp };
