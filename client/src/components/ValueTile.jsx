import { statusLabel, formatTagName } from '../lib/tagFormat.js';

function fmtVal(v, decimals, signed = false) {
  if (v == null || Number.isNaN(v)) return '–';
  const s = v.toFixed(decimals);
  return signed && v > 0 ? `+${s}` : s;
}

export default function ValueTile({ name, def, value, enabled, cursor, onToggle, readOnly = false }) {
  const isStatus = def.kind === 'bool' || def.kind === 'enum';
  const decimals = def.decimals ?? 1;
  const display = isStatus
    ? statusLabel(def, value).text
    : value == null || value === undefined
    ? '––'
    : Number(value).toFixed(decimals);
  const level = isStatus ? statusLabel(def, value).level : null;

  const content = (
    <>
      <span className="tile-name">{formatTagName(name)}</span>
      <span className={`tile-value${isStatus ? ' tile-value-status' : ''}${level ? ` status-${level}` : ''}`}>
        {display}
        {!isStatus && def.unit && <span className="tile-unit"> {def.unit}</span>}
      </span>
      {cursor && !isStatus && (
        <span className="tile-cursor">
          <span className="tile-cursor-chip" style={{ background: '#b45309' }}>A</span>
          {fmtVal(cursor.a, decimals)}
          <span className="tile-cursor-chip" style={{ background: '#0e6ea3' }}>B</span>
          {fmtVal(cursor.b, decimals)}
          <span className="tile-cursor-delta">Δ {fmtVal(cursor.delta, decimals, true)}</span>
        </span>
      )}
      {cursor && isStatus && (
        <span className="tile-cursor">
          <span className="tile-cursor-chip" style={{ background: '#b45309' }}>A</span>
          {statusLabel(def, cursor.a).text}
          <span className="tile-cursor-chip" style={{ background: '#0e6ea3' }}>B</span>
          {statusLabel(def, cursor.b).text}
        </span>
      )}
      <span className="tile-bar" />
    </>
  );

  if (readOnly) {
    return (
      <div className="tile tile-static" style={{ '--ch': def.color }}>
        {content}
      </div>
    );
  }

  return (
    <button
      className={`tile ${enabled ? '' : 'tile-off'}`}
      onClick={onToggle}
      style={{ '--ch': def.color }}
      title={enabled ? 'Click to hide from chart' : 'Click to show on chart'}
    >
      {content}
    </button>
  );
}
