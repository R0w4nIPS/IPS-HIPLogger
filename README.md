# IPS-HIPLogger

Polls a Siemens S7-1500 PLC over S7comm and serves live + historical trend
data through a small web dashboard (live values, trend charts, logged
cycles with CSV export, and a Settings page for PLC/tag config).

- `server/` — Node/Express + WebSocket backend, SQLite (better-sqlite3)
  for history, `nodes7` for the PLC connection.
- `client/` — React + Vite frontend. `client/dist` is committed and kept
  up to date, so a production deployment doesn't need Node/npm in `client/`
  at all — only `server/` needs dependencies installed.

## PLC prerequisites (S7-1500 / S7-1200)

1. In TIA Portal: CPU Properties → Protection & Security → Connection
   mechanisms → enable **"Permit access with PUT/GET communication from
   remote partner"**.
2. Every DB you read from must have **"Optimized block access" UNCHECKED**
   (DB Properties → Attributes), then recompile + download. Optimized DBs
   have no absolute addresses and can't be read over S7comm.
3. S7-1500 connects with rack 0, slot 1 (S7-300 would be slot 2).

## Development

```bash
cd server && npm install && npm start        # backend on :8080
cd client && npm install && npm run dev      # frontend on :5173, proxies /api and /ws to :8080
```

Run the backend against simulated data instead of a real PLC with
`npm run demo` (random-walk values) or `npm run demo:replay` (loops a real
recorded cycle read back out of `trend.db`).

## Deploying to a Windows PC

1. **Install Node.js** (LTS — match the major version used in development,
   currently v22) from nodejs.org.

2. **Get the code onto the PC**, e.g. to `C:\Logger`:
   ```powershell
   git clone https://github.com/rowandhollander-cmd/IPS-HIPLogger.git C:\Logger
   ```
   `C:\Logger\server` is a fixed path baked into `start-hidden.vbs` — keep
   that layout, or edit the `.vbs` if you deploy elsewhere.

3. **Install server dependencies on the Windows machine itself:**
   ```powershell
   cd C:\Logger\server
   npm install --omit=dev
   ```
   `better-sqlite3` uses a native binary — `node_modules` isn't committed
   to git and can't be copied over from another OS, so this step has to
   run on the target PC.

4. **Configure the PLC connection.** Either edit `server/config.js`
   directly, or start the server once and use the **Settings** page in the
   browser — it persists to `server/settings.json` (machine-specific,
   gitignored).

5. **Test it manually** before wiring up auto-start:
   ```powershell
   cd C:\Logger\server
   node index.js
   ```
   Open `http://localhost:8080` and confirm the dashboard shows live values
   (not "offline").

6. **Auto-start hidden on logon** via Task Scheduler, using the included
   `server/TrendLogger-Task.xml` (pairs with `server/start-hidden.vbs`,
   which launches `node index.js` hidden and logs to `server/logger.log`):
   ```powershell
   schtasks /create /tn "S7 Trend Logger" /xml "C:\Logger\server\TrendLogger-Task.xml"
   ```
   Its `ExecutionTimeLimit` is set to unlimited so Task Scheduler's default
   3-day cap doesn't kill the long-running server. Note this setup doesn't
   auto-restart the process if `node` itself crashes — it only starts it
   on logon.

7. **Open the firewall** if other PCs on the network need the dashboard:
   ```powershell
   New-NetFirewallRule -DisplayName "S7 Trend Server" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
   ```

## Configuration reference

- `server/config.js` — tag map (S7 addresses, units, colors, demo/replay
  simulation params), poll interval, SQLite retention, CSV format,
  default PLC connection. Comments in the file explain each option.
- `server/settings.json` / `server/tags.json` — machine-specific overrides
  saved by the Settings page (gitignored, absent by default).
- `server/trend.db` — production history (SQLite, gitignored).
- `server/trend.demo.db` — demo/replay mode's isolated SQLite file, so
  fake/replayed data never mixes with real production history.
