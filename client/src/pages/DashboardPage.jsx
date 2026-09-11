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
// cards in Furnace (see each zone's activeTag, configured on the Settings
// page and consumed in buildZoneCardProps below).
const CYCLE_EXTRA_TAGS = ['LoggingOnOff', 'FurnaceOn', 'CoolingRunning'];

// The Dashboard's four small fixed-position tile groups -- label and where
// each renders (Pressures: rendered side by side with Cycle, `columns: 2`
// lays it out as fixed pairs (row-major) instead of the default auto-fill
// grid; Cooling: after the Furnace section; Vessel Temperatures/Power:
// Furnace's second column, alongside the heating zone cards) are fixed
// here. Which tags populate each group's `key` is configurable from the
// Settings page (see /api/dashboard-groups) rather than hardcoded.
const PRESSURE_GROUP_DEF = { key: 'pressures', label: 'Pressures', columns: 2 };
const COOLING_GROUP_DEF = { key: 'cooling', label: 'Cooling' };
const FURNACE_SIDE_GROUP_DEFS = [
  { key: 'vesselTemperatures', label: 'Vessel Temperatures' },
  { key: 'power', label: 'Power' },
];

// Each furnace heating zone card's fixed slots -> the labels shown on the
// card. The actual tag feeding each slot is configurable from the Settings
// page (see /api/zones) rather than hardcoded here -- this list only maps
// slot -> display label and (for the two headline zone stats) whether it's
// the zone-A/zone-B slot the active-TC indicator can point at.
const ZONE_MAIN_SLOTS = [
  { field: 'setpointTag', label: 'Setpoint' },
  { field: 'zoneATag', label: 'Zone A' },
  { field: 'zoneBTag', label: 'Zone B' },
];
// Row 1: the zone's (only, or first) power module. Row 2 is the same 4
// stats for a second power module -- only some zones have one, so it's a
// separate slot set (voltageTag2/currentTag2/powerTag2/outputTag2) rather
// than a repeat count, and only renders at all when at least one of its
// tags is actually configured.
const ZONE_SECONDARY_SLOT_ROWS = [
  [
    { field: 'voltageTag', label: 'Voltage' },
    { field: 'currentTag', label: 'Current' },
    { field: 'powerTag', label: 'Power' },
    { field: 'outputTag', label: 'Furnace Output' },
  ],
  [
    { field: 'voltageTag2', label: 'Voltage' },
    { field: 'currentTag2', label: 'Current' },
    { field: 'powerTag2', label: 'Power' },
    { field: 'outputTag2', label: 'Furnace Output' },
  ],
];

// Builds a HeatingZoneCard's `main`/`secondaryRows`/`activeIndex` props from
// a zone config + the live tag/latest maps, skipping any slot left blank or
// whose tag doesn't exist (an empty secondary row is dropped entirely, so a
// zone with no second power module just doesn't get a second row).
// `activeIndex` is derived from where zoneATag/zoneBTag actually landed in
// `main` (not assumed to be fixed positions), since setpointTag being blank
// shifts everything up by one.
function buildZoneCardProps(zone, tags, latest) {
  const main = [];
  let zoneAIndex = -1;
  let zoneBIndex = -1;
  for (const { field, label } of ZONE_MAIN_SLOTS) {
    const tag = zone[field];
    if (!tag || !tags[tag]) continue;
    if (field === 'zoneATag') zoneAIndex = main.length;
    if (field === 'zoneBTag') zoneBIndex = main.length;
    main.push({ tag, label });
  }

  const secondaryRows = ZONE_SECONDARY_SLOT_ROWS.map((slots) =>
    slots.filter(({ field }) => zone[field] && tags[zone[field]]).map(({ field, label }) => ({ tag: zone[field], label }))
  ).filter((row) => row.length);

  const activeTC = zone.activeTag ? latest[zone.activeTag] : undefined;
  const activeIndex = activeTC == null ? -1 : activeTC === 1 ? zoneBIndex : zoneAIndex;

  return { main, secondaryRows, activeIndex };
}

export default function DashboardPage({ page, onNavigate }) {
  const [tags, setTags] = useState({});     // name -> {unit, decimals, color}
  const [latest, setLatest] = useState({}); // name -> value
  const [status, setStatus] = useState('connecting');
  const [zones, setZones] = useState([]);   // heating zone card config, from Settings
  const [groups, setGroups] = useState({}); // pressures/cooling/vesselTemperatures/power -> tag names, from Settings

  // Zone card + tile group config is edited on the Settings page and
  // applies live (no server restart), so a plain fetch-on-load is enough --
  // no need to push either over the WebSocket alongside tags/samples.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/zones')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !cancelled) setZones(data.zones);
      })
      .catch(() => {
        /* leave zones empty -- the Furnace section just shows no cards */
      });
    fetch('/api/dashboard-groups')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !cancelled) setGroups(data.groups);
      })
      .catch(() => {
        /* leave groups empty -- Pressures/Cooling/Vessel Temperatures/Power just show no tiles */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  function renderGroup({ key, label, columns }) {
    const groupTags = (groups[key] || []).filter((name) => tags[name]);
    if (!groupTags.length) return null;
    const gridClass = columns === 2 ? 'dashboard-grid dashboard-grid-2col' : 'dashboard-grid';
    return (
      <section key={key} className="dashboard-group">
        <h2 className="dashboard-group-title">{label}</h2>
        <div className={gridClass}>
          {groupTags.map((name) => (
            <ValueTile key={name} name={name} def={tags[name]} value={latest[name]} enabled readOnly />
          ))}
        </div>
      </section>
    );
  }

  function renderSubGroup({ key, label }) {
    const groupTags = (groups[key] || []).filter((name) => tags[name]);
    if (!groupTags.length) return null;
    return (
      <div key={key} className="furnace-subgroup">
        <h3 className="dashboard-subgroup-title">{label}</h3>
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
          {renderGroup(PRESSURE_GROUP_DEF)}

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
                  {zones.map((zone) => {
                    const { main, secondaryRows, activeIndex } = buildZoneCardProps(zone, tags, latest);
                    if (!main.length) return null;
                    return (
                      <HeatingZoneCard
                        key={zone.name}
                        label={zone.name}
                        tags={tags}
                        latest={latest}
                        main={main}
                        secondaryRows={secondaryRows}
                        activeIndex={activeIndex}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="furnace-col-side">
                {FURNACE_SIDE_GROUP_DEFS.map(renderSubGroup)}
              </div>
            </div>
          </section>
        )}

        {renderGroup(COOLING_GROUP_DEF)}
      </div>
    </div>
  );
}
