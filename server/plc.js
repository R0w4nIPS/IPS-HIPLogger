// Thin wrapper around nodes7: connect, poll on an interval, auto-reconnect.
// Emits 'sample' ({ t, values }) and 'status' ('online' | 'offline').

const nodes7 = require('nodes7');
const EventEmitter = require('events');

// Friendlier text for the handful of error codes a bad host/port/rack/slot
// actually produces in practice.
const ERROR_CODE_TEXT = {
  ECONNREFUSED: 'Connection refused (host is reachable but nothing is listening on that port)',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ETIMEDOUT: 'Connection timed out',
  EUSERTIMEOUT: 'Connection timed out',
};

// nodes7 doesn't always hand back a real Error -- a connection failure is
// often just a plain `{ code: 'EUSERTIMEOUT' }` object with no `.message`,
// which `${err}`/String(err) stringifies as the useless "[object Object]".
function formatPlcError(err) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && err.code) return ERROR_CODE_TEXT[err.code] || err.code;
  return String(err);
}

class PlcPoller extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.conn = null;
    this.timer = null;
    this.online = false;
    this.stopping = false;

    // name -> address lookup used by nodes7's translation callback
    this.addressMap = {};
    for (const [name, def] of Object.entries(config.tags)) {
      this.addressMap[name] = def.address;
    }
  }

  start() {
    this.stopping = false;
    this._connect();
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.conn) this.conn.dropConnection(() => {});
  }

  _setStatus(online) {
    if (this.online !== online) {
      this.online = online;
      this.emit('status', online ? 'online' : 'offline');
    }
  }

  _connect() {
    if (this.stopping) return;
    const { host, port, rack, slot, timeout } = this.config.plc;

    this.conn = new nodes7({ silent: true });
    this.conn.initiateConnection(
      { host, port, rack, slot, timeout },
      (err) => {
        if (err) {
          console.error(`[plc] connect failed: ${formatPlcError(err)}`);
          this._setStatus(false);
          this._scheduleReconnect();
          return;
        }
        console.log(`[plc] connected to ${host} (rack ${rack}, slot ${slot})`);
        this.conn.setTranslationCB((tag) => this.addressMap[tag]);
        this.conn.addItems(Object.keys(this.addressMap));
        this._setStatus(true);
        this._startPolling();
      }
    );
  }

  _startPolling() {
    if (this.timer) clearInterval(this.timer);
    let busy = false;

    this.timer = setInterval(() => {
      if (busy) return; // skip a beat rather than queueing reads
      busy = true;

      this.conn.readAllItems((anythingBad, values) => {
        busy = false;
        if (anythingBad) {
          // One or more items failed; values contains 'BAD 255' markers.
          // Treat a full failure as a lost connection.
          const allBad = Object.values(values).every(
            (v) => typeof v === 'string' && v.startsWith('BAD')
          );
          if (allBad) {
            console.error('[plc] read failed, reconnecting');
            this._teardownAndReconnect();
            return;
          }
        }

        const clean = {};
        for (const [name, v] of Object.entries(values)) {
          clean[name] =
            typeof v === 'string' && v.startsWith('BAD')
              ? null
              : typeof v === 'boolean'
              ? (v ? 1 : 0)
              : v;
        }
        this.emit('sample', { t: Date.now(), values: clean });
      });
    }, this.config.pollIntervalMs);
  }

  _teardownAndReconnect() {
    if (this.timer) clearInterval(this.timer);
    this._setStatus(false);
    this.conn.dropConnection(() => this._scheduleReconnect());
  }

  _scheduleReconnect() {
    if (this.stopping) return;
    setTimeout(() => this._connect(), 3000);
  }
}

// One-shot connect/disconnect used by the Settings page's "Test Connection"
// button -- independent of PlcPoller (which may not even be the active
// poller in demo/replay mode), so it can check reachability for whatever
// the user currently has typed in the form before saving it.
function testConnection({ host, port, rack, slot, timeout }) {
  return new Promise((resolve) => {
    const conn = new nodes7({ silent: true });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      conn.dropConnection(() => {});
      resolve(result);
    };
    // nodes7 has its own internal `timeout`, but a slow/black-holed host can
    // still hang past it -- this backstops that so the button never spins
    // forever regardless.
    const timer = setTimeout(() => done({ ok: false, error: 'Connection timed out' }), timeout + 2000);
    try {
      conn.initiateConnection({ host, port, rack, slot, timeout }, (err) => {
        clearTimeout(timer);
        done(err ? { ok: false, error: formatPlcError(err) } : { ok: true });
      });
    } catch (err) {
      clearTimeout(timer);
      done({ ok: false, error: formatPlcError(err) });
    }
  });
}

module.exports = PlcPoller;
module.exports.testConnection = testConnection;
