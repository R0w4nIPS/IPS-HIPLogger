import { useEffect, useMemo, useState } from 'react';
import TopNav from '../components/TopNav.jsx';
import { formatDuration, formatDateTime } from '../lib/tagFormat.js';

// List of every logged cycle (a LoggingOnOff true..false span), most recent
// first. Clicking a row hands its {from, to} range up to the Trend page via
// onSelectCycle, so the trend for that exact cycle can be inspected.
export default function CyclesPage({ page, onNavigate, onSelectCycle }) {
  const [cycles, setCycles] = useState(null); // null while loading
  const [status, setStatus] = useState('connecting');
  const [tags, setTags] = useState({});

  // The date/time search form's raw input values...
  const [searchFrom, setSearchFrom] = useState('');
  const [searchTo, setSearchTo] = useState('');
  // ...vs the range actually applied to /api/cycles, set on submit so
  // typing doesn't refetch on every keystroke.
  const [appliedRange, setAppliedRange] = useState(null); // {from, to} in ms | null

  // Tag metadata, fetched once, just to build the CSV export's tag list --
  // only the tags actually written to SQLite (trend !== false excludes the
  // db1001 cycle/status signals, which are also `log: false` server-side).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/tags')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !cancelled) setTags(data);
      })
      .catch(() => {
        /* CSV links just won't have a tags param -- server defaults to all */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loggableTagNames = useMemo(
    () => Object.keys(tags).filter((name) => tags[name].trend !== false),
    [tags]
  );

  // Poll rather than open a WebSocket -- this page has no live tag data to
  // stream, just an occasionally-changing list plus the PLC status badge.
  useEffect(() => {
    let cancelled = false;

    async function loadCycles() {
      try {
        const qs = appliedRange ? `?from=${appliedRange.from}&to=${appliedRange.to}` : '';
        const res = await fetch(`/api/cycles${qs}`);
        if (!res.ok || cancelled) return;
        setCycles(await res.json());
      } catch {
        /* keep showing whatever was last loaded */
      }
    }
    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        setStatus(data.plc);
      } catch {
        /* leave last known status */
      }
    }

    setCycles(null);
    loadCycles();
    loadStatus();
    const id = setInterval(() => {
      loadCycles();
      loadStatus();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [appliedRange]);

  function handleSearch(e) {
    e.preventDefault();
    if (!searchFrom && !searchTo) {
      setAppliedRange(null);
      return;
    }
    const fromMs = searchFrom ? new Date(searchFrom).getTime() : null;
    const toMs = searchTo ? new Date(searchTo).getTime() : null;
    setAppliedRange({ from: fromMs ?? 0, to: toMs ?? Date.now() });
  }

  function clearSearch() {
    setSearchFrom('');
    setSearchTo('');
    setAppliedRange(null);
  }

  function csvUrl(from, to) {
    const tagsParam = loggableTagNames.length ? `tags=${loggableTagNames.join(',')}&` : '';
    return `/api/export.csv?${tagsParam}from=${from}&to=${to}`;
  }

  return (
    <div className="app">
      <TopNav page={page} onNavigate={onNavigate} status={status} />

      <div className="cycles-body">
        <div className="cycles-head">
          <h2 className="dashboard-group-title">Cycles</h2>
          <form className="cycles-search" onSubmit={handleSearch}>
            <input
              type="datetime-local"
              step="1"
              value={searchFrom}
              onChange={(e) => setSearchFrom(e.target.value)}
              aria-label="Search from"
            />
            <span className="range-sep">→</span>
            <input
              type="datetime-local"
              step="1"
              value={searchTo}
              onChange={(e) => setSearchTo(e.target.value)}
              aria-label="Search to"
            />
            <button type="submit">Search</button>
            {appliedRange && (
              <button type="button" onClick={clearSearch}>
                Clear
              </button>
            )}
          </form>
        </div>

        {cycles == null ? (
          <p className="cycles-empty">Loading…</p>
        ) : cycles.length === 0 ? (
          <p className="cycles-empty">
            {appliedRange ? 'No cycles in that range.' : 'No cycles logged yet.'}
          </p>
        ) : (
          <table className="cycles-table">
            <thead>
              <tr>
                <th>Start</th>
                <th>End</th>
                <th>Duration</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => {
                const running = c.to == null;
                const end = c.to ?? Date.now();
                return (
                  <tr
                    key={c.id}
                    className="cycles-row"
                    tabIndex={0}
                    onClick={() => onSelectCycle({ from: c.from, to: end })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectCycle({ from: c.from, to: end });
                      }
                    }}
                  >
                    <td>{formatDateTime(c.from)}</td>
                    <td>{running ? '—' : formatDateTime(c.to)}</td>
                    <td>{formatDuration(end - c.from)}</td>
                    <td>
                      <span className={`cycle-status ${running ? 'running' : 'done'}`}>
                        {running ? 'Running' : 'Complete'}
                      </span>
                    </td>
                    <td className="cycles-csv-cell">
                      <button
                        type="button"
                        className="cycles-csv-btn"
                        title="Open a printable report for this cycle"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigate(`/cycles/${c.id}/report`);
                        }}
                      >
                        Report
                      </button>
                      <a
                        className="cycles-csv-btn"
                        href={csvUrl(c.from, end)}
                        title="Download this cycle as CSV"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ↓ CSV
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
