// bool/enum tags: raw value -> { text, level } via def.labels, falling back
// to the raw number if it's not a recognized state. Shared by ValueTile,
// HeatingZoneCard and CycleCard so status formatting stays consistent.
export function statusLabel(def, value) {
  if (value == null) return { text: '––' };
  const entry = def.labels?.[Math.round(value)];
  return entry ?? { text: String(value) };
}

// Tag name -> display label: underscores and camelCase word boundaries both
// become spaces, so "Vessel_Pressure" and "CoolingRunning" both read as
// separate words ("TC"-style acronyms are left intact).
export function formatTagName(name) {
  return name.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// ms -> compact human duration ("1h 02m", "3m 05s", "42s"). Shared by
// TrendChart (Δt readout) and the Cycles page (cycle duration column).
export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${hh}h ${String(mm).padStart(2, '0')}m`;
  if (mm > 0) return `${mm}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

// ms epoch -> "DD/MM/YYYY HH:MM:SS" (or "DD/MM/YYYY HH:MM" with
// includeSeconds: false), always this order and always 24h -- built from
// the raw date parts rather than toLocaleString, whose day/month order and
// 12h/24h choice otherwise follow the OS locale and would drift from what's
// asked for here. Shared by the Cycles page, the cycle report and the
// Trend page's custom-range badge.
export function formatDateTime(t, { includeSeconds = true } = {}) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  const time = includeSeconds
    ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${date} ${time}`;
}
