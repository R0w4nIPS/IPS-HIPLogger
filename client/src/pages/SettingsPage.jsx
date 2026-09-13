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

function blankStatusTagRow() {
  return {
    name: '',
    originalName: null,
    address: '',
    kind: 'bool',
    defaultActive: false,
  };
}

// Fixed slots a heating zone card can show -- mirrors ZONE_MAIN_SLOTS /
// ZONE_SECONDARY_SLOT_ROWS[0] in DashboardPage.jsx. zoneATag/zoneBTag are
// the only required ones; everything else can be left blank to omit that
// stat.
const ZONE_FIELDS = [
  { field: 'setpointTag', label: 'Setpoint', required: false },
  { field: 'zoneATag', label: 'Zone A', required: true },
  { field: 'zoneBTag', label: 'Zone B', required: true },
  { field: 'activeTag', label: 'Active Zone Indicator', required: false, kind: 'bool' },
  { field: 'voltageTag', label: 'Voltage', required: false },
  { field: 'currentTag', label: 'Current', required: false },
  { field: 'powerTag', label: 'Power', required: false },
  { field: 'outputTag', label: 'Furnace Output', required: false },
];

// A second power module's stats -- mirrors ZONE_SECONDARY_SLOT_ROWS[1] in
// DashboardPage.jsx. Entirely optional: only zones with a second module
// need these filled in, and the card only grows a second detail row once
// at least one of them is set.
const ZONE_FIELDS_2 = [
  { field: 'voltageTag2', label: 'Voltage', required: false },
  { field: 'currentTag2', label: 'Current', required: false },
  { field: 'powerTag2', label: 'Power', required: false },
  { field: 'outputTag2', label: 'Furnace Output', required: false },
];

function blankZoneRow() {
  return {
    name: '',
    setpointTag: '',
    zoneATag: '',
    zoneBTag: '',
    activeTag: '',
    voltageTag: '',
    currentTag: '',
    powerTag: '',
    outputTag: '',
    voltageTag2: '',
    currentTag2: '',
    powerTag2: '',
    outputTag2: '',
  };
}

// The Dashboard's four small fixed-position tile groups -- mirrors
// PRESSURE_GROUP_DEF/COOLING_GROUP_DEF/FURNACE_SIDE_GROUP_DEFS in
// DashboardPage.jsx. Only tag membership is editable here; the label and
// where each renders on the Dashboard are fixed.
const DASHBOARD_GROUP_DEFS = [
  { key: 'pressures', label: 'Pressures' },
  { key: 'cooling', label: 'Cooling' },
  { key: 'vesselTemperatures', label: 'Vessel Temperatures' },
  { key: 'power', label: 'Power' },
];

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

  const [restartState, setRestartState] = useState(null); // null | 'restarting' | {ok, error?}

  const [tagRows, setTagRows] = useState(null); // null while loading
  const [tagsSaveState, setTagsSaveState] = useState(null); // null | 'saving' | {ok, error?, restartRequired?}

  const [statusTagRows, setStatusTagRows] = useState(null); // null while loading
  const [statusTagsSaveState, setStatusTagsSaveState] = useState(null); // null | 'saving' | {ok, error?, restartRequired?}

  const [allTags, setAllTags] = useState({}); // name -> {kind, ...}, for the zone tag dropdowns
  const [zoneRows, setZoneRows] = useState(null); // null while loading
  const [zonesSaveState, setZonesSaveState] = useState(null); // null | 'saving' | {ok, error?}

  const [groupRows, setGroupRows] = useState(null); // null while loading; {pressures: [...], cooling: [...], ...}
  const [groupsSaveState, setGroupsSaveState] = useState(null); // null | 'saving' | {ok, error?}

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

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/status-tags')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || cancelled) return;
        setStatusTagRows(data.tags.map((t) => ({ ...t, originalName: t.name })));
      })
      .catch(() => {
        /* leave statusTagRows null -- the section shows "Loading..." indefinitely */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Every tag (including the db1001 status/bool tags, needed for the
  // "Active Zone Indicator" dropdown) -- unlike tagRows above, which only
  // covers the editable analog tags.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/tags')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !cancelled) setAllTags(data);
      })
      .catch(() => {
        /* leave allTags empty -- zone dropdowns just show no options */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/zones')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !cancelled) setZoneRows(data.zones);
      })
      .catch(() => {
        /* leave zoneRows null -- the section shows "Loading..." indefinitely */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/dashboard-groups')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !cancelled) setGroupRows(data.groups);
      })
      .catch(() => {
        /* leave groupRows null -- the section shows "Loading..." indefinitely */
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

  // Tag/config edits above are written to disk immediately but only take
  // effect on the next process start, so this actually respawns the
  // server process (see the /api/settings/restart handler) rather than
  // just being a UI refresh.
  async function handleRestart() {
    if (
      !window.confirm(
        'Restart the logger process now?\n\nThis takes a few seconds -- live values and the PLC connection will briefly drop and reconnect on their own once it is back.'
      )
    ) {
      return;
    }
    setRestartState('restarting');
    try {
      await fetch('/api/settings/restart', { method: 'POST' });
    } catch {
      // The process exits mid-response on purpose -- a network error here is expected, not a failure.
    }

    const deadline = Date.now() + 30000;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* still down -- keep polling */
      }
      if (Date.now() < deadline) {
        setTimeout(poll, 1000);
      } else {
        setRestartState({ ok: false, error: "Server didn't come back up -- check logger.log" });
      }
    };
    setTimeout(poll, 1500); // give the old process time to actually exit before checking
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

  function updateStatusTagField(index, field, value) {
    setStatusTagRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    setStatusTagsSaveState(null);
  }

  function addStatusTagRow() {
    setStatusTagRows((prev) => [...prev, blankStatusTagRow()]);
    setStatusTagsSaveState(null);
  }

  function removeStatusTagRow(index) {
    const row = statusTagRows[index];
    if (row.originalName && !window.confirm(`Remove "${row.originalName}" from the status tag list?`)) {
      return;
    }
    setStatusTagRows((prev) => prev.filter((_, i) => i !== index));
    setStatusTagsSaveState(null);
  }

  async function handleSaveStatusTags(e) {
    e.preventDefault();
    setStatusTagsSaveState('saving');
    try {
      const res = await fetch('/api/settings/status-tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: statusTagRows }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatusTagsSaveState({ ok: false, error: data.error || 'Save failed' });
        return;
      }
      setStatusTagRows(data.tags.map((t) => ({ ...t, originalName: t.name })));
      setStatusTagsSaveState({ ok: true, restartRequired: data.restartRequired });
    } catch {
      setStatusTagsSaveState({ ok: false, error: 'Request failed' });
    }
  }

  function updateZoneField(index, field, value) {
    setZoneRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    setZonesSaveState(null);
  }

  function addZoneRow() {
    setZoneRows((prev) => [...prev, blankZoneRow()]);
    setZonesSaveState(null);
  }

  function removeZoneRow(index) {
    const row = zoneRows[index];
    if (row.name && !window.confirm(`Remove the "${row.name}" card from the Dashboard?`)) return;
    setZoneRows((prev) => prev.filter((_, i) => i !== index));
    setZonesSaveState(null);
  }

  async function handleSaveZones(e) {
    e.preventDefault();
    setZonesSaveState('saving');
    try {
      const res = await fetch('/api/settings/zones', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zones: zoneRows }),
      });
      const data = await res.json();
      if (!res.ok) {
        setZonesSaveState({ ok: false, error: data.error || 'Save failed' });
        return;
      }
      setZoneRows(data.zones);
      setZonesSaveState({ ok: true });
    } catch {
      setZonesSaveState({ ok: false, error: 'Request failed' });
    }
  }

  function addGroupTag(key, tagName) {
    if (!tagName) return;
    setGroupRows((prev) => ({ ...prev, [key]: [...prev[key], tagName] }));
    setGroupsSaveState(null);
  }

  function removeGroupTag(key, index) {
    setGroupRows((prev) => ({ ...prev, [key]: prev[key].filter((_, i) => i !== index) }));
    setGroupsSaveState(null);
  }

  async function handleSaveGroups(e) {
    e.preventDefault();
    setGroupsSaveState('saving');
    try {
      const res = await fetch('/api/settings/dashboard-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: groupRows }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGroupsSaveState({ ok: false, error: data.error || 'Save failed' });
        return;
      }
      setGroupRows(data.groups);
      setGroupsSaveState({ ok: true });
    } catch {
      setGroupsSaveState({ ok: false, error: 'Request failed' });
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
          <h2 className="dashboard-group-title">Server</h2>
          <p className="settings-note">
            Tag/zone edits below are saved to disk immediately but only loaded by the logger process on
            startup. Restart it here to pick them up right away instead of restarting it on the machine
            yourself.
          </p>
          <div className="settings-actions">
            <button type="button" onClick={handleRestart} disabled={restartState === 'restarting'}>
              {restartState === 'restarting' ? 'Restarting…' : 'Restart Server'}
            </button>
          </div>
          {restartState && restartState !== 'restarting' && !restartState.ok && (
            <p className="settings-result bad">✗ {restartState.error}</p>
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

        <section className="settings-section settings-section--wide">
          <h2 className="dashboard-group-title">Status / Cycle Tags</h2>

          {statusTagRows == null ? (
            <p className="cycles-empty">Loading…</p>
          ) : (
            <form onSubmit={handleSaveStatusTags}>
              <p className="settings-note">
                Non-logging tags only -- discrete bool/enum signals (Mode, CycleStatus, alarms, ...) that
                are never written to trend.db, just shown live. Only name/address/kind are editable here;
                a tag's friendly value labels (e.g. 1 = "Running") stay defined in code/tags.json and are
                left untouched by this editor -- a newly added tag just shows its raw value until labels
                are added for it. Changes take effect the next time the server restarts.
              </p>

              <table className="tags-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>PLC Address</th>
                    <th>Kind</th>
                    <th>Default Active</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {statusTagRows.map((row, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          type="text"
                          value={row.name}
                          onChange={(e) => updateStatusTagField(i, 'name', e.target.value)}
                          placeholder="Tag_Name"
                          required
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={row.address}
                          onChange={(e) => updateStatusTagField(i, 'address', e.target.value)}
                          placeholder="DB1001,X0.0"
                          required
                        />
                      </td>
                      <td>
                        <select value={row.kind} onChange={(e) => updateStatusTagField(i, 'kind', e.target.value)}>
                          <option value="bool">bool</option>
                          <option value="enum">enum</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.defaultActive}
                          onChange={(e) => updateStatusTagField(i, 'defaultActive', e.target.checked)}
                        />
                      </td>
                      <td>
                        <button type="button" className="tags-row-delete" onClick={() => removeStatusTagRow(i)}>
                          ✕ Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="settings-actions">
                <button type="button" className="tags-add-btn" onClick={addStatusTagRow}>
                  + Add Tag
                </button>
                <button type="submit" disabled={statusTagsSaveState === 'saving'}>
                  {statusTagsSaveState === 'saving' ? 'Saving…' : 'Save Status Tags'}
                </button>
              </div>

              {statusTagsSaveState && statusTagsSaveState !== 'saving' && (
                <p className={`settings-result ${statusTagsSaveState.ok ? 'ok' : 'bad'}`}>
                  {statusTagsSaveState.ok
                    ? '✓ Saved — restart the server for the tag list to take effect'
                    : `✗ ${statusTagsSaveState.error}`}
                </p>
              )}
            </form>
          )}
        </section>

        <section className="settings-section settings-section--wide">
          <h2 className="dashboard-group-title">Furnace Heating Zone Cards</h2>

          {zoneRows == null ? (
            <p className="cycles-empty">Loading…</p>
          ) : (
            <form onSubmit={handleSaveZones}>
              <p className="settings-note">
                Controls how many heating zone cards show on the Dashboard and which tags feed each one.
                Zone A and Zone B are required; every other field can be left blank to omit that stat from
                the card. Takes effect immediately, no restart needed.
              </p>

              {zoneRows.map((row, i) => (
                <fieldset key={i} className="zone-editor-card">
                  <div className="zone-editor-head">
                    <input
                      type="text"
                      className="zone-editor-name"
                      value={row.name}
                      onChange={(e) => updateZoneField(i, 'name', e.target.value)}
                      placeholder="Zone name (e.g. Top Heating Zone)"
                      required
                    />
                    <button type="button" className="tags-row-delete" onClick={() => removeZoneRow(i)}>
                      ✕ Remove
                    </button>
                  </div>

                  <div className="zone-editor-fields">
                    {ZONE_FIELDS.map(({ field, label, required, kind }) => (
                      <label key={field}>
                        <span>
                          {label}
                          {required ? ' *' : ''}
                        </span>
                        <select
                          value={row[field]}
                          onChange={(e) => updateZoneField(i, field, e.target.value)}
                          required={required}
                        >
                          <option value="">{required ? '— select a tag —' : '— none —'}</option>
                          {Object.entries(allTags)
                            .filter(([, def]) => (kind === 'bool' ? def.kind === 'bool' : !def.kind))
                            .map(([name]) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                        </select>
                      </label>
                    ))}
                  </div>

                  <div className="zone-editor-subhead">Power Module 2 (optional)</div>
                  <div className="zone-editor-fields">
                    {ZONE_FIELDS_2.map(({ field, label }) => (
                      <label key={field}>
                        <span>{label}</span>
                        <select value={row[field]} onChange={(e) => updateZoneField(i, field, e.target.value)}>
                          <option value="">— none —</option>
                          {Object.entries(allTags)
                            .filter(([, def]) => !def.kind)
                            .map(([name]) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}

              <div className="settings-actions">
                <button type="button" className="tags-add-btn" onClick={addZoneRow}>
                  + Add Zone
                </button>
                <button type="submit" disabled={zonesSaveState === 'saving'}>
                  {zonesSaveState === 'saving' ? 'Saving…' : 'Save Zones'}
                </button>
              </div>

              {zonesSaveState && zonesSaveState !== 'saving' && (
                <p className={`settings-result ${zonesSaveState.ok ? 'ok' : 'bad'}`}>
                  {zonesSaveState.ok ? '✓ Saved' : `✗ ${zonesSaveState.error}`}
                </p>
              )}
            </form>
          )}
        </section>

        <section className="settings-section settings-section--wide">
          <h2 className="dashboard-group-title">Dashboard Tile Groups</h2>

          {groupRows == null ? (
            <p className="cycles-empty">Loading…</p>
          ) : (
            <form onSubmit={handleSaveGroups}>
              <p className="settings-note">
                Controls which readings show in the Pressures, Cooling, Vessel Temperatures, and Power
                groups on the Dashboard. Takes effect immediately, no restart needed.
              </p>

              <div className="group-editor-grid">
                {DASHBOARD_GROUP_DEFS.map(({ key, label }) => {
                  const rowTags = groupRows[key] || [];
                  const available = Object.entries(allTags).filter(
                    ([name, def]) => !def.kind && !rowTags.includes(name)
                  );
                  return (
                    <fieldset key={key} className="group-editor-card">
                      <div className="group-editor-title">{label}</div>
                      <ul className="group-editor-list">
                        {rowTags.map((name, i) => (
                          <li key={name}>
                            <span>{name}</span>
                            <button type="button" className="tags-row-delete" onClick={() => removeGroupTag(key, i)}>
                              ✕
                            </button>
                          </li>
                        ))}
                        {!rowTags.length && <li className="group-editor-empty">No readings selected</li>}
                      </ul>
                      <select
                        value=""
                        onChange={(e) => addGroupTag(key, e.target.value)}
                        disabled={!available.length}
                      >
                        <option value="">+ Add reading…</option>
                        {available.map(([name]) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </fieldset>
                  );
                })}
              </div>

              <div className="settings-actions">
                <button type="submit" disabled={groupsSaveState === 'saving'}>
                  {groupsSaveState === 'saving' ? 'Saving…' : 'Save Dashboard Groups'}
                </button>
              </div>

              {groupsSaveState && groupsSaveState !== 'saving' && (
                <p className={`settings-result ${groupsSaveState.ok ? 'ok' : 'bad'}`}>
                  {groupsSaveState.ok ? '✓ Saved' : `✗ ${groupsSaveState.error}`}
                </p>
              )}
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
