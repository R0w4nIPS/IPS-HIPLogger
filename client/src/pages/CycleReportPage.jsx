import { useEffect, useMemo, useState } from 'react';
import TrendChart from '../components/TrendChart.jsx';
import { formatDuration, formatTagName, formatDateTime } from '../lib/tagFormat.js';

// Min/max over a {t,v}[] series, ignoring bad (null) reads.
function summarize(points) {
  let min = null;
  let max = null;
  let n = 0;
  for (const p of points) {
    if (p.v == null) continue;
    if (min == null || p.v < min) min = p.v;
    if (max == null || p.v > max) max = p.v;
    n++;
  }
  return { min, max, count: n };
}

// A single printable page for one cycle: metadata, a static trend chart of
// the tags shown by default elsewhere in the app, and a min/max summary
// table for every logged tag. "Print / Save as PDF" just calls the browser's
// native print dialog -- no server-side PDF generation, so it works offline
// and needs no extra dependency.
export default function CycleReportPage({ cycleId, onNavigate }) {
  const [cycle, setCycle] = useState(null); // {id, from, to} | null | 'error'
  const [tags, setTags] = useState({});
  const [series, setSeries] = useState(null); // name -> [{t,v}]

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [cycleRes, tagsRes] = await Promise.all([
        fetch(`/api/cycles/${cycleId}`),
        fetch('/api/tags'),
      ]);
      if (cancelled) return;
      if (!cycleRes.ok) {
        setCycle('error');
        return;
      }
      const cycleData = await cycleRes.json();
      const tagsData = tagsRes.ok ? await tagsRes.json() : {};
      if (cancelled) return;
      setCycle(cycleData);
      setTags(tagsData);

      const to = cycleData.to ?? Date.now();
      const loggable = Object.keys(tagsData).filter((name) => tagsData[name].trend !== false);
      const results = await Promise.all(
        loggable.map(async (name) => {
          try {
            const res = await fetch(
              `/api/history?tag=${name}&from=${cycleData.from}&to=${to}&maxPoints=4000`
            );
            if (!res.ok) return [name, []];
            const data = await res.json();
            return [name, data.points];
          } catch {
            return [name, []];
          }
        })
      );
      if (!cancelled) setSeries(Object.fromEntries(results));
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [cycleId]);

  // The chart shows only the tags marked `defaultActive` in config (the
  // same curated set the Trend page opens with out of the box) -- plotting
  // all ~25 logged tags on one shared axis would be unreadable.
  const chartTagNames = useMemo(
    () => Object.keys(tags).filter((name) => tags[name].trend !== false && tags[name].defaultActive !== false),
    [tags]
  );

  const chartData = useMemo(() => {
    if (!cycle || cycle === 'error' || !series) return null;
    const to = cycle.to ?? Date.now();
    return {
      from: cycle.from,
      to,
      series: chartTagNames.map((name) => ({
        name,
        color: tags[name].color,
        unit: tags[name].unit,
        decimals: tags[name].decimals,
        points: series[name] || [],
      })),
    };
  }, [cycle, series, chartTagNames, tags]);

  // Every logged tag gets a stats row, not just the curated chart set --
  // this table is the traceability record, so it should be complete.
  const statsTagNames = useMemo(
    () => Object.keys(tags).filter((name) => tags[name].trend !== false).sort(),
    [tags]
  );

  if (cycle === 'error') {
    return (
      <div className="report-page">
        <p className="cycles-empty">Cycle #{cycleId} not found.</p>
        <button className="no-print" onClick={() => onNavigate('/cycles')}>← Back to Cycles</button>
      </div>
    );
  }

  if (!cycle || !series) {
    return (
      <div className="report-page">
        <p className="cycles-empty">Loading report…</p>
      </div>
    );
  }

  const running = cycle.to == null;
  const end = cycle.to ?? Date.now();

  return (
    <div className="report-page">
      <div className="report-toolbar no-print">
        <button onClick={() => onNavigate('/cycles')}>← Back to Cycles</button>
        <button onClick={() => window.print()}>🖶 Print / Save as PDF</button>
      </div>

      <header className="report-header">
        <img src="/logo.png" alt="Isostatic Pressure" className="report-logo" />
        <div>
          <h1>Cycle Report</h1>
          <div className="report-subtitle">Cycle #{cycle.id}</div>
        </div>
      </header>

      <section className="report-meta">
        <div className="report-meta-item">
          <span className="report-meta-label">Start</span>
          <span className="report-meta-value">{formatDateTime(cycle.from)}</span>
        </div>
        <div className="report-meta-item">
          <span className="report-meta-label">End</span>
          <span className="report-meta-value">{running ? '—' : formatDateTime(cycle.to)}</span>
        </div>
        <div className="report-meta-item">
          <span className="report-meta-label">Duration</span>
          <span className="report-meta-value">{formatDuration(end - cycle.from)}</span>
        </div>
        <div className="report-meta-item">
          <span className="report-meta-label">Status</span>
          <span className={`cycle-status ${running ? 'running' : 'done'}`}>
            {running ? 'Running' : 'Complete'}
          </span>
        </div>
        <div className="report-meta-item">
          <span className="report-meta-label">Name</span>
          <span className="report-meta-value">{cycle.name || '—'}</span>
        </div>
        <div className="report-meta-item">
          <span className="report-meta-label">Batch Code</span>
          <span className="report-meta-value">{cycle.batchCode || '—'}</span>
        </div>
        <div className="report-meta-item">
          <span className="report-meta-label">Operator</span>
          <span className="report-meta-value">{cycle.operator || '—'}</span>
        </div>
      </section>

      {chartData && chartData.series.length > 0 && (
        <section className="report-chart">
          <h2 className="dashboard-group-title">Trend</h2>
          <div className="report-chart-plot">
            <TrendChart data={chartData} paused interactive={false} />
          </div>
        </section>
      )}

      <section className="report-stats">
        <h2 className="dashboard-group-title">Summary</h2>
        <table className="cycles-table report-stats-table">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Unit</th>
              <th>Min</th>
              <th>Max</th>
            </tr>
          </thead>
          <tbody>
            {statsTagNames.map((name) => {
              const def = tags[name];
              const decimals = def.decimals ?? 1;
              const { min, max, count } = summarize(series[name] || []);
              const fmt = (v) => (v == null ? '–' : v.toFixed(decimals));
              return (
                <tr key={name}>
                  <td>{formatTagName(name)}</td>
                  <td>{def.unit || ''}</td>
                  <td>{count ? fmt(min) : '–'}</td>
                  <td>{count ? fmt(max) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <footer className="report-footer">Generated {formatDateTime(Date.now())}</footer>
    </div>
  );
}
