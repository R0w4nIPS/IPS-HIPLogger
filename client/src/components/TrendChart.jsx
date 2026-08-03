import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import { formatDuration, formatDateTime } from '../lib/tagFormat.js';

const CURSOR_COLOR = ['#b45309', '#0e6ea3'];

// Must match the LineChart's margin.left + YAxis width, and margin.right,
// below -- used to map raw mouse pixels to a time value continuously
// (Recharts' own activeLabel snaps to the nearest actual data point,
// which feels jumpy once cursors span a range with few visible samples).
const PLOT_LEFT_PX = 56;
const PLOT_RIGHT_PX = 24;

function fmtTime(t, spanMs) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return spanMs <= 15 * 60 * 1000 ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

// Full HH:MM:SS, always 24h -- used for the hover tooltip's timestamp,
// which (unlike the X-axis ticks above) always wants full precision
// regardless of the visible span.
function fmtTooltipTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

// The Y axis's top/bottom ticks are the exact yDomain boundary (an
// unrounded float, e.g. from `max + pad`), unlike Recharts' own in-between
// "nice" ticks -- round it for display so it doesn't overflow the axis
// label width with raw floating-point digits.
function fmtAxisNumber(v) {
  const rounded = Math.round(v * 10) / 10;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
}

// Linear-interpolate the value of a sorted {t,v}[] series at time t.
function valueAt(points, t) {
  if (!points || !points.length) return null;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const p0 = points[lo];
  const p1 = points[hi];
  if (p1.t === p0.t) return p0.v;
  const frac = (t - p0.t) / (p1.t - p0.t);
  return p0.v + (p1.v - p0.v) * frac;
}

// Small draggable grab-handle rendered above the plot area for a cursor line.
function CursorHandle({ viewBox, text, color, onGrab }) {
  if (!viewBox) return null;
  const { x, y } = viewBox;
  return (
    <g
      transform={`translate(${x}, ${y})`}
      style={{ cursor: 'ew-resize' }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onGrab();
      }}
    >
      <rect x={-9} y={-15} width={18} height={14} rx={3} fill={color} />
      <text
        x={0}
        y={-5}
        textAnchor="middle"
        fontSize={9}
        fontWeight={700}
        fill="#ffffff"
        fontFamily="IBM Plex Mono, monospace"
      >
        {text}
      </text>
    </g>
  );
}

function fmtRangeLabel(range) {
  const opts = { includeSeconds: false };
  return `${formatDateTime(range.from, opts)} → ${formatDateTime(range.to, opts)}`;
}

const TrendChart = forwardRef(function TrendChart(
  {
    data,
    paused = false,
    panMs = 0,
    onPan,
    onResetPan,
    customRange = null,
    onExitCustomRange,
    onCursorReadout,
    onCursorToolbarState,
    // Set false for a static, read-only chart (e.g. the cycle report) --
    // suppresses the draggable A/B cursor lines but keeps pan/zoom disabled
    // regardless via the existing `paused` gate.
    interactive = true,
  },
  ref
) {
  const { from, to, series } = data;
  const rawSpanMs = to - from;

  // Per-tag decimal precision for the hover tooltip -- without this,
  // Recharts prints each series' raw float (which can carry many more
  // digits than the tag's configured precision, e.g. sensor noise).
  const decimalsByName = useMemo(
    () => Object.fromEntries(series.map((s) => [s.name, s.decimals ?? 1])),
    [series]
  );

  // Merge all series into row objects keyed by timestamp, so Recharts
  // can draw multiple lines against one shared X axis.
  const rows = useMemo(() => {
    const map = new Map();
    for (const s of series) {
      for (const p of s.points) {
        let row = map.get(p.t);
        if (!row) {
          row = { t: p.t };
          map.set(p.t, row);
        }
        row[s.name] = p.v;
      }
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [series]);

  // Zoom range (absolute timestamps), set by "Zoom" to the current A–B
  // cursor span. Null means "show the full window". Cleared whenever the
  // outer time-window selection changes.
  const [zoom, setZoom] = useState(null);
  useEffect(() => {
    setZoom(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSpanMs]);

  const viewFrom = zoom ? zoom[0] : from;
  const viewTo = zoom ? zoom[1] : to;
  const viewSpan = viewTo - viewFrom;

  // Bound what actually reaches Recharts to the visible range. Without
  // this, rows outside [viewFrom, viewTo] (e.g. live samples that keep
  // arriving while paused, or data outside a zoomed A-B range) would
  // still push the X/Y auto-scaling past the intended view.
  const visibleRows = useMemo(
    () => rows.filter((r) => r.t >= viewFrom && r.t <= viewTo),
    [rows, viewFrom, viewTo]
  );

  // Recharts' own domain={['auto','auto']} picks "nice" round tick bounds
  // that can overshoot well past the real data (e.g. a -350 floor under
  // data that never goes below 0), especially once more points/series are
  // in view at the wider 8h/24h windows. Deriving the domain from the
  // actually-visible values instead keeps it padded but tied to reality --
  // and never dips below 0 unless the data itself does.
  const yDomain = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const row of visibleRows) {
      for (const s of series) {
        const v = row[s.name];
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return ['auto', 'auto'];
    if (min === max) return [min - 1, max + 1];
    const pad = (max - min) * 0.08;
    const lo = min >= 0 ? Math.max(0, min - pad) : min - pad;
    return [lo, max + pad];
  }, [visibleRows, series]);

  // Cursor positions (timestamps). Re-centered whenever the visible span
  // changes (window length change, or entering/exiting zoom); otherwise
  // just kept clamped inside the current view so a live-sliding window
  // doesn't leave them stranded outside it.
  const [cursors, setCursors] = useState(null);
  const [dragging, setDragging] = useState(null); // 0 | 1 | null
  const plotRef = useRef(null);
  const showCursors = interactive && cursors && rows.length >= 2;

  // Click-and-drag panning, active only while paused. Dragging the plot
  // background (not a cursor handle -- those stopPropagation) slides the
  // zoomed sub-range if one is active, otherwise scrolls the outer window
  // via onPan, which the parent clamps against "now" and its history buffer.
  const [panDragging, setPanDragging] = useState(false);
  const panLastXRef = useRef(null);

  function handlePlotMouseDown(e) {
    if (!paused) return;
    panLastXRef.current = e.clientX;
    setPanDragging(true);
  }

  useEffect(() => {
    if (!panDragging) return undefined;

    function onMove(e) {
      const rect = plotRef.current?.getBoundingClientRect();
      if (!rect || panLastXRef.current == null) return;
      const plotWidth = rect.width - PLOT_LEFT_PX - PLOT_RIGHT_PX;
      if (plotWidth <= 0) return;

      const deltaPx = e.clientX - panLastXRef.current;
      panLastXRef.current = e.clientX;
      // Dragging right reveals earlier data, like pulling a paper strip chart.
      const deltaMs = -(deltaPx / plotWidth) * viewSpan;

      if (zoom) {
        setZoom(([a, b]) => {
          const span = b - a;
          let na = a + deltaMs;
          let nb = b + deltaMs;
          if (na < from) { na = from; nb = from + span; }
          if (nb > to) { nb = to; na = to - span; }
          return [na, nb];
        });
      } else if (onPan) {
        onPan(deltaMs);
      }
    }
    function onUp() {
      setPanDragging(false);
      panLastXRef.current = null;
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [panDragging, viewSpan, from, to, zoom, onPan]);

  useEffect(() => {
    setCursors((prev) => {
      if (!prev) return [viewFrom + viewSpan * 0.25, viewFrom + viewSpan * 0.75];
      return [clamp(prev[0], viewFrom, viewTo), clamp(prev[1], viewFrom, viewTo)];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewFrom, viewTo]);

  useEffect(() => {
    setCursors([viewFrom + viewSpan * 0.25, viewFrom + viewSpan * 0.75]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewSpan]);

  // Drag tracked via raw pointer position against the plot's own DOM box,
  // not Recharts' mouse state -- its activeLabel snaps to the nearest
  // actual data point (jumpy with sparse/zoomed data), and its mouse
  // tracking only fires while the pointer is over the plot area itself,
  // which excludes the margin strip the drag handles are drawn in.
  useEffect(() => {
    if (dragging == null) return undefined;

    function pixelToTime(clientX) {
      const rect = plotRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const left = rect.left + PLOT_LEFT_PX;
      const right = rect.right - PLOT_RIGHT_PX;
      if (right <= left) return null;
      const frac = clamp((clientX - left) / (right - left), 0, 1);
      return viewFrom + frac * viewSpan;
    }

    function onMove(e) {
      const v = pixelToTime(e.clientX);
      if (v == null) return;
      setCursors((c) => {
        const next = [...c];
        next[dragging] = v;
        return next;
      });
    }
    function onUp() {
      setDragging(null);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, viewFrom, viewSpan]);

  function handleZoom() {
    if (!cursors) return;
    const a = Math.min(cursors[0], cursors[1]);
    const b = Math.max(cursors[0], cursors[1]);
    if (b - a < 1000) return; // guard against a degenerate/zero-width range
    setZoom([a, b]);
  }

  function resetCursors() {
    setCursors([viewFrom + viewSpan * 0.25, viewFrom + viewSpan * 0.75]);
  }

  // Zoom/Reset/Exit-zoom live in the bottom bar (see App.jsx), not here, so
  // expose the actions imperatively and report state for those buttons.
  useImperativeHandle(ref, () => ({
    zoom: handleZoom,
    reset: resetCursors,
    exitZoom: () => setZoom(null),
  }));

  // Scroll-wheel zoom, active only while paused. Zooms around the time
  // under the cursor rather than the view's center, like a map zoom.
  // Attached as a native listener (not React's onWheel, which is passive)
  // so preventDefault actually stops the page from scrolling underneath.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return undefined;

    function onWheel(e) {
      if (!paused) return;
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const plotWidth = rect.width - PLOT_LEFT_PX - PLOT_RIGHT_PX;
      if (plotWidth <= 0) return;

      const frac = clamp((e.clientX - rect.left - PLOT_LEFT_PX) / plotWidth, 0, 1);
      const pivot = viewFrom + frac * viewSpan;

      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15; // scroll down = zoom out
      const baseA = zoom ? zoom[0] : from;
      const baseB = zoom ? zoom[1] : to;
      const fullSpan = to - from;
      const newSpan = clamp((baseB - baseA) * factor, 1000, fullSpan);

      let newA = pivot - (pivot - baseA) * (newSpan / (baseB - baseA));
      let newB = newA + newSpan;
      // Stay inside the fetched window -- there's no data beyond it to show.
      if (newA < from) { newA = from; newB = from + newSpan; }
      if (newB > to) { newB = to; newA = to - newSpan; }

      setZoom(newSpan >= fullSpan - 1 ? null : [newA, newB]);
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [paused, zoom, from, to, viewFrom, viewSpan]);

  // Report each series' A/B cursor values (and delta) up to the parent, so
  // the value tiles in the left sidebar can show them in a smaller font
  // next to the live reading.
  useEffect(() => {
    if (!onCursorReadout) return;
    if (!showCursors) {
      onCursorReadout(null);
      return;
    }
    const readout = {};
    for (const s of series) {
      const a = valueAt(s.points, cursors[0]);
      const b = valueAt(s.points, cursors[1]);
      readout[s.name] = { a, b, delta: a != null && b != null ? b - a : null };
    }
    onCursorReadout(readout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursors, series, showCursors]);

  // Report whether the Zoom/Reset/Exit-zoom bottom-bar buttons should be
  // shown/enabled, and the current A-B time span for their Δt label.
  useEffect(() => {
    if (!onCursorToolbarState) return;
    onCursorToolbarState(
      showCursors
        ? { visible: true, zoomed: zoom != null, dtLabel: formatDuration(Math.abs(cursors[1] - cursors[0])) }
        : { visible: false, zoomed: false, dtLabel: '' }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCursors, zoom, cursors]);

  if (!series.length) {
    return <div className="chart-empty">Select at least one channel on the left to trend it.</div>;
  }

  return (
    <div
      ref={plotRef}
      className="trend-plot"
      onMouseDown={handlePlotMouseDown}
      style={{
        userSelect: dragging != null || panDragging ? 'none' : 'auto',
        cursor: paused ? (panDragging ? 'grabbing' : 'grab') : 'default',
      }}
    >
      {paused && panMs !== 0 && (
        <button type="button" className="pan-recenter" onClick={onResetPan}>
          ↺ Recenter
        </button>
      )}
      {customRange && (
        <div className="range-badge">
          <span>{fmtRangeLabel(customRange)}</span>
          <button type="button" onClick={onExitCustomRange}>▶ Live</button>
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={visibleRows} margin={{ top: 22, right: 24, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={[viewFrom, viewTo]}
            allowDataOverflow
            tickFormatter={(t) => fmtTime(t, viewSpan)}
            stroke="var(--axis)"
            tick={{ fill: 'var(--axis)', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}
            tickCount={8}
          />
          <YAxis
            stroke="var(--axis)"
            tick={{ fill: 'var(--axis)', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}
            width={56}
            domain={yDomain}
            tickFormatter={fmtAxisNumber}
            allowDataOverflow
          />
          <Tooltip
            isAnimationActive={false}
            labelFormatter={(t) => fmtTooltipTime(t)}
            formatter={(value, name) => [
              typeof value === 'number' ? value.toFixed(decimalsByName[name] ?? 1) : value,
              name,
            ]}
            contentStyle={{
              background: 'var(--panel)',
              border: '1px solid var(--edge)',
              borderRadius: 6,
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s) => (
            <Line
              key={s.name}
              type="linear"
              dataKey={s.name}
              stroke={s.color}
              dot={false}
              strokeWidth={1.6}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {showCursors && (
            <>
              <ReferenceLine
                x={cursors[0]}
                stroke={CURSOR_COLOR[0]}
                strokeWidth={1.4}
                strokeDasharray="4 3"
                isFront
                label={(props) => (
                  <CursorHandle {...props} text="A" color={CURSOR_COLOR[0]} onGrab={() => setDragging(0)} />
                )}
              />
              <ReferenceLine
                x={cursors[1]}
                stroke={CURSOR_COLOR[1]}
                strokeWidth={1.4}
                strokeDasharray="4 3"
                isFront
                label={(props) => (
                  <CursorHandle {...props} text="B" color={CURSOR_COLOR[1]} onGrab={() => setDragging(1)} />
                )}
              />
            </>
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
});

export default TrendChart;
