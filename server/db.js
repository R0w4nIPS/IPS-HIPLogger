// SQLite persistence for trend samples (better-sqlite3).
//
// Writes are queued in RAM and flushed in a single transaction every few
// seconds, so a 1 s poll rate produces one small write burst per flush
// instead of constant I/O -- important on SD-card-backed devices.

const path = require('path');
const Database = require('better-sqlite3');

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

      CREATE TABLE IF NOT EXISTS cycles (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        start_t INTEGER NOT NULL,  -- ms epoch, LoggingOnOff false->true
        end_t   INTEGER            -- ms epoch, LoggingOnOff true->false; NULL while running
      );
      CREATE INDEX IF NOT EXISTS idx_cycles_start_t ON cycles (start_t);
    `);

    // A cycle left open (end_t NULL) means the server stopped mid-cycle --
    // there's a data gap across the restart either way, so it can't be
    // resumed as one continuous cycle. Close it out now so it doesn't show
    // as "still running" forever, and so the next LoggingOnOff-true edge
    // starts a fresh row instead of piling up a second open one.
    this.db.prepare('UPDATE cycles SET end_t = ? WHERE end_t IS NULL').run(Date.now());

    this._insert = this.db.prepare('INSERT INTO samples (t, tag, v) VALUES (?, ?, ?)');
    this._flushTx = this.db.transaction((rows) => {
      for (const r of rows) this._insert.run(r[0], r[1], r[2]);
    });
    this._insertCycle = this.db.prepare('INSERT INTO cycles (start_t) VALUES (?)');
    this._closeCycle = this.db.prepare(
      `UPDATE cycles SET end_t = ?
       WHERE id = (SELECT id FROM cycles WHERE end_t IS NULL ORDER BY start_t DESC LIMIT 1)`
    );
    this._listCycles = this.db.prepare('SELECT id, start_t, end_t FROM cycles ORDER BY start_t DESC LIMIT ?');
    this._listCyclesRange = this.db.prepare(
      `SELECT id, start_t, end_t FROM cycles
       WHERE start_t >= ? AND start_t <= ?
       ORDER BY start_t DESC LIMIT ?`
    );
    this._getCycle = this.db.prepare('SELECT id, start_t, end_t FROM cycles WHERE id = ?');

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
    this._insertCycle.run(t);
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
