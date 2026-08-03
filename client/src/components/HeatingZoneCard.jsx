import Stat from './Stat.jsx';

// A heating zone's 6 values at a glance: the two zone temperatures are the
// headline numbers, voltage/current/power/furnace output are supporting
// detail shown smaller underneath. `activeIndex` (0 = Zone A, 1 = Zone B,
// -1 = unknown) marks which zone's thermocouple is currently in use with a
// green vertical line, per the ActiveTC status tag.
export default function HeatingZoneCard({ label, tags, latest, main, secondary, activeIndex = -1 }) {
  return (
    <div className="zone-card">
      <div className="zone-card-title">{label}</div>
      <div className="zone-main-row">
        {main.map(({ tag, label: statLabel }, i) => (
          <Stat key={tag} label={statLabel} def={tags[tag]} value={latest[tag]} big active={i === activeIndex} />
        ))}
      </div>
      <div className="zone-sub-row">
        {secondary.map(({ tag, label: statLabel }) => (
          <Stat key={tag} label={statLabel} def={tags[tag]} value={latest[tag]} />
        ))}
      </div>
    </div>
  );
}
