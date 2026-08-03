import { useEffect, useMemo, useRef, useState } from 'react';
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

  // True while a name/batch code/operator field is focused, so the 5 s poll
  // below doesn't clobber an in-progress edit with the pre-edit server value.
  const editingRef = useRef(false);
  // Mirrors `cycles`. updateLocalField/saveMeta/handleDelete below write to
  // this directly with plain JS (not just via the effect here) so it's
  // always current the instant they return -- a field's onBlur can fire
  // (moving focus to the next field) before React has even re-rendered with
  // the previous field's just-typed value, let alone committed it, so
  // reading from `cycles` state itself at that point would still be stale.
  const cyclesRef = useRef(null);
  useEffect(() => {
    cyclesRef.current = cycles;
  }, [cycles]);

  // Poll rather than open a WebSocket -- this page has no live tag data to
  // stream, just an occasionally-changing list plus the PLC status badge.
  useEffect(() => {
    let cancelled = false;

    async function loadCycles() {
      try {
        const qs = appliedRange ? `?from=${appliedRange.from}&to=${appliedRange.to}` : '';
        const res = await fetch(`/api/cycles${qs}`);
        if (!res.ok || cancelled || editingRef.current) return;
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

  // Reflect a keystroke immediately in the table; the actual save happens
  // on blur (see saveMeta), not on every keystroke.
  // Mutates cyclesRef with plain JS *before* calling setCycles, rather than
  // inside its updater function -- React 18 can defer running a setState
  // updater until its next batched render, so writing to the ref there
  // isn't actually synchronous either. Tabbing quickly between fields (the
  // next field's blur firing right after this field's onChange) needs the
  // ref to be correct the instant this function returns, not whenever React
  // gets around to it.
  function updateLocalField(id, field, value) {
    if (!cyclesRef.current) return;
    const next = cyclesRef.current.map((c) => (c.id === id ? { ...c, [field]: value } : c));
    cyclesRef.current = next;
    setCycles(next);
  }

  // Always sends the row's full current name/batchCode/operator, not a
  // partial diff, so the server side can stay a plain UPDATE.
  // Deliberately doesn't apply the response back into cycles/cyclesRef: the
  // response only echoes what was just sent, and local state may already be
  // *newer* than that by the time it arrives (the user kept typing into
  // another field on the same row while this request was in flight) --
  // applying a stale echo over a newer local edit would erase it. Local
  // state is the source of truth here; the response is just an ack.
  async function saveMeta(cycle) {
    try {
      await fetch(`/api/cycles/${cycle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cycle.name || '',
          batchCode: cycle.batchCode || '',
          operator: cycle.operator || '',
        }),
      });
    } catch {
      /* leave the typed value in place; next successful edit will retry the save */
    }
  }

  async function handleDelete(id) {
    try {
      const res = await fetch(`/api/cycles/${id}`, { method: 'DELETE' });
      if (!res.ok || !cyclesRef.current) return;
      const next = cyclesRef.current.filter((c) => c.id !== id);
      cyclesRef.current = next;
      setCycles(next);
    } catch {
      /* leave the row; user can retry the delete */
    }
  }

  // One editable cell shared by the Name/Batch Code/Operator columns.
  // stopPropagation on both handlers keeps typing/Enter from also
  // triggering the row's onClick/onKeyDown (which opens the Trend view).
  function metaCell(cycle, field, placeholder) {
    return (
      <td className="cycles-meta-cell" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <input
          className="cycles-meta-input"
          value={cycle[field] || ''}
          placeholder={placeholder}
          onChange={(e) => updateLocalField(cycle.id, field, e.target.value)}
          onFocus={() => {
            editingRef.current = true;
          }}
          onBlur={() => {
            editingRef.current = false;
            const current = cyclesRef.current?.find((c) => c.id === cycle.id) ?? cycle;
            saveMeta(current);
          }}
        />
      </td>
    );
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
                <th>Name</th>
                <th>Batch Code</th>
                <th>Operator</th>
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
                    {metaCell(c, 'name', 'Name')}
                    {metaCell(c, 'batchCode', 'Batch code')}
                    {metaCell(c, 'operator', 'Operator')}
                    <td className="cycles-actions-cell">
                      <div className="cycles-csv-cell">
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
                        <button
                          type="button"
                          className="cycles-csv-btn cycles-delete-btn"
                          title="Delete this cycle"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Delete the cycle starting ${formatDateTime(c.from)}? This cannot be undone.`)) {
                              handleDelete(c.id);
                            }
                          }}
                        >
                          ✕ Delete
                        </button>
                      </div>
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
