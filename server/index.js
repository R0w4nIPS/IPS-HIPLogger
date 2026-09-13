const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const PlcPoller = require('./plc');
const SimPoller = require('./simulator');
const ReplayPoller = require('./replay');
const TrendBuffer = require('./buffer');
const TrendDB = require('./db');

const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo') || !!config.demo;
const REPLAY = process.env.REPLAY === '1' || process.argv.includes('--replay') || !!config.replay?.enabled;

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Demo/replay modes never touch the real database, so fake/replayed samples
// can't mix with production history if this ever runs on the same
// machine/file. (Replay reads the real trend.db separately, read-only, in
// replay.js -- this only controls where its output gets written.)
const db = new TrendDB(
  (DEMO || REPLAY) ? { ...config, db: { ...config.db, file: 'trend.demo.db' } } : config
);
// Tags with `trend: false` (e.g. the db1001 cycle/status signals) never go
// in the RAM history buffer -- they're only ever shown as a `latest` value
// on the Dashboard, never charted, so there's no history to keep for them.
const trendTagNames = Object.keys(config.tags).filter((name) => config.tags[name].trend !== false);

const buffer = new TrendBuffer(trendTagNames, config.retentionSeconds);
const poller = REPLAY ? new ReplayPoller(config) : DEMO ? new SimPoller(config) : new PlcPoller(config);
let plcStatus = 'offline';

if (REPLAY) {
  console.log(
    `[replay] looping recorded cycle ${new Date(config.replay.from).toISOString()} -> ` +
      `${new Date(config.replay.to).toISOString()} — no PLC connection will be made`
  );
} else if (DEMO) {
  console.log('[demo] simulating tag data — no PLC connection will be made');
}

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
// Starts out `null` (unknown) rather than assuming off when a gate tag is
// configured -- see the first-sample handling below, which reconciles that
// against any cycle a previous run left open before adopting a value.
let loggingEnabled = config.loggingGateTag ? null : true;

// Last sample time actually written to SQLite, per tag -- used to thin out
// disk writes for tags with `logIntervalSec` set (see config.js). Reset
// whenever a cycle starts so the first sample of each cycle always lands,
// rather than possibly being skipped because of a stale timestamp from the
// previous cycle.
const lastLoggedAt = {};

poller.on('sample', (sample) => {
  const gateTag = config.loggingGateTag;
  if (gateTag && gateTag in sample.values) {
    const next = sample.values[gateTag] === 1;
    if (loggingEnabled === null) {
      // First real read of the gate tag since this process started. Don't
      // treat "on" here as a false->true edge (that would split a cycle a
      // previous run left open into two rows every time the server
      // restarts mid-cycle, whether from a crash or a deliberate restart)
      // -- instead reconcile it against the DB directly: an open cycle
      // stays open if the tag still reads on, and only gets closed if it
      // now reads off (meaning it genuinely ended while this process was
      // down). See db.js#reconcileOpenCycle.
      db.reconcileOpenCycle(next, sample.t);
    } else if (next !== loggingEnabled) {
      console.log(`[db] logging ${next ? 'enabled' : 'disabled'} (${gateTag})`);
      if (next) {
        db.startCycle(sample.t);
        for (const name of Object.keys(lastLoggedAt)) delete lastLoggedAt[name];
      } else {
        db.endCycle(sample.t);
      }
    }
    loggingEnabled = next;
  }

  buffer.push(sample);
  if (loggingEnabled) {
    // Tags marked `log: false` (e.g. db1001 cycle/status signals) never hit
    // SQLite even while logging is otherwise on. Tags with `logIntervalSec`
    // set are thinned to that cadence instead of every poll tick.
    const loggableValues = {};
    for (const [name, v] of Object.entries(sample.values)) {
      const def = config.tags[name];
      if (def?.log === false) continue;
      const intervalMs = (def?.logIntervalSec || 0) * 1000;
      if (intervalMs > 0 && lastLoggedAt[name] !== undefined && sample.t - lastLoggedAt[name] < intervalMs) {
        continue;
      }
      lastLoggedAt[name] = sample.t;
      loggableValues[name] = v;
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

// Shared shape for a cycle row across the list/get/patch endpoints below.
function serializeCycle(r) {
  return {
    id: r.id,
    from: r.start_t,
    to: r.end_t,
    name: r.name,
    batchCode: r.batch_code,
    operator: r.operator,
  };
}

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
  res.json(rows.map(serializeCycle));
});

// /api/cycles/:id -- a single cycle, for the cycle report page (direct link,
// independent of the list's default 200-row window).
app.get('/api/cycles/:id', (req, res) => {
  const row = db.getCycle(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'cycle not found' });
  res.json(serializeCycle(row));
});

// /api/cycles/:id -- update a cycle's traceability fields (name/batch
// code/operator), edited inline on the Cycles page. Always sends the row's
// full desired metadata, not a partial patch, so this stays a plain UPDATE.
app.patch('/api/cycles/:id', (req, res) => {
  const row = db.getCycle(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'cycle not found' });
  const { name, batchCode, operator } = req.body || {};
  db.updateCycleMeta(row.id, { name, batchCode, operator });
  res.json(serializeCycle(db.getCycle(row.id)));
});

// /api/cycles/:id -- delete a cycle's record from the Cycles page. Only
// removes the cycle row itself; its logged samples stay in trend.db.
app.delete('/api/cycles/:id', (req, res) => {
  const row = db.getCycle(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'cycle not found' });
  db.deleteCycle(row.id);
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  res.json({ plc: plcStatus, clients: wss.clients.size, logging: loggingEnabled });
});

function validatePlcSettings(body) {
  const { host, port, rack, slot, timeout } = body || {};
  if (typeof host !== 'string' || !host.trim()) return { error: 'host is required' };
  const nums = { port: Number(port), rack: Number(rack), slot: Number(slot), timeout: Number(timeout) };
  for (const [key, value] of Object.entries(nums)) {
    if (!Number.isFinite(value) || value < 0) return { error: `invalid ${key}` };
  }
  return { value: { host: host.trim(), ...nums } };
}

// /api/settings/plc -- current PLC connection settings for the Settings
// page, plus which poller is actually running (DEMO/REPLAY don't use these
// at all, so the page can say so instead of implying a save takes effect).
app.get('/api/settings/plc', (_req, res) => {
  res.json({ plc: config.plc, mode: REPLAY ? 'replay' : DEMO ? 'demo' : 'live' });
});

// Persists to settings.json (see config.js) and updates the in-memory
// config.plc in place -- PlcPoller reads config.plc fresh on every
// (re)connect attempt, so mutating the same object it already holds a
// reference to is enough; no need to reconstruct it.
app.put('/api/settings/plc', (req, res) => {
  const { error, value } = validatePlcSettings(req.body);
  if (error) return res.status(400).json({ error });

  Object.assign(config.plc, value);
  try {
    fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify({ plc: value }, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `failed to save settings.json: ${err.message}` });
  }

  // Apply immediately if a real PLC connection is what's actually running.
  if (!DEMO && !REPLAY) {
    poller.stop();
    poller.start();
  }
  res.json({ plc: config.plc });
});

// /api/settings/plc/test -- one-shot connect/disconnect against whatever
// the form currently holds (not necessarily saved yet), for the "Test
// Connection" button.
app.post('/api/settings/plc/test', async (req, res) => {
  const { error, value } = validatePlcSettings(req.body);
  if (error) return res.status(400).json({ ok: false, error });
  res.json(await PlcPoller.testConnection(value));
});

// Only the analog/sensor tags (trend !== false) are managed by the Settings
// page's tag editor -- the db1001 cycle/status signals (Mode, CycleStatus,
// AlarmActive, ...) carry a per-value `labels` map each, which is a
// different, more specialized UI than a flat name/address/unit table.
const TAG_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isEditableTag = (def) => def.trend !== false;

function serializeTagRow(name, def) {
  return {
    name,
    address: def.address,
    unit: def.unit || '',
    decimals: def.decimals ?? 1,
    color: def.color || '#666666',
    defaultActive: def.defaultActive !== false,
    logIntervalSec: def.logIntervalSec || 0,
  };
}

function validateTagsPayload(body, preservedNames) {
  const rows = body?.tags;
  if (!Array.isArray(rows) || !rows.length) return { error: 'tags must be a non-empty array' };

  const seen = new Set();
  const clean = [];
  for (const row of rows) {
    const name = String(row.name || '').trim();
    const address = String(row.address || '').trim();
    if (!TAG_NAME_RE.test(name)) {
      return { error: `"${name}" isn't a valid tag name (letters, digits, underscore; can't start with a digit)` };
    }
    if (seen.has(name)) return { error: `duplicate tag name: ${name}` };
    if (preservedNames.has(name)) return { error: `"${name}" is a reserved cycle/status tag name` };
    seen.add(name);
    if (!address) return { error: `${name}: address is required` };
    const decimals = Number(row.decimals);
    const logIntervalSec = Number(row.logIntervalSec);
    if (!Number.isFinite(logIntervalSec) || logIntervalSec < 0) {
      return { error: `${name}: log interval must be a non-negative number of seconds` };
    }
    clean.push({
      name,
      originalName: row.originalName ? String(row.originalName).trim() : null,
      address,
      unit: String(row.unit || ''),
      decimals: Number.isFinite(decimals) ? decimals : 1,
      color: String(row.color || '#666666'),
      defaultActive: row.defaultActive !== false,
      logIntervalSec,
    });
  }
  return { value: clean };
}

// /api/settings/tags -- the editable analog/sensor tag list, as an array
// (rather than the name-keyed object used internally) so the client can
// track each row's original name across an edit for rename detection.
app.get('/api/settings/tags', (_req, res) => {
  const tags = Object.entries(config.tags)
    .filter(([, def]) => isEditableTag(def))
    .map(([name, def]) => serializeTagRow(name, def));
  res.json({ tags });
});

// Persists to tags.json (see config.js) and updates the in-memory
// config.tags in place. Unlike PLC settings, this never applies live -- the
// active poller, the RAM trend buffer, and the WebSocket 'hello' schema are
// all built once from config.tags at startup, so a tag rename/add/remove
// always needs a restart to actually take effect.
app.put('/api/settings/tags', (req, res) => {
  const preserved = Object.fromEntries(Object.entries(config.tags).filter(([, def]) => !isEditableTag(def)));
  const { error, value } = validateTagsPayload(req.body, new Set(Object.keys(preserved)));
  if (error) return res.status(400).json({ error });

  // Carry historical samples over to a tag's new name so existing
  // trend/CSV/report history stays reachable, instead of getting silently
  // orphaned under the name it used to be logged as.
  for (const row of value) {
    if (row.originalName && row.originalName !== row.name && config.tags[row.originalName]) {
      TrendDB.renameTagInFile('trend.db', row.originalName, row.name);
    }
  }

  const nextTags = { ...preserved };
  for (const row of value) {
    nextTags[row.name] = {
      address: row.address,
      unit: row.unit || undefined,
      decimals: row.decimals,
      color: row.color,
      defaultActive: row.defaultActive,
      logIntervalSec: row.logIntervalSec || undefined,
    };
  }

  config.tags = nextTags;
  try {
    fs.writeFileSync(path.join(__dirname, 'tags.json'), JSON.stringify(nextTags, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `failed to save tags.json: ${err.message}` });
  }

  res.json({ tags: value, restartRequired: true });
});

function serializeStatusTagRow(name, def) {
  return {
    name,
    address: def.address,
    kind: def.kind === 'enum' ? 'enum' : 'bool',
    defaultActive: def.defaultActive !== false,
  };
}

function validateStatusTagsPayload(body, preservedNames) {
  const rows = body?.tags;
  if (!Array.isArray(rows) || !rows.length) return { error: 'tags must be a non-empty array' };

  const seen = new Set();
  const clean = [];
  for (const row of rows) {
    const name = String(row.name || '').trim();
    const address = String(row.address || '').trim();
    if (!TAG_NAME_RE.test(name)) {
      return { error: `"${name}" isn't a valid tag name (letters, digits, underscore; can't start with a digit)` };
    }
    if (seen.has(name)) return { error: `duplicate tag name: ${name}` };
    if (preservedNames.has(name)) return { error: `"${name}" is a reserved analog/sensor tag name` };
    seen.add(name);
    if (!address) return { error: `${name}: address is required` };
    clean.push({
      name,
      originalName: row.originalName ? String(row.originalName).trim() : null,
      address,
      kind: row.kind === 'enum' ? 'enum' : 'bool',
      defaultActive: row.defaultActive !== false,
    });
  }
  return { value: clean };
}

// /api/settings/status-tags -- the editable list of non-logging status/cycle
// tags (trend: false in config.js -- Mode, CycleStatus, AlarmActive, ...).
// Only name/address/kind/defaultActive are editable here; each tag's
// per-value `labels` map (raw value -> {text, level}) is left as-is (or
// empty for a newly added tag, which just shows its raw value until labels
// are added in config.js/tags.json by hand).
app.get('/api/settings/status-tags', (_req, res) => {
  const tags = Object.entries(config.tags)
    .filter(([, def]) => !isEditableTag(def))
    .map(([name, def]) => serializeStatusTagRow(name, def));
  res.json({ tags });
});

app.put('/api/settings/status-tags', (req, res) => {
  const preserved = Object.fromEntries(Object.entries(config.tags).filter(([, def]) => isEditableTag(def)));
  const { error, value } = validateStatusTagsPayload(req.body, new Set(Object.keys(preserved)));
  if (error) return res.status(400).json({ error });

  const existingStatusTags = Object.fromEntries(
    Object.entries(config.tags).filter(([, def]) => !isEditableTag(def))
  );

  const nextStatusTags = {};
  for (const row of value) {
    const prior = existingStatusTags[row.originalName || row.name];
    nextStatusTags[row.name] = {
      ...prior,
      address: row.address,
      kind: row.kind,
      defaultActive: row.defaultActive,
      trend: false,
      log: false,
    };
  }

  const nextTags = { ...preserved, ...nextStatusTags };
  config.tags = nextTags;
  try {
    fs.writeFileSync(path.join(__dirname, 'tags.json'), JSON.stringify(nextTags, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `failed to save tags.json: ${err.message}` });
  }

  res.json({ tags: value, restartRequired: true });
});

// Tag edits above only take effect on the next process start (tag lists,
// the PLC poller, and the RAM trend buffer are all built once at startup
// from config.tags). Task Scheduler's start-hidden.vbs only launches the
// process on logon and won't relaunch it if it exits on its own, so a
// plain process.exit() here would just take the logger down until the
// next reboot. Instead, spawn a detached replacement process first (same
// argv/env, so --demo/--replay carry over, and stdio appended to the same
// logger.log start-hidden.vbs already writes to), then exit -- the new
// process keeps running under Task Scheduler's job after this one exits.
app.post('/api/settings/restart', (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    console.log('[restart] respawning on operator request from Settings');
    poller.stop();
    db.close();
    const logFd = fs.openSync(path.join(__dirname, 'logger.log'), 'a');
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: __dirname,
      env: process.env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    process.exit(0);
  }, 250);
});

// Zone slots that must name a real tag vs. slots that may be left blank to
// omit that stat from the card entirely.
const ZONE_REQUIRED_FIELDS = ['zoneATag', 'zoneBTag'];
// voltageTag2/currentTag2/powerTag2/outputTag2: a second power module's
// stats, for zones that have one -- rendered as a second row on the card
// when any of the four is set (see ZONE_SECONDARY_SLOT_ROWS in
// DashboardPage.jsx), otherwise left blank like every other optional slot.
const ZONE_OPTIONAL_FIELDS = [
  'setpointTag', 'activeTag',
  'voltageTag', 'currentTag', 'powerTag', 'outputTag',
  'voltageTag2', 'currentTag2', 'powerTag2', 'outputTag2',
];

function serializeZone(zone) {
  const out = { name: zone.name };
  for (const field of [...ZONE_REQUIRED_FIELDS, ...ZONE_OPTIONAL_FIELDS]) out[field] = zone[field] || '';
  return out;
}

// /api/zones -- current heating zone card config, for the Dashboard to
// render however many cards are configured (rather than a hardcoded pair).
// This never touches the poller/tag list, so unlike tags it applies live --
// no restart needed after a save.
app.get('/api/zones', (_req, res) => {
  res.json({ zones: config.zones.map(serializeZone) });
});

app.get('/api/settings/zones', (_req, res) => {
  res.json({ zones: config.zones.map(serializeZone) });
});

function validateZonesPayload(body) {
  const rows = body?.zones;
  if (!Array.isArray(rows)) return { error: 'zones must be an array' };

  const clean = [];
  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) return { error: 'each zone needs a name' };

    const zone = { name };
    for (const field of ZONE_REQUIRED_FIELDS) {
      const tag = String(row[field] || '').trim();
      if (!tag) return { error: `${name}: ${field.replace('Tag', '')} is required` };
      if (!config.tags[tag]) return { error: `${name}: unknown tag "${tag}"` };
      zone[field] = tag;
    }
    for (const field of ZONE_OPTIONAL_FIELDS) {
      const tag = String(row[field] || '').trim();
      if (tag && !config.tags[tag]) return { error: `${name}: unknown tag "${tag}"` };
      zone[field] = tag;
    }
    clean.push(zone);
  }
  return { value: clean };
}

// Persists to zones.json and updates config.zones in place. Takes effect
// immediately -- the Dashboard re-fetches /api/zones on load, no server
// restart required (unlike the tag list).
app.put('/api/settings/zones', (req, res) => {
  const { error, value } = validateZonesPayload(req.body);
  if (error) return res.status(400).json({ error });

  config.zones = value;
  try {
    fs.writeFileSync(path.join(__dirname, 'zones.json'), JSON.stringify(value, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `failed to save zones.json: ${err.message}` });
  }

  res.json({ zones: value });
});

// The Dashboard's four small fixed-position tile groups -- only their tag
// membership is editable; the keys, labels, and where each renders live in
// DashboardPage.jsx.
const DASHBOARD_GROUP_KEYS = ['pressures', 'cooling', 'vesselTemperatures', 'power'];

app.get('/api/dashboard-groups', (_req, res) => {
  res.json({ groups: config.dashboardGroups });
});

app.get('/api/settings/dashboard-groups', (_req, res) => {
  res.json({ groups: config.dashboardGroups });
});

function validateDashboardGroupsPayload(body) {
  const groups = body?.groups;
  if (!groups || typeof groups !== 'object') return { error: 'groups must be an object' };

  const clean = {};
  for (const key of DASHBOARD_GROUP_KEYS) {
    const list = groups[key];
    if (!Array.isArray(list)) return { error: `${key} must be an array of tag names` };
    const tags = [];
    for (const raw of list) {
      const tag = String(raw || '').trim();
      if (!tag) continue;
      if (!config.tags[tag]) return { error: `${key}: unknown tag "${tag}"` };
      if (!tags.includes(tag)) tags.push(tag);
    }
    clean[key] = tags;
  }
  return { value: clean };
}

// Persists to dashboard.json and updates config.dashboardGroups in place.
// Takes effect immediately -- the Dashboard re-fetches /api/dashboard-groups
// on load, no server restart required.
app.put('/api/settings/dashboard-groups', (req, res) => {
  const { error, value } = validateDashboardGroupsPayload(req.body);
  if (error) return res.status(400).json({ error });

  config.dashboardGroups = value;
  try {
    fs.writeFileSync(path.join(__dirname, 'dashboard.json'), JSON.stringify(value, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `failed to save dashboard.json: ${err.message}` });
  }

  res.json({ groups: value });
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

  // Present only when exporting a single cycle from the Cycles page --
  // names the file after the cycle and stamps its identifying info at the
  // top of the CSV. A plain Trend-page export has none of these and keeps
  // the old trend_<stamp>.csv filename with no metadata block.
  const cycleName = (req.query.name || '').trim();
  const batchCode = (req.query.batchCode || '').trim();
  const operator = (req.query.operator || '').trim();

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
  // Quote a free-text metadata cell if it contains the separator, a quote,
  // or a newline -- unlike the numeric data cells below, these come from
  // user-typed cycle fields and can contain anything.
  const csvCell = (v) => (new RegExp(`["\r\n${sep}]`).test(v) ? `"${v.replace(/"/g, '""')}"` : v);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Filenames can't contain / \ : * ? " < > | or control characters;
  // collapse whitespace and drop anything left blank back to the old name.
  const safeName = cycleName
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const filenameBase = safeName || `trend_${stamp}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filenameBase.replace(/[^\x20-\x7E]/g, '_')}.csv"; ` +
      `filename*=UTF-8''${encodeURIComponent(filenameBase)}.csv`
  );

  if (cycleName || batchCode || operator) {
    res.write(['Cycle Name', csvCell(cycleName)].join(sep) + '\r\n');
    res.write(['Batch Code', csvCell(batchCode)].join(sep) + '\r\n');
    res.write(['Operator', csvCell(operator)].join(sep) + '\r\n');
    res.write('\r\n');
  }

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
