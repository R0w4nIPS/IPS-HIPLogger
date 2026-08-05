// SQLite persistence for trend samples (better-sqlite3).
//
// Writes are queued in RAM and flushed in a single transaction every few
// seconds, so a 1 s poll rate produces one small write burst per flush
// instead of constant I/O -- important on SD-card-backed devices.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Default cycle name (e.g. "Cycle_2026-07-15_10-05-03"), used whenever a
// cycle isn't given a name explicitly -- start_t in local time, since that's
// what an operator standing at the machine actually reads it as.
function defaultCycleName(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `Cycle_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Renames a tag's historical samples. Always operates on the real trend.db
// by filename, not through a live TrendDB instance -- demo/replay modes
// redirect their *writes* to trend.demo.db, but a rename from the Settings
// page should still land in the actual production history, not whichever
// file happens to be open for the current run mode. A no-op if trend.db
// doesn't exist yet (nothing logged there to rename).
function renameTagInFile(file, oldName, newName) {
  const fullPath = path.resolve(__dirname, file);
  if (!fs.existsSync(fullPath)) return;
  const conn = new Database(fullPath);
  try {
    conn.prepare('UPDATE samples SET tag = ? WHERE tag = ?').run(newName, oldName);
  } finally {
    conn.close();
  }
}

class TrendDB {
  constructor(config) {
    this.db = new Database(path.resolve(__dirname, config.db.file));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        t   INTEGER NOT NULL,   -- ms epoch
        tag TEXT    NOT NULL,
        v   REAL                -- NULL for bad reads
      );
      CREATE INDEX IF NOT EXISTS idx_samples_tag_t ON samples (tag, t);
      -- t alone (not just the (tag, t) composite above) so prune()'s
      -- WHERE t < cutoff -- no tag filter -- can use an index instead of
      -- scanning every row, every hour, forever.
      CREATE INDEX IF NOT EXISTS idx_samples_t ON samples (t);

      CREATE TABLE IF NOT EXISTS cycles (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        start_t INTEGER NOT NULL,  -- ms epoch, LoggingOnOff false->true
        end_t   INTEGER            -- ms epoch, LoggingOnOff true->false; NULL while running
      );
      CREATE INDEX IF NOT EXISTS idx_cycles_start_t ON cycles (start_t);
    `);

    // Traceability fields, added after cycles already existed in the wild --
    // ALTER TABLE (not part of CREATE TABLE IF NOT EXISTS above) so existing
    // trend.db files pick them up without losing logged history.
    const cycleCols = new Set(this.db.prepare('PRAGMA table_info(cycles)').all().map((c) => c.name));
    for (const col of ['name', 'batch_code', 'operator']) {
      if (!cycleCols.has(col)) this.db.exec(`ALTER TABLE cycles ADD COLUMN ${col} TEXT`);
    }

    // Backfill a default name for any cycle that doesn't have one yet
    // (pre-existing rows from before `name` existed, or ones logged before
    // this default was added) -- never touches a name someone already set.
    const nameStmt = this.db.prepare('UPDATE cycles SET name = ? WHERE id = ?');
    for (const { id, start_t } of this.db.prepare('SELECT id, start_t FROM cycles WHERE name IS NULL').all()) {
      nameStmt.run(defaultCycleName(start_t), id);
    }

    // A cycle left open (end_t NULL) means logging stopped without a clean
    // LoggingOnOff true->false edge -- either this server crashed mid-cycle,
    // or (e.g. after copying in a trend.db captured from another machine
    // mid-cycle) it was never running here at all. Either way "now" is not
    // the real end: close it out using the last sample actually logged
    // after it started instead, so a stale/foreign open cycle gets its true
    // duration rather than however long it happened to sit unopened before
    // this server first read the file. Falls back to start_t (zero-length)
    // if the cycle has no samples at all.
    for (const { id, start_t } of this.db
      .prepare('SELECT id, start_t FROM cycles WHERE end_t IS NULL')
      .all()) {
      const { max_t } = this.db.prepare('SELECT MAX(t) as max_t FROM samples WHERE t >= ?').get(start_t);
      this.db.prepare('UPDATE cycles SET end_t = ? WHERE id = ?').run(max_t ?? start_t, id);
    }

    this._insert = this.db.prepare('INSERT INTO samples (t, tag, v) VALUES (?, ?, ?)');
    this._flushTx = this.db.transaction((rows) => {
      for (const r of rows) this._insert.run(r[0], r[1], r[2]);
    });
    this._insertCycle = this.db.prepare('INSERT INTO cycles (start_t, name) VALUES (?, ?)');
    this._closeCycle = this.db.prepare(
      `UPDATE cycles SET end_t = ?
       WHERE id = (SELECT id FROM cycles WHERE end_t IS NULL ORDER BY start_t DESC LIMIT 1)`
    );
    this._listCycles = this.db.prepare(
      'SELECT id, start_t, end_t, name, batch_code, operator FROM cycles ORDER BY start_t DESC LIMIT ?'
    );
    this._listCyclesRange = this.db.prepare(
      `SELECT id, start_t, end_t, name, batch_code, operator FROM cycles
       WHERE start_t >= ? AND start_t <= ?
       ORDER BY start_t DESC LIMIT ?`
    );
    this._getCycle = this.db.prepare(
      'SELECT id, start_t, end_t, name, batch_code, operator FROM cycles WHERE id = ?'
    );
    this._updateCycleMeta = this.db.prepare(
      'UPDATE cycles SET name = ?, batch_code = ?, operator = ? WHERE id = ?'
    );
    this._deleteCycle = this.db.prepare('DELETE FROM cycles WHERE id = ?');

    this.queue = [];
    this.retentionMs = config.db.retentionDays * 86400 * 1000;

    this.flushTimer = setInterval(() => this.flush(), config.db.flushIntervalMs);
    this.pruneTimer = setInterval(() => this.prune(), 3600 * 1000);
    this.prune();
  }

  push(sample) {
    for (const [tag, v] of Object.entries(sample.values)) {
      this.queue.push([sample.t, tag, v]);
    }
  }

  flush() {
    if (!this.queue.length) return;
    const rows = this.queue;
    this.queue = [];
    try {
      this._flushTx(rows);
    } catch (err) {
      console.error(`[db] flush failed (${rows.length} rows): ${err.message}`);
    }
  }

  /** Record the start of a new logging cycle (LoggingOnOff false -> true). */
  startCycle(t) {
    this._insertCycle.run(t, defaultCycleName(t));
  }

  /** Close out the currently-open cycle, if any (LoggingOnOff true -> false). */
  endCycle(t) {
    this._closeCycle.run(t);
  }

  /**
   * List logged cycles, most recent first, for the Cycles page. When
   * `from`/`to` (ms epoch) are given, only cycles that *started* inside
   * that window are returned -- used for the page's date/time search.
   */
  listCycles(limit = 200, from = null, to = null) {
    if (from != null || to != null) {
      return this._listCyclesRange.all(from ?? 0, to ?? Date.now(), limit);
    }
    return this._listCycles.all(limit);
  }

  /** Look up a single cycle by id, for the cycle report page. */
  getCycle(id) {
    return this._getCycle.get(id);
  }

  /** Update a cycle's traceability fields (name/batch code/operator). */
  updateCycleMeta(id, { name, batchCode, operator }) {
    this._updateCycleMeta.run(name || null, batchCode || null, operator || null, id);
  }

  /** Delete a cycle's record. Leaves its logged samples untouched. */
  deleteCycle(id) {
    this._deleteCycle.run(id);
  }

  prune() {
    const cutoff = Date.now() - this.retentionMs;
    const info = this.db.prepare('DELETE FROM samples WHERE t < ?').run(cutoff);
    if (info.changes) console.log(`[db] pruned ${info.changes} old samples`);
  }

  /** Load one tag's samples for seeding the RAM buffer on startup. */
  load(tag, from, to) {
    return this.db
      .prepare('SELECT t, v FROM samples WHERE tag = ? AND t >= ? AND t <= ? ORDER BY t')
      .all(tag, from, to);
  }

  /**
   * Iterate rows for CSV export, pivoted to one row per timestamp:
   * yields { t, values: { tagA: v, tagB: v, ... } }.
   * Uses a streaming iterator so multi-day exports stay memory-flat.
   */
  *exportRows(tags, from, to) {
    const placeholders = tags.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT t, tag, v FROM samples
       WHERE tag IN (${placeholders}) AND t >= ? AND t <= ?
       ORDER BY t`
    );

    let current = null;
    for (const row of stmt.iterate(...tags, from, to)) {
      if (!current || current.t !== row.t) {
        if (current) yield current;
        current = { t: row.t, values: {} };
      }
      current.values[row.tag] = row.v;
    }
    if (current) yield current;
  }

  close() {
    clearInterval(this.flushTimer);
    clearInterval(this.pruneTimer);
    this.flush();
    this.db.close();
  }
}

module.exports = TrendDB;
module.exports.renameTagInFile = renameTagInFile;
