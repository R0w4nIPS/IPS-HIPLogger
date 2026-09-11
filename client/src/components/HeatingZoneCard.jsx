import Stat from './Stat.jsx';

// A heating zone's values at a glance: the two zone temperatures are the
// headline numbers, voltage/current/power/furnace output are supporting
// detail shown smaller underneath. `activeIndex` (0 = Zone A, 1 = Zone B,
// -1 = unknown) marks which zone's thermocouple is currently in use with a
// green vertical line, per the ActiveTC status tag. `secondaryRows` is an
// array of stat-row arrays -- usually just one (the zone's single power
// module), but a second row renders for zones with a second power module
// configured (see the Settings page's "Power Module 2" fields).
export default function HeatingZoneCard({ label, tags, latest, main, secondaryRows, activeIndex = -1 }) {
  return (
    <div className="zone-card">
      <div className="zone-card-title">{label}</div>
      <div className="zone-main-row">
        {main.map(({ tag, label: statLabel }, i) => (
          <Stat key={tag} label={statLabel} def={tags[tag]} value={latest[tag]} big active={i === activeIndex} />
        ))}
      </div>
      {secondaryRows.map((row, i) => (
        <div key={i} className="zone-sub-row">
          {row.map(({ tag, label: statLabel }) => (
            <Stat key={tag} label={statLabel} def={tags[tag]} value={latest[tag]} />
          ))}
        </div>
      ))}
    </div>
  );
}
