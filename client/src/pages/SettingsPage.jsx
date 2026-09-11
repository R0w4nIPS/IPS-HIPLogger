import { useEffect, useState } from 'react';
import TopNav from '../components/TopNav.jsx';

const EMPTY_FORM = { host: '', port: 102, rack: 0, slot: 1, timeout: 5000 };

// Assigned round-robin to newly-added tag rows so they don't all default to
// the same gray line on the Trend chart -- picked from the app's existing
// tag palette in config.js, not anything new.
const NEW_TAG_COLORS = [
  '#0e6ea3', '#ac3500', '#863ca4', '#009650', '#b56400',
  '#007998', '#4d7100', '#af2938', '#6d47b8', '#00969e',
];

function blankTagRow(existingCount) {
  return {
    name: '',
    originalName: null,
    address: '',
    unit: '',
    decimals: 1,
    color: NEW_TAG_COLORS[existingCount % NEW_TAG_COLORS.length],
    defaultActive: true,
    logIntervalSec: 0,
  };
}

// PLC connection settings, editable at runtime instead of only via
// config.js -- persisted server-side to settings.json (see server/config.js)
// so an operator can point at a different CPU without touching code.
export default function SettingsPage({ page, onNavigate }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState(null); // 'live' | 'demo' | 'replay'
  const [status, setStatus] = useState('connecting');
  const [testState, setTestState] = useState(null); // null | 'testing' | {ok, error?}
  const [saveState, setSaveState] = useState(null); // null | 'saving' | {ok, error?}

  const [tagRows, setTagRows] = useState(null); // null while loading
  const [tagsSaveState, setTagsSaveState] = useState(null); // null | 'saving' | {ok, error?, restartRequired?}

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/plc')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || cancelled) return;
        setForm({ ...data.plc });
        setMode(data.mode);
        setLoaded(true);
      })
      .catch(() => {
        /* leave the blank form; user can still fill it in and save */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/tags')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || cancelled) return;
        setTagRows(data.tags.map((t) => ({ ...t, originalName: t.name })));
      })
      .catch(() => {
        /* leave tagRows null -- the section shows "Loading..." indefinitely,
           which is at least honest about not knowing the current list */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // This page has no live tag data to justify a WebSocket -- poll the PLC
  // status badge in TopNav the same way the Cycles page does.
  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok || cancelled) return;
        setStatus((await res.json()).plc);
      } catch {
        /* leave last known status */
      }
    }
    loadStatus();
    const id = setInterval(loadStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setTestState(null);
    setSaveState(null);
  }

  async function handleTest() {
    setTestState('testing');
    try {
      const res = await fetch('/api/settings/plc/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      setTestState(await res.json());
    } catch {
      setTestState({ ok: false, error: 'Request failed' });
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaveState('saving');
    try {
      const res = await fetch('/api/settings/plc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      setSaveState(res.ok ? { ok: true } : { ok: false, error: data.error || 'Save failed' });
    } catch {
      setSaveState({ ok: false, error: 'Request failed' });
    }
  }

  function updateTagField(index, field, value) {
    setTagRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    setTagsSaveState(null);
  }

  function addTagRow() {
    setTagRows((prev) => [...prev, blankTagRow(prev.length)]);
    setTagsSaveState(null);
  }

  function removeTagRow(index) {
    const row = tagRows[index];
    if (row.originalName && !window.confirm(`Remove "${row.originalName}" from the tag list?\n\nIts logged history is kept in trend.db either way -- this only stops it from being polled/shown going forward.`)) {
      return;
    }
    setTagRows((prev) => prev.filter((_, i) => i !== index));
    setTagsSaveState(null);
  }

  async function handleSaveTags(e) {
    e.preventDefault();
    setTagsSaveState('saving');
    try {
      const res = await fetch('/api/settings/tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tags: tagRows.map((row) => ({
            ...row,
            decimals: Number(row.decimals),
            logIntervalSec: Number(row.logIntervalSec) || 0,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTagsSaveState({ ok: false, error: data.error || 'Save failed' });
        return;
      }
      setTagRows(data.tags.map((t) => ({ ...t, originalName: t.name })));
      setTagsSaveState({ ok: true, restartRequired: data.restartRequired });
    } catch {
      setTagsSaveState({ ok: false, error: 'Request failed' });
    }
  }

  return (
    <div className="app">
      <TopNav page={page} onNavigate={onNavigate} status={status} />

      <div className="settings-body">
        <section className="settings-section settings-section--wide">
        <h2 className="dashboard-group-title">PLC Connection</h2>

        {!loaded ? (
          <p className="cycles-empty">Loading…</p>
        ) : (
          <>
            {mode !== 'live' && (
              <p className="settings-note">
                This server is currently running in <strong>{mode}</strong> mode, so it isn't holding a
                real PLC connection right now. Settings below still save normally and take effect the next
                time it's started without {mode === 'demo' ? '--demo' : '--replay'}.
              </p>
            )}

            <form className="settings-form settings-form--row" onSubmit={handleSave}>
              <label>
                <span>Host</span>
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => update('host', e.target.value)}
                  placeholder="192.168.0.1"
                  required
                />
              </label>
              <label>
                <span>Port</span>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => update('port', e.target.value)}
                  min="1"
                  max="65535"
                  required
                />
              </label>
              <label>
                <span>Rack</span>
                <input type="number" value={form.rack} onChange={(e) => update('rack', e.target.value)} min="0" required />
              </label>
              <label>
                <span>Slot</span>
                <input type="number" value={form.slot} onChange={(e) => update('slot', e.target.value)} min="0" required />
              </label>
              <label>
                <span>Timeout (ms)</span>
                <input
                  type="number"
                  value={form.timeout}
                  onChange={(e) => update('timeout', e.target.value)}
                  min="100"
                  step="100"
                  required
                />
              </label>

              <div className="settings-actions">
                <button type="button" onClick={handleTest} disabled={testState === 'testing'}>
                  {testState === 'testing' ? 'Testing…' : 'Test Connection'}
                </button>
                <button type="submit" disabled={saveState === 'saving'}>
                  {saveState === 'saving' ? 'Saving…' : 'Save'}
                </button>
              </div>

              {testState && testState !== 'testing' && (
                <p className={`settings-result ${testState.ok ? 'ok' : 'bad'}`}>
                  {testState.ok ? '✓ Connected successfully' : `✗ ${testState.error}`}
                </p>
              )}
              {saveState && saveState !== 'saving' && (
                <p className={`settings-result ${saveState.ok ? 'ok' : 'bad'}`}>
                  {saveState.ok
                    ? mode === 'live'
                      ? '✓ Saved — reconnecting with the new settings'
                      : '✓ Saved'
                    : `✗ ${saveState.error}`}
                </p>
              )}
            </form>
          </>
        )}
        </section>

        <section className="settings-section settings-section--wide">
          <h2 className="dashboard-group-title">Logging Tags</h2>

          {tagRows == null ? (
            <p className="cycles-empty">Loading…</p>
          ) : (
            <form onSubmit={handleSaveTags}>
              <p className="settings-note">
                Analog/sensor tags only -- the cycle/status signals (Mode, CycleStatus, alarms, ...) each
                carry their own value labels and aren't editable here. Renaming a tag carries its logged
                history over to the new name. Changes take effect the next time the server restarts.
              </p>

              <table className="tags-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>PLC Address</th>
                    <th>Unit</th>
                    <th>Decimals</th>
                    <th>Color</th>
                    <th>Default Active</th>
                    <th>Log Every (s)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tagRows.map((row, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          type="text"
                          value={row.name}
                          onChange={(e) => updateTagField(i, 'name', e.target.value)}
                          placeholder="Tag_Name"
                          required
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={row.address}
                          onChange={(e) => updateTagField(i, 'address', e.target.value)}
                          placeholder="DB1000,REAL0"
                          required
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={row.unit}
                          onChange={(e) => updateTagField(i, 'unit', e.target.value)}
                          placeholder="bar"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={row.decimals}
                          onChange={(e) => updateTagField(i, 'decimals', e.target.value)}
                          min="0"
                          max="6"
                        />
                      </td>
                      <td>
                        <input
                          type="color"
                          value={row.color}
                          onChange={(e) => updateTagField(i, 'color', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.defaultActive}
                          onChange={(e) => updateTagField(i, 'defaultActive', e.target.checked)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={row.logIntervalSec ?? 0}
                          onChange={(e) => updateTagField(i, 'logIntervalSec', e.target.value)}
                          min="0"
                          step="1"
                          title="Minimum seconds between values written to trend.db. 0 = every poll tick (the live chart always updates every tick either way)."
                        />
                      </td>
                      <td>
                        <button type="button" className="tags-row-delete" onClick={() => removeTagRow(i)}>
                          ✕ Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="settings-actions">
                <button type="button" className="tags-add-btn" onClick={addTagRow}>
                  + Add Tag
                </button>
                <button type="submit" disabled={tagsSaveState === 'saving'}>
                  {tagsSaveState === 'saving' ? 'Saving…' : 'Save Tags'}
                </button>
              </div>

              {tagsSaveState && tagsSaveState !== 'saving' && (
                <p className={`settings-result ${tagsSaveState.ok ? 'ok' : 'bad'}`}>
                  {tagsSaveState.ok
                    ? '✓ Saved — restart the server for the tag list to take effect'
                    : `✗ ${tagsSaveState.error}`}
                </p>
              )}
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
