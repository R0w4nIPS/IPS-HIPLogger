import { formatTagName } from '../lib/tagFormat.js';

export default function TrendPicker({ tags, selected, onChange, onClose }) {
  const names = Object.keys(tags);

  function setAll(value) {
    onChange(Object.fromEntries(names.map((n) => [n, value])));
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-panel" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span>Select Trends</span>
          <button type="button" className="picker-close" onClick={onClose}>✕</button>
        </div>
        <div className="picker-actions">
          <button type="button" onClick={() => setAll(true)}>Select all</button>
          <button type="button" onClick={() => setAll(false)}>Clear all</button>
        </div>
        <div className="picker-list">
          {names.map((name) => (
            <label key={name} className="picker-item">
              <input
                type="checkbox"
                checked={!!selected[name]}
                onChange={(e) => onChange({ ...selected, [name]: e.target.checked })}
              />
              <span className="picker-swatch" style={{ background: tags[name].color }} />
              {formatTagName(name)}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
