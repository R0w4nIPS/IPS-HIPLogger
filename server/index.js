const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const PlcPoller = require('./plc');
const SimPoller = require('./simulator');
const TrendBuffer = require('./buffer');
const TrendDB = require('./db');

const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo') || !!config.demo;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Demo mode never touches the real database, so fake samples can't mix
// with production history if this ever runs on the same machine/file.
const db = new TrendDB(
  DEMO ? { ...config, db: { ...config.db, file: 'trend.demo.db' } } : config
);
// Tags with `trend: false` (e.g. the db1001 cycle/status signals) never go
// in the RAM history buffer -- they're only ever shown as a `latest` value
// on the Dashboard, never charted, so there's no history to keep for them.
const trendTagNames = Object.keys(config.tags).filter((name) => config.tags[name].trend !== false);

const buffer = new TrendBuffer(trendTagNames, config.retentionSeconds);
const poller = DEMO ? new SimPoller(config) : new PlcPoller(config);
let plcStatus = 'offline';

if (DEMO) console.log('[demo] simulating tag data — no PLC connection will be made');

// Seed the RAM buffer from SQLite so trends survive a server restart
{
  const now = Date.now();
  const from = now - config.retentionSeconds * 1000;
  let total = 0;
  for (const tag of trendTagNames) {
    const points = db.load(tag, from, now);
    buffer.seed(tag, points);
    total += points.length;
  }
  console.log(`[db] restored ${total} samples into the RAM buffer`);
}

// ---------------------------------------------------------------- WebSocket
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  // Greet the new client with tag metadata + current PLC status
  ws.send(
    JSON.stringify({
      type: 'hello',
      status: plcStatus,
      pollIntervalMs: config.pollIntervalMs,
      tags: Object.fromEntries(
        Object.entries(config.tags).map(([name, def]) => [
          name,
          {
            unit: def.unit,
            decimals: def.decimals,
            color: def.color,
            defaultActive: def.defaultActive !== false,
            trend: def.trend !== false,
            kind: def.kind,
            labels: def.labels,
          },
        ])
      ),
    })
  );
});

// Gate SQLite writes on config.loggingGateTag (if set): the RAM buffer and
// WebSocket broadcast always happen so the real-time trend keeps working
// regardless -- only disk persistence is skipped while the tag reads 0.
let loggingEnabled = !config.loggingGateTag;

poller.on('sample', (sample) => {
  const gateTag = config.loggingGateTag;
  if (gateTag && gateTag in sample.values) {
    const next = sample.values[gateTag] === 1;
    if (next !== loggingEnabled) {
      console.log(`[db] logging ${next ? 'enabled' : 'disabled'} (${gateTag})`);
      if (next) db.startCycle(sample.t);
      else db.endCycle(sample.t);
    }
    loggingEnabled = next;
  }

  buffer.push(sample);
  if (loggingEnabled) {
    // Tags marked `log: false` (e.g. db1001 cycle/status signals) never hit
    // SQLite even while logging is otherwise on.
    const loggableValues = {};
    for (const [name, v] of Object.entries(sample.values)) {
      if (config.tags[name]?.log !== false) loggableValues[name] = v;
    }
    db.push({ t: sample.t, values: loggableValues });
  }
  broadcast({ type: 'sample', t: sample.t, values: sample.values });
});

poller.on('status', (status) => {
  plcStatus = status;
  console.log(`[plc] status: ${status}`);
  broadcast({ type: 'status', status });
});

// --------------------------------------------------------------------- REST
app.get('/api/tags', (_req, res) => {
  res.json(
    Object.fromEntries(
      Object.entries(config.tags).map(([name, def]) => [
        name,
        {
          address: def.address,
          unit: def.unit,
          decimals: def.decimals,
          color: def.color,
          defaultActive: def.defaultActive !== false,
          trend: def.trend !== false,
          kind: def.kind,
          labels: def.labels,
        },
      ])
    )
  );
});

// /api/history?tag=Pressure_bar&window=3600  (seconds back from now)
// or          ?tag=...&from=<ms>&to=<ms>
// Ranges that reach further back than the RAM buffer's retention (e.g. a
// user-picked date/time range) are served from SQLite instead, which keeps
// the full db.retentionDays of history.
app.get('/api/history', (req, res) => {
  const tag = req.query.tag;
  if (!tag) return res.status(400).json({ error: 'tag parameter required' });
  if (!config.tags[tag]) return res.status(404).json({ error: `unknown tag: ${tag}` });

  const now = Date.now();
  const to = req.query.to ? Number(req.query.to) : now;
  const from = req.query.from
    ? Number(req.query.from)
    : now - Number(req.query.window || 3600) * 1000;
  const maxPoints = Math.min(Number(req.query.maxPoints || 2000), 10000);

  const bufferFloor = now - config.retentionSeconds * 1000;
  let points;
  if (from < bufferFloor) {
    db.flush(); // make sure recently queued samples are visible to the read
    points = TrendBuffer.downsample(db.load(tag, from, to), from, to, maxPoints);
  } else {
    points = buffer.query(tag, from, to, maxPoints);
  }
  res.json({ tag, from, to, points });
});

// /api/cycles -- every logged cycle (a LoggingOnOff true..false span), most
// recent first, for the Cycles page. `to: null` means the cycle is still
// running (LoggingOnOff hasn't gone false yet).
// Optional ?from=<ms>&to=<ms> restricts to cycles that *started* in that
// window, for the page's date/time search.
app.get('/api/cycles', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  const from = req.query.from ? Number(req.query.from) : null;
  const to = req.query.to ? Number(req.query.to) : null;
  const rows = db.listCycles(limit, from, to);
  res.json(rows.map((r) => ({ id: r.id, from: r.start_t, to: r.end_t })));
});

// /api/cycles/:id -- a single cycle, for the cycle report page (direct link,
// independent of the list's default 200-row window).
app.get('/api/cycles/:id', (req, res) => {
  const row = db.getCycle(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'cycle not found' });
  res.json({ id: row.id, from: row.start_t, to: row.end_t });
});

app.get('/api/status', (_req, res) => {
  res.json({ plc: plcStatus, clients: wss.clients.size, logging: loggingEnabled });
});

// /api/export.csv?tags=Pressure_bar,Flow_lpm&from=<ms>&to=<ms>
// or             ?tags=...&window=3600 (seconds back from now)
// Exports from SQLite, so the range can go back db.retentionDays.
app.get('/api/export.csv', (req, res) => {
  const requested = (req.query.tags || Object.keys(config.tags).join(',')).split(',');
  const tags = requested.filter((t) => config.tags[t]);
  if (!tags.length) return res.status(400).json({ error: 'no valid tags' });

  const now = Date.now();
  const to = req.query.to ? Number(req.query.to) : now;
  const from = req.query.from
    ? Number(req.query.from)
    : to - Number(req.query.window || 3600) * 1000;

  db.flush(); // make sure queued samples are on disk before querying

  const sep = config.csv.separator;
  const fmtNum = (v, decimals) => {
    if (v == null) return '';
    let s = Number(v).toFixed(decimals ?? 3);
    if (config.csv.decimalComma) s = s.replace('.', ',');
    return s;
  };
  const isoLocal = (t) => {
    const d = new Date(t);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
    );
  };

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="trend_${stamp}.csv"`);

  res.write(['timestamp_ms', 'timestamp', ...tags].join(sep) + '\r\n');
  for (const row of db.exportRows(tags, from, to)) {
    const cells = [row.t, isoLocal(row.t)];
    for (const tag of tags) {
      cells.push(fmtNum(row.values[tag], config.tags[tag].decimals));
    }
    res.write(cells.join(sep) + '\r\n');
  }
  res.end();
});

// Serve the built React app in production (client/dist copied or referenced)
const dist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(dist));

// Client-side routes (e.g. /dashboard): fall back to the SPA shell so a
// direct load or refresh doesn't 404 -- React reads the URL and renders
// the right page. Static files above already took priority.
app.get('*', (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'));
});

// ------------------------------------------------------------------- Launch
server.listen(config.httpPort, () => {
  console.log(`[http] listening on :${config.httpPort}`);
  poller.start();
});

process.on('SIGINT', () => {
  poller.stop();
  db.close(); // flushes any queued samples first
  process.exit(0);
});
