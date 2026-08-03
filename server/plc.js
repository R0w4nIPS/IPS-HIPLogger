// Thin wrapper around nodes7: connect, poll on an interval, auto-reconnect.
// Emits 'sample' ({ t, values }) and 'status' ('online' | 'offline').

const nodes7 = require('nodes7');
const EventEmitter = require('events');

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
          console.error(`[plc] connect failed: ${err.message || err}`);
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

module.exports = PlcPoller;
