import { statusLabel } from '../lib/tagFormat.js';

// One labeled value within a card (HeatingZoneCard, CycleCard): a numeric
// reading with unit, or -- for bool/enum tags -- a status label colored by
// its level (ok/warn/bad). `active` marks the value currently selected by
// some other signal (e.g. which zone's thermocouple is in use) with a
// green vertical line -- distinct from per-tag color, which was removed.
export default function Stat({ label, def, value, big, active }) {
  const isStatus = def?.kind === 'bool' || def?.kind === 'enum';
  let display, level;
  if (isStatus) {
    ({ text: display, level } = statusLabel(def, value));
  } else {
    const decimals = def?.decimals ?? 1;
    display = value == null ? '––' : Number(value).toFixed(decimals);
  }

  const className = [
    'zone-stat',
    big && 'zone-stat-main',
    active && 'zone-stat-active',
  ].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <span className="zone-stat-label">{label}</span>
      <span className={`zone-stat-value${level ? ` status-${level}` : ''}`}>
        {display}
        {!isStatus && def?.unit && <span className="zone-stat-unit"> {def.unit}</span>}
      </span>
    </div>
  );
}
