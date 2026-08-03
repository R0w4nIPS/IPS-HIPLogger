// Drop-in stand-in for plc.js (like simulator.js) that replays a real
// recorded cycle from trend.db on a loop, instead of simulator.js's
// synthetic random-walk data -- useful for demos that should look like an
// actual process run rather than random noise.
// Mirrors PlcPoller/SimPoller's interface (start/stop, 'sample'/'status').

const path = require('path');
const EventEmitter = require('events');
const Database = require('better-sqlite3');

class ReplayPoller extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.timer = null;

    const { sourceFile, from, to, loopGapMs } = config.replay;
    this.duration = to - from;
    this.loopGapMs = loopGapMs ?? 3000;
    this.gateTag = config.loggingGateTag;

    // One sorted, cycle-start-relative {t, v}[] per trended tag (t is an
    // offset 0..duration, so playback can loop independent of wall clock).
    // Tags never written to SQLite (log: false -- the db1001 cycle/status
    // signals) have no history to replay; those just hold a fixed
    // `replayValue` for the whole loop instead (see config.js).
    this.series = {};
    this.staticValues = {};
    const db = new Database(path.resolve(__dirname, sourceFile), { readonly: true });
    const stmt = db.prepare('SELECT t, v FROM samples WHERE tag = ? AND t >= ? AND t <= ? ORDER BY t');
    for (const [name, def] of Object.entries(config.tags)) {
      if (def.trend === false) {
        this.staticValues[name] = def.replayValue ?? 0;
        continue;
      }
      this.series[name] = stmt
        .all(name, from, to)
        .filter((r) => r.v != null)
        .map((r) => ({ t: r.t - from, v: r.v }));
    }
    db.close();

    this.playbackStart = Date.now();
  }

  start() {
    // Nothing to reconnect to -- report online immediately, like SimPoller.
    this.emit('status', 'online');
    this._startPolling();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  // Linear-interpolate a sorted {t,v}[] series at a cycle-relative offset.
  _valueAt(points, offset) {
    if (!points.length) return null;
    if (offset <= points[0].t) return points[0].v;
    const last = points[points.length - 1];
    if (offset >= last.t) return last.v;
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= offset) lo = mid;
      else hi = mid;
    }
    const p0 = points[lo];
    const p1 = points[hi];
    if (p1.t === p0.t) return p0.v;
    const frac = (offset - p0.t) / (p1.t - p0.t);
    return p0.v + (p1.v - p0.v) * frac;
  }

  _startPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const offset = (Date.now() - this.playbackStart) % this.duration;
      const values = { ...this.staticValues };
      for (const [name, points] of Object.entries(this.series)) {
        values[name] = this._valueAt(points, offset);
      }
      // Brief off-tick right before the loop wraps, so index.js's
      // loggingGateTag edge-detection closes out the cycle and starts a
      // fresh one next pass -- otherwise LoggingOnOff sits at its constant
      // replayValue forever and the whole replay logs as one endless cycle.
      if (this.gateTag && offset >= this.duration - this.loopGapMs) {
        values[this.gateTag] = 0;
      }
      this.emit('sample', { t: Date.now(), values });
    }, this.config.pollIntervalMs);
  }
}

module.exports = ReplayPoller;
