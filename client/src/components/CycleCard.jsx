import Stat from './Stat.jsx';

// The cycle's core status values in one glanceable card -- unlike
// HeatingZoneCard there's no headline/detail split, all six are equally
// important, so they're laid out uniformly in a grid.
export default function CycleCard({ tags, latest, items }) {
  return (
    <div className="zone-card">
      <div className="cycle-grid">
        {items.map(({ tag, label }) => (
          <Stat key={tag} label={label} def={tags[tag]} value={latest[tag]} />
        ))}
      </div>
    </div>
  );
}
