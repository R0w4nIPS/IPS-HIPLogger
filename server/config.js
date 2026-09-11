// ---------------------------------------------------------------------------
// S7-1500 trend server configuration
//
// IMPORTANT for S7-1500 (and S7-1200):
//   1. In TIA Portal, under CPU Properties -> Protection & Security ->
//      Connection mechanisms: enable "Permit access with PUT/GET communication
//      from remote partner".
//   2. Every DB you read from must have "Optimized block access" UNCHECKED
//      (DB properties -> Attributes), then recompile + download. Optimized
//      DBs have no absolute addresses and cannot be read over S7comm.
//   3. S7-1500 connects with rack 0, slot 1.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const config = {
  plc: {
    host: '192.168.0.1',   // CPU IP address
    port: 102,
    rack: 0,
    slot: 1,                // S7-1500 = slot 1 (S7-300 would be slot 2)
    timeout: 5000,
  },

  // Tag map: friendly name -> absolute S7 address.
  // Address syntax (nodes7): DB<n>,<TYPE><byteOffset>
  //   REAL   -> DB10,REAL0
  //   INT    -> DB10,INT4
  //   DINT   -> DB10,DINT6
  //   BOOL   -> DB10,X10.0
  //   WORD   -> DB10,WORD12
  // `sim` (optional): plausible min/max for demo mode (see `demo` below).
  // Unused when polling a real PLC.
  // `defaultActive` (optional, default true): whether this tag's tile/chart
  // line is shown out of the box -- i.e. the very first time the app is
  // opened in a browser, or after clearing its storage. Once someone uses
  // the "Select Trends" picker in the UI, their choice is remembered in that
  // browser (localStorage) and takes over from this default going forward.
  // Set to `false` for tags that should start hidden until picked.
  // `logIntervalSec` (optional, default 0 = every sample): thins out SQLite
  // writes for slow-moving tags (e.g. cooling water temps) that don't need
  // 1 Hz resolution on disk. The tag still updates live every poll tick for
  // the RAM buffer/WebSocket/chart -- this only skips samples closer than
  // `logIntervalSec` seconds to the last one actually written to trend.db.
  tags: {
Pressure_Setpoint:  { address: 'DB1000,REAL92',  unit: 'bar', decimals: 1, color: '#ac3500', defaultActive: true, sim: { min: 0, max: 2000, start: 900, noise: 0.005, pull: 0.03 } },
    Vessel_Pressure:   { address: 'DB1000,REAL0',  unit: 'bar', decimals: 1, color: '#863ca4', defaultActive: true, sim: { min: 0, max: 2000, noise: 0.03 } },
    Bottle_Pressure:  { address: 'DB1000,REAL4',  unit: 'bar',  decimals: 1, color: '#be478d', defaultActive: true, sim: { min: 0, max: 400, noise: 0.03 } },
    Vacuum_Pressure:       { address: 'DB1000,REAL8',  unit: 'mbar', decimals: 1, color: '#009650', defaultActive: true, sim: { min: 0, max: 2000, noise: 0.02 } },
    Temperature_Setpoint:  { address: 'DB1000,REAL96',  unit: '°C', decimals: 1, color: '#004ea1', defaultActive: true, sim: { min: 0, max: 2000, start: 900, noise: 0.005, pull: 0.03 } },
    Top_Zone_A:  { address: 'DB1000,REAL12',  unit: '°C',    decimals: 1, color: '#b56400', defaultActive: true, sim: { min: 0, max: 2000, start: 180, noise: 0.01, pull: 0.01 } },
    Top_Zone_B:  { address: 'DB1000,REAL16',  unit: '°C',    decimals: 1, color: '#007998', defaultActive: true, sim: { min: 0, max: 2000, start: 180, noise: 0.01, pull: 0.01 } },
    Bottom_Zone_A:  { address: 'DB1000,REAL20',  unit: '°C',    decimals: 1, color: '#4d7100', defaultActive: true, sim: { min: 0, max: 2000, start: 180, noise: 0.01, pull: 0.01 } },
    Bottom_Zone_B:  { address: 'DB1000,REAL24',  unit: '°C',    decimals: 1, color: '#009879', defaultActive: true, sim: { min: 0, max: 2000, start: 180, noise: 0.01, pull: 0.01 } },
    Load_1:  { address: 'DB1000,REAL28',  unit: '°C',    decimals: 1, color: '#ae3200', defaultActive: false, sim: { min: 0, max: 2000, start: 180, noise: 0.01, pull: 0.01 } },
    Load_2:  { address: 'DB1000,REAL32',  unit: '°C',    decimals: 1, color: '#4074dd', defaultActive: false, sim: { min: 0, max: 2000, start: 180, noise: 0.01, pull: 0.01 } },
    Temp_Coolwater_Cover:  { address: 'DB1000,REAL36',  unit: '°C',    decimals: 1, color: '#af2938', defaultActive: false, logIntervalSec: 10, sim: { min: 0, max: 200, start: 180, noise: 0.01, pull: 0.01 } },
    Temp_Coolwater_Jacket:  { address: 'DB1000,REAL40',  unit: '°C',    decimals: 1, color: '#a44100', defaultActive: false, logIntervalSec: 10, sim: { min: 0, max: 200, start: 180, noise: 0.01, pull: 0.01 } },
    Temp_Coolwater_Top_In:  { address: 'DB1000,REAL44',  unit: '°C',    decimals: 1, color: '#006fb0', defaultActive: false, logIntervalSec: 10, sim: { min: 0, max: 200, start: 180, noise: 0.01, pull: 0.01 } },
    Temp_Outside_Heatshield:  { address: 'DB1000,REAL48',  unit: '°C',    decimals: 1, color: '#c84368', defaultActive: false, sim: { min: 0, max: 200, start: 180, noise: 0.01, pull: 0.01 } },
    Temp_Vessel:  { address: 'DB1000,REAL52',  unit: '°C',    decimals: 1, color: '#007a12', defaultActive: false, sim: { min: 0, max: 200, start: 180, noise: 0.01, pull: 0.01 } },
    Voltage_Top:  { address: 'DB1000,REAL56',  unit: 'V',    decimals: 1, color: '#6f67da', defaultActive: false, sim: { min: 0, max: 400, start: 180, noise: 0.01, pull: 0.01 } },
    Current_Top:  { address: 'DB1000,REAL60',  unit: 'A',    decimals: 1, color: '#9e7400', defaultActive: false, sim: { min: 0, max: 1000, start: 180, noise: 0.01, pull: 0.01 } },
    Power_Top:  { address: 'DB1000,REAL64',  unit: 'KW',    decimals: 1, color: '#cb473d', defaultActive: false, sim: { min: 0, max: 400, start: 180, noise: 0.01, pull: 0.01 } },
    Top_Furnace_Output:  { address: 'DB1000,REAL68',  unit: '%',    decimals: 1, color: '#9a3288', defaultActive: false, sim: { min: 0, max: 100, start: 180, noise: 0.01, pull: 0.01 } },
    Voltage_Bottom:  { address: 'DB1000,REAL72',  unit: 'V',    decimals: 1, color: '#007f4a', defaultActive: false, sim: { min: 0, max: 400, start: 180, noise: 0.01, pull: 0.01 } },
    Current_Bottom:  { address: 'DB1000,REAL76',  unit: 'A',    decimals: 1, color: '#6d47b8', defaultActive: false, sim: { min: 0, max: 1000, start: 180, noise: 0.01, pull: 0.01 } },
    Power_Bottom:  { address: 'DB1000,REAL80',  unit: 'KW',    decimals: 1, color: '#00969e', defaultActive: false, sim: { min: 0, max: 400, start: 180, noise: 0.01, pull: 0.01 } },
    Bottom_Furnace_Output:  { address: 'DB1000,REAL84',  unit: '%',    decimals: 1, color: '#7d8200', defaultActive: false, sim: { min: 0, max: 100, start: 180, noise: 0.01, pull: 0.01 } },
    Total_Power:  { address: 'DB1000,REAL88',  unit: 'KW',    decimals: 1, color: '#0064bf', defaultActive: false, sim: { min: 0, max: 400, start: 180, noise: 0.01, pull: 0.01 } },
    


    // ---- Cycle/status signals (db1001) -------------------------------------
    // Discrete state tags: `kind` is 'bool' or 'enum', `labels` maps each raw
    // value to { text, level? }. `level` ('ok' | 'warn' | 'bad') drives the
    // status color on the dashboard tile; omit it for a neutral value.
    // Demo mode holds a value and flips to a new one with probability
    // `sim.flipChance` per poll tick, rather than the analog random walk
    // used for REAL tags above.
    // `trend: false`: excluded from the Trend page entirely (tile list,
    // Select Trends picker, chart, RAM history buffer) -- these are current
    // status snapshots, not something worth trending. Still live on the
    // Dashboard, which reads `latest` values directly, not history.
    // `log: false`: never written to SQLite, regardless of LoggingOnOff.
    LoggingOnOff: {
      address: 'DB1001,X0.0', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'Off' }, 1: { text: 'On', level: 'ok' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.01 },
      replayValue: 1,
    },
    Mode: {
      address: 'DB1001,X0.1', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'Manual', level: 'info' }, 1: { text: 'Auto', level: 'info' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.01 },
      replayValue: 1,
    },
    // NOTE: written as "db1001.2" (no bit) -- assumed DB1001,INT2.
    CycleStatus: {
      address: 'DB1001,INT2', kind: 'enum', defaultActive: false, trend: false, log: false,
      labels: {
        1: { text: 'Running', level: 'ok' },
        2: { text: 'Alarm Pause', level: 'info' },
        3: { text: 'Manual Pause', level: 'info' },
        4: { text: 'Stopped', level: 'bad' },
      },
      sim: { discrete: true, values: [1, 2, 3, 4], flipChance: 0.02 },
      replayValue: 1,
    },
    // NOTE: written as "db1001.4" (no bit) -- assumed DB1001,INT4.
    SegmentType: {
      address: 'DB1001,INT4', kind: 'enum', defaultActive: false, trend: false, log: false,
      labels: {
        1: { text: 'Empty' },
        2: { text: 'Vacuum' },
        3: { text: 'Pressurize' },
        4: { text: 'Heating' },
        5: { text: 'Heating + Pressurize' },
        6: { text: 'Sustain Temperature' },
        7: { text: 'Sustain Temp + Pressure' },
        8: { text: 'Natural Cooling' },
        9: { text: 'Rapid Cooling' },
        10: { text: 'Jet Cooling' },
        11: { text: 'Decompression' },
        12: { text: 'Flush Lines' },
      },
      sim: { discrete: true, values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], flipChance: 0.03 },
      replayValue: 4,
    },
    // NOTE: written as "db1001.6" with siblings at .6.1/.6.2/.6.3 -- assumed bit 0.
    AlarmActive: {
      address: 'DB1001,X6.0', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'OK', level: 'ok' }, 1: { text: 'Alarm Active', level: 'bad' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.01 },
      replayValue: 0,
    },
    VesselPosition: {
      address: 'DB1001,X6.1', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'Open' }, 1: { text: 'Closed' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.01 },
      replayValue: 1,
    },
    FurnaceOn: {
      address: 'DB1001,X6.2', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'Off' }, 1: { text: 'On', level: 'ok' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.01 },
      replayValue: 1,
    },
    CoolingRunning: {
      address: 'DB1001,X6.3', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'Stopped', level: 'bad' }, 1: { text: 'Running', level: 'ok' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.01 },
      replayValue: 0,
    },
    // NOTE: written as "db1001.8.0" -- Int types don't take a bit suffix in
    // this scheme, so this assumes the bit was a copy/paste artifact and the
    // real address is DB1001,INT8.
    VesselTemp: {
      address: 'DB1001,INT8', kind: 'enum', defaultActive: false, trend: false, log: false,
      labels: {
        0: { text: 'OK', level: 'ok' },
        1: { text: 'Warning', level: 'warn' },
        3: { text: 'Alarm', level: 'bad' },
      },
      sim: { discrete: true, values: [0, 1, 3], flipChance: 0.01 },
      replayValue: 0,
    },
    TopZoneActiveTC: {
      address: 'DB1001,X10.0', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'A' }, 1: { text: 'B' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.005 },
      replayValue: 0,
    },
    BotZoneActiveTC: {
      address: 'DB1001,X10.1', kind: 'bool', defaultActive: false, trend: false, log: false,
      labels: { 0: { text: 'A' }, 1: { text: 'B' } },
      sim: { discrete: true, values: [0, 1], flipChance: 0.005 },
      replayValue: 0,
    },
  },

  // Demo/dummy-data mode: skip the PLC entirely and generate plausible
  // random-walk values for each tag (see simulator.js). Enable with the
  // DEMO=1 env var, `node index.js --demo`, or by setting this to true.
  demo: false,

  // Replay mode: skip the PLC and instead loop a real recorded cycle read
  // back out of trend.db (see replay.js) -- looks like an actual process
  // run instead of simulator.js's random walk. Enable with the REPLAY=1
  // env var, `node index.js --replay`, or by setting enabled: true here.
  // Implies demo-mode's SQLite isolation (writes go to trend.demo.db, the
  // real trend.db is only ever read from here).
  replay: {
    enabled: false,
    sourceFile: 'trend.db',   // relative to the server directory
    from: 1784109903846,      // 2026-07-15 10:05:03 UTC -- start of the cycle
    to: 1784128104722,        // 2026-07-15 15:08:24 UTC -- end of that cycle (~5h)
    // How long (ms) loggingGateTag drops to 0 right before each loop wraps,
    // so every pass closes out as its own row on the Cycles page instead of
    // one cycle that grows forever. Keep well above pollIntervalMs so the
    // gate reliably sees at least one off sample despite poll timing jitter.
    loopGapMs: 3000,
  },

  // Polling interval in ms. 500-1000 ms is comfortable for one CPU;
  // nodes7 packs all items into as few PDUs as possible.
  pollIntervalMs: 1000,

  // How much history to keep in RAM, in seconds. At 1 s polling,
  // 24 h * 4 tags is roughly 350k points -- trivial for Node.
  retentionSeconds: 24 * 3600,

  // SQLite persistence. Samples are queued in RAM and written in one
  // transaction every flushIntervalMs -- batching writes is gentler on any
  // disk (SD card or SSD) than writing every single sample individually.
  db: {
    file: 'trend.db',        // relative to the server directory
    // 10 years: at this site the logger only runs ~16-24 h/week (gated by
    // loggingGateTag below), so even at 10 y this is roughly ~100-110 GB
    // for 34 tags @ 1 Hz -- comfortable on the 500 GB SSD it runs on.
    retentionDays: 3650,     // DB keeps more history than the RAM buffer
    flushIntervalMs: 5000,
  },

  // Optional: name of a bool tag that gates SQLite writes, to save disk
  // space when nothing needs to be permanently logged. When its value is 0,
  // samples still flow through the RAM buffer + WebSocket as normal (the
  // live trend keeps working) but are NOT written to trend.db. Set to null
  // to always log everything regardless of any tag.
  loggingGateTag: 'LoggingOnOff',

  // CSV export format. Belgian/Dutch Excel expects ';' as separator and
  // ',' as decimal mark; set separator to ',' and decimalComma to false
  // for the international format.
  csv: {
    separator: ';',
    decimalComma: true,
  },

  // HTTP + WebSocket port
  httpPort: 8080,
};

// The PLC connection fields above are just the shipped-with-the-code
// defaults. The Settings page lets an operator change them (e.g. after the
// CPU's IP changes) without editing this file -- those edits are persisted
// separately here and override the defaults above at startup.
const settingsFile = path.join(__dirname, 'settings.json');
try {
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (saved.plc) Object.assign(config.plc, saved.plc);
} catch {
  /* no settings.json yet, or it's unreadable -- the defaults above stand */
}

// Likewise for the tag map's analog/sensor tags (see the Settings page's tag
// editor): once the operator saves any change there, tags.json becomes the
// full source of truth going forward and wholesale replaces `tags` above --
// unlike `plc` this isn't a shallow merge, since renaming/removing a tag
// there needs to actually take the old entry out, not just override fields
// on top of it.
const tagsFile = path.join(__dirname, 'tags.json');
try {
  const savedTags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'));
  if (savedTags && typeof savedTags === 'object') config.tags = savedTags;
} catch {
  /* no tags.json yet, or it's unreadable -- the hardcoded tags above stand */
}

module.exports = config;
