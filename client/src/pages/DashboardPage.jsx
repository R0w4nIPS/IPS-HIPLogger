import { useEffect, useState } from 'react';
import TopNav from '../components/TopNav.jsx';
import ValueTile from '../components/ValueTile.jsx';
import HeatingZoneCard from '../components/HeatingZoneCard.jsx';
import CycleCard from '../components/CycleCard.jsx';

// The cycle's 6 core values, consolidated into one CycleCard at the top of
// the dashboard rather than shown as flat tiles.
const CYCLE_MAIN_ITEMS = [
  { tag: 'Mode', label: 'Mode' },
  { tag: 'CycleStatus', label: 'Cycle Status' },
  { tag: 'SegmentType', label: 'Segment Type' },
  { tag: 'AlarmActive', label: 'Alarm' },
  { tag: 'VesselTemp', label: 'Vessel Temp' },
  { tag: 'VesselPosition', label: 'Vessel Position' },
];

// Remaining cycle tags, shown as plain tiles below the CycleCard.
// TopZoneActiveTC/BotZoneActiveTC aren't listed here -- they're not shown as
// their own tiles, only as the active-zone indicator on the heating zone
// cards in Furnace (see HEATING_ZONES' activeTag below).
const CYCLE_EXTRA_TAGS = ['LoggingOnOff', 'FurnaceOn', 'CoolingRunning'];

// Rendered side by side with Cycle (Pressures left, Cycle right) to save
// vertical space. `columns: 2` lays these out as fixed pairs (row-major)
// instead of the default auto-fill grid -- order matters: [Vessel Pressure,
// Setpoint] on row 1, [Bottle Pressure, Vacuum Pressure] on row 2.
const PRESSURE_GROUP = {
  label: 'Pressures',
  columns: 2,
  tags: ['Vessel_Pressure', 'Pressure_Setpoint', 'Bottle_Pressure', 'Vacuum_Pressure'],
};

// Rendered after the Furnace section.
const GROUPS_AFTER_FURNACE = [
  {
    label: 'Cooling',
    tags: ['Temp_Coolwater_Cover', 'Temp_Coolwater_Jacket', 'Temp_Coolwater_Top_In'],
  },
];

// Rendered as Furnace's second column, alongside the heating zone cards.
const FURNACE_SIDE_GROUPS = [
  { label: 'Vessel Temperatures', tags: ['Temp_Outside_Heatshield', 'Temp_Vessel'] },
  { label: 'Power', tags: ['Total_Power'] },
];

// Load_1/Load_2 aren't shown on the dashboard; still available on the Trend
// page's tile picker and chart.

// Each furnace heating zone shows its target setpoint and two zone
// temperatures as equally-prominent headline numbers (setpoint first),
// with voltage/current/power/furnace output as smaller supporting detail
// below. `activeTag` (0 = Zone A, 1 = Zone B) marks which of the main
// Zone A/B stats is the zone's currently active thermocouple -- note this
// is an index into `main`, so it must stay in sync with Zone A/B's position
// there (both currently at index 1 and 2, after the leading Setpoint).
const HEATING_ZONES = [
  {
    label: 'Top Heating Zone',
    activeTag: 'TopZoneActiveTC',
    main: [
      { tag: 'Temperature_Setpoint', label: 'Setpoint' },
      { tag: 'Top_Zone_A', label: 'Zone A' },
      { tag: 'Top_Zone_B', label: 'Zone B' },
    ],
    secondary: [
      { tag: 'Voltage_Top', label: 'Voltage' },
      { tag: 'Current_Top', label: 'Current' },
      { tag: 'Power_Top', label: 'Power' },
      { tag: 'Top_Furnace_Output', label: 'Furnace Output' },
    ],
  },
  {
    label: 'Bottom Heating Zone',
    activeTag: 'BotZoneActiveTC',
    main: [
      { tag: 'Temperature_Setpoint', label: 'Setpoint' },
      { tag: 'Bottom_Zone_A', label: 'Zone A' },
      { tag: 'Bottom_Zone_B', label: 'Zone B' },
    ],
    secondary: [
      { tag: 'Voltage_Bottom', label: 'Voltage' },
      { tag: 'Current_Bottom', label: 'Current' },
      { tag: 'Power_Bottom', label: 'Power' },
      { tag: 'Bottom_Furnace_Output', label: 'Furnace Output' },
    ],
  },
];

export default function DashboardPage({ page, onNavigate }) {
  const [tags, setTags] = useState({});     // name -> {unit, decimals, color}
  const [latest, setLatest] = useState({}); // name -> value
  const [status, setStatus] = useState('connecting');

  // ---- WebSocket live feed ---------------------------------------------
  // Only current values are needed here (no chart), so this connection
  // just tracks tag metadata + the latest sample per tag.
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
        } else if (msg.type === 'sample') {
          setLatest((prev) => ({ ...prev, ...msg.values }));
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

  const haveTags = Object.keys(tags).length > 0;

  function renderGroup(g) {
    const groupTags = g.tags.filter((name) => tags[name]);
    if (!groupTags.length) return null;
    const gridClass = g.columns === 2 ? 'dashboard-grid dashboard-grid-2col' : 'dashboard-grid';
    return (
      <section key={g.label} className="dashboard-group">
        <h2 className="dashboard-group-title">{g.label}</h2>
        <div className={gridClass}>
          {groupTags.map((name) => (
            <ValueTile key={name} name={name} def={tags[name]} value={latest[name]} enabled readOnly />
          ))}
        </div>
      </section>
    );
  }

  function renderSubGroup(g) {
    const groupTags = g.tags.filter((name) => tags[name]);
    if (!groupTags.length) return null;
    return (
      <div key={g.label} className="furnace-subgroup">
        <h3 className="dashboard-subgroup-title">{g.label}</h3>
        <div className="dashboard-grid">
          {groupTags.map((name) => (
            <ValueTile key={name} name={name} def={tags[name]} value={latest[name]} enabled readOnly />
          ))}
        </div>
      </div>
    );
  }

  const cycleExtras = CYCLE_EXTRA_TAGS.filter((name) => tags[name]);

  return (
    <div className="app">
      <TopNav page={page} onNavigate={onNavigate} status={status} />

      <div className="dashboard-body">
        <div className="dashboard-two-col">
          {renderGroup(PRESSURE_GROUP)}

          {haveTags && (
            <section className="dashboard-group dashboard-col-grow">
              <h2 className="dashboard-group-title">Cycle</h2>
              {/* pressure-width-grid/span reused here to size the 3x2 card
                  to exactly 3 tracks of this column's own auto-fill grid --
                  the same width the 3 extra tiles below occupy, rather than
                  stretching to the full column. */}
              <div className="pressure-width-grid">
                <div className="pressure-width-span">
                  <CycleCard tags={tags} latest={latest} items={CYCLE_MAIN_ITEMS} />
                </div>
              </div>
              {cycleExtras.length > 0 && (
                <div className="dashboard-grid cycle-extras">
                  {cycleExtras.map((name) => (
                    <ValueTile key={name} name={name} def={tags[name]} value={latest[name]} enabled readOnly />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        {haveTags && (
          <section className="dashboard-group">
            <h2 className="dashboard-group-title">Furnace</h2>
            {/* Same grid formula as .dashboard-grid. The zone column spans
                3 tracks, same as the Pressures group, so the heating zone
                cards stay exactly as wide as the pressure tiles combined;
                the side column spans further tracks alongside it. */}
            <div className="pressure-width-grid">
              <div className="pressure-width-span">
                <div className="zone-card-row">
                  {HEATING_ZONES.map((zone) => {
                    const activeTC = latest[zone.activeTag];
                    // Zone A/B sit at main[1]/main[2] (index 0 is the setpoint).
                    return (
                      <HeatingZoneCard
                        key={zone.label}
                        label={zone.label}
                        tags={tags}
                        latest={latest}
                        main={zone.main}
                        secondary={zone.secondary}
                        activeIndex={activeTC == null ? -1 : activeTC === 1 ? 2 : 1}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="furnace-col-side">
                {FURNACE_SIDE_GROUPS.map(renderSubGroup)}
              </div>
            </div>
          </section>
        )}

        {GROUPS_AFTER_FURNACE.map(renderGroup)}
      </div>
    </div>
  );
}
