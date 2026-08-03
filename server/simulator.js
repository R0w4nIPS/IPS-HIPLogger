// Drop-in stand-in for plc.js when no PLC is available.
// Mirrors PlcPoller's interface (start/stop, 'sample'/'status' events) so
// index.js doesn't need to know which one it's talking to.
//
// Two simulation styles, picked per tag from config.tags[name].sim:
//   - analog (default): mean-reverting random walk within {min, max, start,
//     pull, noise}, so charts show a plausible, bounded trend.
//   - discrete ({discrete: true, values, flipChance}): holds one value from
//     `values` and flips to a random different one with probability
//     `flipChance` per tick -- for bool/enum status tags, which should sit
//     steady and occasionally change state rather than drift continuously.

const EventEmitter = require('events');

class SimPoller extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.timer = null;
    this.state = {};

    for (const [name, def] of Object.entries(config.tags)) {
      const sim = def.sim || {};
      if (sim.discrete) {
        const values = sim.values ?? [0, 1];
        this.state[name] = {
          discrete: true,
          values,
          flipChance: sim.flipChance ?? 0.02,
          value: sim.start ?? values[0],
        };
        continue;
      }
      const min = sim.min ?? 0;
      const max = sim.max ?? 100;
      this.state[name] = {
        min,
        max,
        value: sim.start ?? (min + max) / 2,
        pull: sim.pull ?? 0.02, // fraction of the way back to midpoint, per tick
        noise: (sim.noise ?? 0.02) * (max - min), // random step size
      };
    }
  }

  start() {
    // A simulator has nothing to reconnect to; report online immediately.
    this.emit('status', 'online');
    this._startPolling();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  _startPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const values = {};
      for (const [name, s] of Object.entries(this.state)) {
        if (s.discrete) {
          if (Math.random() < s.flipChance) {
            const choices = s.values.filter((v) => v !== s.value);
            s.value = choices[Math.floor(Math.random() * choices.length)] ?? s.value;
          }
          values[name] = s.value;
          continue;
        }
        const mid = (s.min + s.max) / 2;
        const drift = (mid - s.value) * s.pull;
        const random = (Math.random() - 0.5) * s.noise;
        s.value = Math.min(s.max, Math.max(s.min, s.value + drift + random));
        values[name] = Math.round(s.value * 1000) / 1000;
      }
      this.emit('sample', { t: Date.now(), values });
    }, this.config.pollIntervalMs);
  }
}

module.exports = SimPoller;
