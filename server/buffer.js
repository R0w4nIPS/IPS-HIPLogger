// Per-tag in-memory ring buffer with pruning and simple bucket downsampling.

class TrendBuffer {
  constructor(tagNames, retentionSeconds) {
    this.retentionMs = retentionSeconds * 1000;
    this.data = {}; // tag -> [{ t, v }, ...] (append-only, time-ordered)
    for (const name of tagNames) this.data[name] = [];
  }

  /** Replace a tag's contents with time-ordered points (startup backfill). */
  seed(tag, points) {
    if (!this.data[tag]) return;
    const cutoff = Date.now() - this.retentionMs;
    this.data[tag] = points.filter((p) => p.t >= cutoff);
  }

  push(sample) {
    const cutoff = sample.t - this.retentionMs;
    for (const [name, v] of Object.entries(sample.values)) {
      const arr = this.data[name];
      if (!arr) continue;
      arr.push({ t: sample.t, v });
      // Prune from the front; samples arrive in order so a while loop is cheap.
      while (arr.length && arr[0].t < cutoff) arr.shift();
    }
  }

  /**
   * Return samples for one tag between from..to (ms epoch).
   * If maxPoints is set and the range holds more, buckets are averaged
   * so charts never receive more points than they can usefully draw.
   */
  query(tag, from, to, maxPoints = 2000) {
    const arr = this.data[tag];
    if (!arr) return null;

    // Binary search for the first index >= from
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t < from) lo = mid + 1;
      else hi = mid;
    }
    const slice = [];
    for (let i = lo; i < arr.length && arr[i].t <= to; i++) slice.push(arr[i]);

    return downsample(slice, from, to, maxPoints);
  }
}

/**
 * Bucket-average a time-ordered {t,v}[] down to at most maxPoints, so
 * charts never receive more than they can usefully draw. Shared with the
 * SQLite-backed path in index.js for date ranges older than the RAM buffer.
 */
function downsample(slice, from, to, maxPoints) {
  if (slice.length <= maxPoints) return slice;

  const bucketMs = (to - from) / maxPoints;
  const out = [];
  let bStart = slice[0].t, sum = 0, n = 0;
  for (const p of slice) {
    if (p.t - bStart >= bucketMs && n > 0) {
      out.push({ t: bStart + bucketMs / 2, v: sum / n });
      bStart = p.t;
      sum = 0;
      n = 0;
    }
    if (p.v != null) {
      sum += p.v;
      n++;
    }
  }
  if (n > 0) out.push({ t: bStart + bucketMs / 2, v: sum / n });
  return out;
}

TrendBuffer.downsample = downsample;
module.exports = TrendBuffer;
