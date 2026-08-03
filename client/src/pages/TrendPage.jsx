import { useEffect, useMemo, useRef, useState } from 'react';
import TrendChart from '../components/TrendChart.jsx';
import ValueTile from '../components/ValueTile.jsx';
import TrendPicker from '../components/TrendPicker.jsx';
import TopNav from '../components/TopNav.jsx';

const SELECTED_TAGS_KEY = 's7trend.selectedTags';

const WINDOWS = [
  { label: '1 min', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
  { label: '1 h', seconds: 3600 },
  { label: '4 h', seconds: 4 * 3600 },
  { label: '8 h', seconds: 8 * 3600 },
  { label: '24 h', seconds: 24 * 3600 },
];

export default function TrendPage({ page, onNavigate, initialRange, onInitialRangeApplied }) {
  const [tags, setTags] = useState({});          // name -> {unit, decimals, color}
  const [enabled, setEnabled] = useState({});    // name -> bool
  // Which tags show as a tile/chart line at all -- narrower than `enabled`,
  // which only toggles a shown tile's chart line. Chosen via "Select Trends"
  // and persisted so a large tag list doesn't have to be re-curated on reload.
  const [selected, setSelected] = useState({});  // name -> bool
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState('connecting');
  const [windowSec, setWindowSec] = useState(300);
  const [paused, setPaused] = useState(false);
  const [latest, setLatest] = useState({});      // name -> value
  const [cursorReadout, setCursorReadout] = useState(null); // name -> {a, b, delta} | null
  const [cursorToolbar, setCursorToolbar] = useState({ visible: false, zoomed: false, dtLabel: '' });
  const chartRef = useRef(null);
  const [, forceRender] = useState(0);

  // Tags marked `trend: false` server-side (db1001 cycle/status signals)
  // are excluded here entirely -- no tile, no picker entry, no chart line,
  // no history fetch. They're still live on the Dashboard via `latest`.
  const trendableTags = useMemo(
    () => Object.fromEntries(Object.entries(tags).filter(([, def]) => def.trend !== false)),
    [tags]
  );

  // Sample store lives in a ref so WebSocket pushes don't re-render on
  // every message; a 500 ms ticker triggers chart updates instead.
  const store = useRef({});                      // name -> [{t, v}]
  // Set of trend-eligible tag names, read inside the WS 'sample' handler --
  // a ref (not the `tags` state) because that handler is defined once
  // inside a `useEffect(..., [])` closure and would otherwise only ever see
  // the empty `tags` from the very first render.
  const trendableNamesRef = useRef(new Set());
  const windowRef = useRef(windowSec);
  windowRef.current = windowSec;
  const pausedAtRef = useRef(Date.now());

  // Offset (ms) from pausedAtRef applied by dragging the trend while
  // paused, so the frozen window can be scrolled back/forward through
  // history without touching the live feed.
  const [panMs, setPanMs] = useState(0);

  // A user-picked absolute date/time range (see the "Go" form below).
  // customRangeRef holds the exact {from, to} in ms; customPoints holds the
  // fetched samples for it, kept separate from the rolling live `store` so
  // an old range can't get pruned by the live feed's 24 h trim.
  const [usingCustomRange, setUsingCustomRange] = useState(false);
  const customRangeRef = useRef(null);
  const customPoints = useRef({});
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  function enterPause() {
    pausedAtRef.current = Date.now();
    setPanMs(0);
  }

  function exitCustomRange() {
    setUsingCustomRange(false);
  }

  function exitToLive() {
    exitCustomRange();
    setPaused(false);
  }

  // Bound how far the paused window can be dragged: never past "now",
  // and never further back than the data the client actually buffers.
  // No-op while viewing a custom range -- panning it would need a new fetch.
  function handlePan(deltaMs) {
    if (usingCustomRange) return;
    setPanMs((prev) => {
      const now = Date.now();
      const minTo = now - 24 * 3600 * 1000 + windowRef.current * 1000;
      const proposedTo = pausedAtRef.current + prev + deltaMs;
      const clampedTo = Math.min(Math.max(proposedTo, minTo), now);
      return clampedTo - pausedAtRef.current;
    });
  }

  // ---- Jump to a specific date/time range -----------------------------------
  async function goToRange(fromMs, toMs) {
    setPaused(true);
    setUsingCustomRange(true);
    customRangeRef.current = { from: fromMs, to: toMs };
    await Promise.all(
      Object.keys(trendableTags).map(async (name) => {
        try {
          const res = await fetch(
            `/api/history?tag=${name}&from=${fromMs}&to=${toMs}&maxPoints=4000`
          );
          if (!res.ok) return;
          const data = await res.json();
          customPoints.current[name] = data.points;
        } catch {
          /* leave whatever was there before; chart will just look sparse */
        }
      })
    );
    forceRender((n) => n + 1);
  }

  function handleGoToRange(e) {
    e.preventDefault();
    if (!rangeFrom || !rangeTo) return;
    const fromMs = new Date(rangeFrom).getTime();
    const toMs = new Date(rangeTo).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
    goToRange(fromMs, toMs);
  }

  // ---- Jump to a cycle picked on the Cycles page ---------------------------
  // Waits for tag metadata (trendableTags) to arrive over the WebSocket
  // before fetching, since goToRange needs the tag list to know what to ask
  // the history API for.
  useEffect(() => {
    if (!initialRange || !Object.keys(trendableTags).length) return;
    goToRange(initialRange.from, initialRange.to);
    onInitialRangeApplied?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRange, trendableTags]);

  // ---- WebSocket live feed -------------------------------------------------
  useEffect(() => {
    let ws;
    let closed = false;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello') {
          setTags(msg.tags);
          setStatus(msg.status);
          setEnabled((prev) => {
            const next = { ...prev };
            for (const name of Object.keys(msg.tags)) {
              if (!(name in next)) next[name] = true;
            }
            return next;
          });
          setSelected((prev) => {
            let saved = null;
            try {
              saved = JSON.parse(localStorage.getItem(SELECTED_TAGS_KEY));
            } catch {
              /* ignore malformed/missing saved selection */
            }
            const next = { ...prev };
            for (const name of Object.keys(msg.tags)) {
              if (!(name in next)) next[name] = saved?.[name] ?? msg.tags[name].defaultActive ?? true;
            }
            return next;
          });
          const trendableNames = Object.keys(msg.tags).filter((name) => msg.tags[name].trend !== false);
          trendableNamesRef.current = new Set(trendableNames);
          for (const name of trendableNames) {
            if (!store.current[name]) store.current[name] = [];
          }
          backfill(trendableNames);
        } else if (msg.type === 'sample') {
          const cutoff = msg.t - 24 * 3600 * 1000;
          for (const [name, v] of Object.entries(msg.values)) {
            if (!trendableNamesRef.current.has(name)) continue; // not trended -- don't buffer history for it
            const arr = store.current[name] || (store.current[name] = []);
            arr.push({ t: msg.t, v });
            while (arr.length && arr[0].t < cutoff) arr.shift();
          }
          setLatest(msg.values);
        } else if (msg.type === 'status') {
          setStatus(msg.status);
        }
      };

      ws.onclose = () => {
        if (!closed) {
          setStatus('connecting');
          setTimeout(connect, 2000);
        }
      };
    }

    connect();
    return () => {
      closed = true;
      ws && ws.close();
    };
  }, []);

  // ---- History backfill on load -------------------------------------------
  async function backfill(tagNames) {
    await Promise.all(
      tagNames.map(async (name) => {
        try {
          const res = await fetch(`/api/history?tag=${name}&window=86400&maxPoints=4000`);
          if (!res.ok) return;
          const data = await res.json();
          // Merge: history first, then anything live already collected
          const live = store.current[name] || [];
          const lastHist = data.points.length ? data.points[data.points.length - 1].t : 0;
          store.current[name] = [...data.points, ...live.filter((p) => p.t > lastHist)];
        } catch {
          /* server not reachable yet; live feed will fill in */
        }
      })
    );
    forceRender((n) => n + 1);
  }

  // ---- Persist the trend selection across reloads ---------------------------
  useEffect(() => {
    if (!Object.keys(selected).length) return;
    try {
      localStorage.setItem(SELECTED_TAGS_KEY, JSON.stringify(selected));
    } catch {
      /* storage unavailable (private mode, quota, etc.) -- not critical */
    }
  }, [selected]);

  // ---- Render ticker (decoupled from message rate) -------------------------
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => forceRender((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [paused]);

  // ---- CSV export of the current window + enabled channels -----------------
  function exportCsv() {
    const active = Object.keys(trendableTags).filter((n) => selected[n] && enabled[n]);
    if (!active.length) return;
    const { from, to } =
      usingCustomRange && customRangeRef.current
        ? customRangeRef.current
        : { to: Date.now(), from: Date.now() - windowSec * 1000 };
    const url = `/api/export.csv?tags=${active.join(',')}&from=${from}&to=${to}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- Assemble chart data for the active window ---------------------------
  const chartData = useMemo(() => {
    let from, to, source;
    if (usingCustomRange && customRangeRef.current) {
      ({ from, to } = customRangeRef.current);
      source = customPoints.current;
    } else {
      to = paused ? pausedAtRef.current + panMs : Date.now();
      from = to - windowRef.current * 1000;
      source = store.current;
    }
    const activeNames = Object.keys(trendableTags).filter((n) => selected[n] && enabled[n]);
    return { from, to, series: activeNames.map((name) => ({
      name,
      color: trendableTags[name].color,
      unit: trendableTags[name].unit,
      decimals: trendableTags[name].decimals,
      points: (source[name] || []).filter((p) => p.t >= from && p.t <= to),
    })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendableTags, enabled, selected, windowSec, paused, latest, panMs, usingCustomRange]);

  return (
    <div className="app">
      <TopNav page={page} onNavigate={onNavigate} status={status} />

      <div className="main-body">
        <aside className="tiles">
          <button
            className="select-trends"
            onClick={() => setPickerOpen(true)}
            title="Choose which tags show as tiles and chart lines"
          >
            ☰ Select Trends
          </button>
          {Object.entries(trendableTags)
            .filter(([name]) => selected[name])
            .map(([name, def]) => (
            <ValueTile
              key={name}
              name={name}
              def={def}
              value={latest[name]}
              enabled={enabled[name]}
              cursor={cursorReadout?.[name]}
              onToggle={() => setEnabled((e) => ({ ...e, [name]: !e[name] }))}
            />
          ))}
        </aside>

        <section className="chart-area">
          <TrendChart
            ref={chartRef}
            data={chartData}
            paused={paused}
            panMs={panMs}
            onPan={handlePan}
            onResetPan={() => setPanMs(0)}
            customRange={usingCustomRange ? customRangeRef.current : null}
            onExitCustomRange={exitToLive}
            onCursorReadout={setCursorReadout}
            onCursorToolbarState={setCursorToolbar}
          />
        </section>
      </div>

      <footer className="bottombar">
        <div className="window-select" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w.seconds}
              className={!usingCustomRange && w.seconds === windowSec ? 'active' : ''}
              onClick={() => {
                exitCustomRange();
                setWindowSec(w.seconds);
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
        <form className="range-select" onSubmit={handleGoToRange}>
          <input
            type="datetime-local"
            step="1"
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value)}
            aria-label="Range start"
            required
          />
          <span className="range-sep">→</span>
          <input
            type="datetime-local"
            step="1"
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value)}
            aria-label="Range end"
            required
          />
          <button type="submit">Go</button>
        </form>
        {cursorToolbar.visible && (
          <div className="cursor-toolbar">
            <span className="cursor-dt">Δt {cursorToolbar.dtLabel}</span>
            <button type="button" onClick={() => chartRef.current?.zoom()} title="Zoom the trend to the A–B range">
              Zoom
            </button>
            <button type="button" onClick={() => chartRef.current?.reset()}>Reset</button>
            {cursorToolbar.zoomed && (
              <button type="button" onClick={() => chartRef.current?.exitZoom()}>↺ Exit zoom</button>
            )}
          </div>
        )}
        <button
          className={`pause ${paused ? 'is-paused' : ''}`}
          onClick={() => {
            if (!paused) enterPause();
            else exitCustomRange();
            setPaused(!paused);
          }}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          className="export"
          onClick={exportCsv}
          title="Download the current window and visible channels as CSV"
        >
          ↓ CSV
        </button>
      </footer>

      {pickerOpen && (
        <TrendPicker
          tags={trendableTags}
          selected={selected}
          onChange={setSelected}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
