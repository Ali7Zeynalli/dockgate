# Changelog

---

## [2.0.12] - 2026-06-02

### Added
- **Run Container** — a guided form to launch a container from an image (Containers header "Run Container" button + a per-image "Run" action on the Images page): image with autocomplete + optional pull, name, repeatable port / volume / env rows, restart policy, network, command override, CPU / memory limits. `POST /api/containers/run` pulls-if-missing → creates → starts. Runs on the active host (local or remote SSH)
- **Create & edit Compose projects in the UI** — Compose page "New Project" + per-project "Edit YAML": a raw `docker-compose.yml` editor plus a guided "Add service" builder (name / image / ports / volumes / env → generated YAML). `POST /api/compose/create`, `GET` / `PUT /api/compose/:project/file`; the file is written under `data/compose/<project>/`, validated with `docker compose config`, then brought up. Local host only

### Fixed
- A fully-down Compose project created by DockGate can now be brought back up — the up/down/restart/pull actions fall back to the managed `data/compose/<project>` directory when the working dir can no longer be read from container labels

---

## [2.0.11] - 2026-06-02

A front-end reliability & UX release driven by a per-page audit of refresh behaviour and buttons.

### Fixed
- **Bulk actions no longer hide failures** — Start/Stop/Restart/Remove (Containers, Dashboard quick actions, Images, Volumes, Networks, Builds) used to swallow every per-item error and always show "success". They now report an accurate result (e.g. "Removed: 3 OK, 1 failed — &lt;reason&gt;") via a shared `bulkRun` helper
- **Real-time streams recover after a reconnect** — Logs, Stats, Events and Terminal silently froze when the socket reconnected (the server had dropped the stream). They now re-subscribe on reconnect and surface stream `error`/`end` notices instead of hanging
- **Image build is attributed to the correct host** — a build run while a remote SSH host is active is now audited and its failure alert routed to that host (was hardcoded "local")
- **Terminal reports its size to the server** — `terminal:resize` is now emitted so the remote shell wraps correctly (previously only the local xterm was resized)
- **Inspect "Search JSON" works** — the container-detail Inspect search box had no handler (dead UI); it now filters the JSON
- **Dashboard Smart Insights are clickable** — insight cards with a cleanup action now navigate to Cleanup
- **System page** — removed a dead, unused `/system/df` fetch that also made the page fail if `df` errored
- **Settings** — saving SMTP / Telegram now refreshes the view so the configured/masked state shows immediately
- **Images** — registry tags with a port (e.g. `localhost:5000/app:1.0`) now parse correctly (split on the last colon)
- **Clipboard copy** — Inspect JSON and build-log copy show a clear message instead of failing silently outside HTTPS/localhost

### Added
- **Consistent auto-refresh** — Volumes, Networks, System and Compose now auto-refresh (with the same modal/input-focus guard as Dashboard/Containers/Images); Networks also gained its missing cleanup-on-navigation

### Changed
- **Compose** — Down/Restart now ask for confirmation (destructive), and the actions are disabled with a notice when a remote SSH host is active (Compose is local-only)
- Container events table now escapes the type/action fields

---

## [2.0.10] - 2026-06-02

### Security
- **Resolved the transitive `uuid` advisory (GHSA-w5hq-g745-h8pq)** — `npm audit` is now clean (0 vulnerabilities). `dockerode` was upgraded to 5.x, which drops the vulnerable `uuid` dependency (it uses `crypto.randomUUID`). The upgrade was verified non-breaking for DockGate: it still uses `docker-modem` 5.0.7, so SSH multi-host (key auth), build-cache prune and all container/image/volume/network operations work against a real remote host, and the full test suite passes. (The advisory was not exploitable here regardless — dockerode only called `uuid.v4()` with no buffer, and DockGate itself uses `crypto.randomUUID`.)

### Changed
- Dependency ranges in `package.json` now match the installed versions: `better-sqlite3` ^11.10.0, `dockerode` ^5.0.0, `express` ^4.22.2, `socket.io` ^4.8.3, `node-pty` ^1.1.0

---

## [2.0.9] - 2026-06-02

### Fixed
- **Build Cache prune now works on remote SSH hosts** — "Clear Cache" (Builds page and System Cleanup) used the host `docker builder prune` CLI, so it only worked on the local daemon and failed on a remote host. It now uses the Docker Engine API (`pruneBuilder` → `POST /build/prune`) via dockerode, which tunnels over SSH. Verified against a real remote host holding 44.5 GB of build cache. The rest of the Builds / Cleanup data (build history, image-layer history, disk usage, container/image/volume/network prune) already used the Engine API and works on remote once the v2.0.8 SSH fix is deployed

### Notes
- **Builders list (buildx)** on a remote host shows only the default builder — `docker buildx ls` is a local CLI plugin with no Engine API equivalent, so a remote daemon's buildx builders cannot be enumerated (Docker limitation, not a DockGate bug)
- **Compose up/down/restart/pull** remain local-only — they require the compose files on the host filesystem

---

## [2.0.8] - 2026-06-02

### Fixed
- **SSH key authentication now works — it was completely broken** — connecting to a remote host with a **private key** always failed with `All configured authentication methods failed`, even with valid credentials. Root cause: `docker-modem` 5.x forwards only `host` / `port` / `username` / `password` to `ssh2` at the top level, while `privateKey` / `passphrase` must be passed inside `sshOptions`. DockGate set them at the top level, so they were silently dropped and `ssh2` fell back to the (absent) SSH agent. Both the active client (`createSshClient`) and the per-host event monitor (`buildClient`) now pass the key/passphrase via `sshOptions`. Verified end-to-end against a real remote host (add → switch → list remote containers). Password auth was unaffected (docker-modem forwards `password` at the top level)

---

## [2.0.7] - 2026-06-02

### Added
- **Automated test suite** — the project's first tests, run with `npm test` (Node's built-in test runner, no extra runtime deps; `supertest` as a dev dependency only):
  - **Unit** — `parseStats` / `demuxLogs` (Docker stats & log demux), source-IP extraction (`ipFromReq` / `ipFromSocket`)
  - **Integration** — the `/api/meta` routes against an isolated temp DB (no Docker daemon): settings allow-list (rejects `active_server`), timezone persistence, audit logging with server + source IP, audit search/filter, facets, and log clearing
- **CI test gate** — GitHub Actions now runs `npm ci && npm test` and the image build only proceeds when tests pass
- **`DATA_DIR` env override** — lets tests (and custom deploys) point the SQLite database at an isolated directory

---

## [2.0.6] - 2026-06-02

### Added
- **Display timezone** — a new **Timezone** setting (Settings → General) lets you pick any IANA zone (or **Auto** = browser/host); all displayed dates and notification timestamps render in the chosen zone. Previously everything showed **UTC** because the container runs in UTC. Stored times stay UTC — only the display is converted

### Changed
- Centralized front-end time formatting in a `formatTime()` helper and made `timeAgo`'s absolute fallback timezone-aware; container / build event email & Telegram notifications now format their timestamps in the selected timezone

---

## [2.0.5] - 2026-06-02

Adds a full audit log so you can see what was done on DockGate, on which host, and from where. Also makes the in-app audit search cover every column and standardizes all in-code comments and UI strings to English.

### Added
- **Audit Log** — every mutating operation is now recorded with its **host (server)** and **source IP** context: container/image/volume/network actions, Compose, cleanup/prune, image builds, interactive terminal sessions (session-level — keystrokes are not logged), SMTP/Telegram/notification-rule changes, settings changes, server add/edit/delete/switch, and self-update. Since there is no auth, this is a "what was done + from where" trail, not "who did it"
- **Audit Log page** (sidebar → Monitor → Audit Log) — filter by server / type / action, full-text search, adjustable row limit, and **CSV export**
- **`GET /api/meta/activity`** filtering (`type`, `action`, `server`, `q`, `limit`) and **`GET /api/meta/activity/facets`** for filter dropdown values
- `server/audit.js` — central `logAction()` helper that auto-captures the active server and source IP; the `activity` table gains `server` and `source_ip` columns
- **`trust proxy`** is enabled so the recorded source IP is correct behind a reverse proxy

### Fixed
- **Audit search now covers every column** — the search box matches resource, details, action, **server, source IP and type** (previously only resource/details/action, so searching by IP, server or type returned nothing)

### Changed
- **English everywhere** — all in-code comments and the Audit Log UI strings are now in English, matching the rest of the project

---

## [2.0.4] - 2026-06-02

A correctness-and-hardening release driven by a full-codebase audit. Fixes a class of multi-host bugs where local-only operations silently targeted (or failed against) the wrong daemon, repairs SSH key-passphrase support end to end, makes notifications honest, adds server editing, and bundles all front-end dependencies locally for air-gapped installs.

### Fixed
- **SSH key passphrase now persists** — the `servers` table gained a `passphrase` column; `POST /api/servers` and the new `PUT` accept and store it, and both the active-client (`createSshClient`) and the per-host `EventMonitor` (`monitor-manager.js`) apply it. Previously an encrypted key passed *Test Connection* but failed on activation (and produced no notifications) because the passphrase was never saved
- **Self-update & auto-start always act on the local host** — `POST /api/meta/update/apply` and the autostart toggle now use a dedicated local Docker client instead of the active (possibly remote) proxy. Before, triggering an update while a remote SSH host was active made DockGate look for its own container on the *remote* daemon and spawn the helper there
- **Build success/failure detection** — status is now derived from the Docker stream's structured `error`/`errorDetail` field instead of grepping the log text for `ERROR:` (which mis-flagged successful builds whose output happened to contain that string); the real error message is passed to the build-failed notification
- **Notification accuracy** — a clean container stop (exit 0) no longer says "stopped **unexpectedly**" (the alert now distinguishes *Stopped* from *Crashed*); an OOM kill (exit 137) sends a single OOM alert instead of OOM **and** a generic "stopped" alert; the disk-threshold alert reports honest absolute volumes (`X GB used / 50 GB threshold`) instead of a misleading GB-as-percent figure that always pinned at 100%
- **Stale disk/usage after deletes** — `removeImage/removeVolume/removeNetwork`, all `prune*` calls and the create operations now invalidate the cache, so the dashboard's disk usage and counters refresh immediately (previously only container actions did)
- **Front-end port links are host-aware** — published-port links now point at the active server's host (or the browser's host for local) instead of a hard-coded `localhost`, so they work when a remote SSH host is selected
- **Toast messages are escaped** — backend error text containing `< > &` no longer breaks toast rendering (`textContent` instead of `innerHTML`)
- **Settings no longer reset on hard refresh** — the Settings page short-circuited on the store's initial `{}` (which is truthy), so a full reload rendered every General-tab control (Log Timestamps, Default View, Default Shell) from empty state instead of fetching the saved values. It now fetches from the server when the store cache is empty

### Added
- **Edit existing servers** — `PUT /api/servers/:id` updates host/port/username/key/password/passphrase/description (only the fields sent change); it refreshes the active client and restarts the host's monitor. Previously editing required delete-and-recreate
- **Air-gapped support** — Socket.IO, Chart.js, xterm.js (+ fit addon) and the Inter / JetBrains Mono fonts are now bundled under `public/vendor/` and served locally; no CDN or internet access is required at runtime
- **`POST /api/meta/settings` key allow-list** — only known UI settings are writable; `active_server` is rejected so it can only change through `POST /api/servers/active` (prevents DB ↔ active-client state drift)

### Changed
- **Self-update preserves more config** — labels and custom networks are now carried over to the recreated container (in addition to ports, volumes, env, restart policy and resource limits)
- **Multi-host CLI guards** — operations that shell out to the host Docker CLI (Compose up/down/restart/pull, `buildx ls`, build-cache prune) now return a clear error when a remote SSH host is active, instead of silently acting on the local machine
- **`docker-history` parallelised** — per-image `history()` calls now run concurrently (`Promise.all`) instead of sequentially
- **Auto-refresh respects interaction** — Dashboard / Containers / Images skip their periodic re-render while a modal is open or an input is focused, preventing lost focus and scroll position
- **Docker image is multi-stage** — native modules are compiled in a builder stage with `npm ci` (reproducible, lock-file driven); the final runtime image drops the build toolchain (python3/make/g++) and keeps only the Docker CLI, shrinking the image
- **DB migrations are quieter but not silent** — additive `ALTER`/retention statements log genuine errors via `console.warn` while still ignoring expected "duplicate column" noise

### Removed
- **Dead code** — unused `streamEvents`, `streamContainerStats`, `streamContainerLogs` and `execInContainer` helpers were removed from `server/docker.js` (real-time streaming is built directly in `server/index.js`; the duplicates risked divergence)

---

## [2.0.3] - 2026-05-07

### Features — Multi-host Notifications
Notifications now fire from **every registered server simultaneously**, not just the active one. If you flip the header dropdown to `prod-1` and a container dies on `local`, the alert still arrives.

- **Per-server EventMonitor** — `EventMonitor` now takes a `(serverId, dockerClient)` pair; the docker client is dedicated (not the active-server proxy), so the stream stays bound to its own daemon
- **MonitorManager** (`server/notifications/monitor-manager.js`) — owns one `EventMonitor` per registered server (local + every SSH host); auto-starts on boot, auto-spawns when a server is added via `POST /api/servers`, auto-stops when one is deleted
- **Server-aware cooldown** — the throttle key now includes both server id and resource id (e.g. `prod-1:container_die:nginx`), so the same crash on different hosts each get an alert, and one host crashlooping doesn't suppress alerts from another
- **Server prefix in subject + Telegram + email** — alerts from non-local hosts include `[prod-1]` in the subject line, a `Server` row in the email body, and a `Server` field in the Telegram message; local-server alerts stay clean (no prefix)
- **Build-failed stays local** — image builds run against the host Docker, so the build-failure trigger is routed through the local monitor only

### Technical Changes
- `server/notifications/event-monitor.js` — class now constructor-injected with `serverId` and `docker`; reconnect logic respects `stopped` flag so a stop-followed-by-restart doesn't leak a pending reconnect; cooldown map keyed per `(serverId, eventType, resourceKey)`
- `server/notifications/monitor-manager.js` (new) — `startMonitor(idOrConfig)`, `stopMonitor(id)`, `startAll()`, `stopAll()`, `getLocal()`, `listMonitors()`; reads SSH key files into memory when constructing the dedicated client
- `server/notifications/templates.js` — every container/disk template now accepts an optional `server` field and emits a `Server` row when present (skipped for `local`)
- `server/index.js` — startup now calls `monitorManager.startAll()` instead of a single `eventMonitor.start()`; build-failure callback uses `monitorManager.getLocal()` because builds are local-only
- `server/routes/servers.js` — `POST /api/servers` calls `monitorManager.startMonitor(id)` after insert; `DELETE /api/servers/:id` calls `monitorManager.stopMonitor(id)` before responding

---

## [2.0.2] - 2026-05-07

### UX
- **SSH Agent tab marked as "Coming Soon"** — the agent path works in code (ssh2 falls back to `SSH_AUTH_SOCK`), but the DockGate container doesn't mount the host's agent socket out-of-the-box, so the connection fails for most users. Until the docker-compose mount is wired up, the tab now shows a clear "Coming Soon" badge plus an inline note pointing users to Private Key or Password instead

---

## [2.0.1] - 2026-05-07

### Major — Multi-host SSH Support
DockGate now manages **multiple Docker daemons** at once: the local socket plus any number of remote SSH servers. A compact **SRV** dropdown in the header switches between them; every page (Containers, Images, Volumes, Networks, Compose, Logs, Terminal) automatically reflects the active server.

### Features
- **SSH server registration** — Settings → Servers tab; add a host with ID, address, port, username, and one of three auth methods
- **Three SSH authentication methods:**
  - 🔑 **Private Key** — paste OpenSSH-format key; saved to `data/ssh-keys/<id>.pem` with mode 0600
  - 🔒 **Password** — stored as plain text in the DB (file-system protected via the data volume); UI uses a password input plus a "Private Key is more secure" hint
  - 📡 **SSH Agent** — no credentials supplied; `ssh2` falls back to `SSH_AUTH_SOCK`
- **Test Connection** — verifies a configuration before saving (or for an existing server) by running `dockerode` over SSH and reporting Docker version, container count, and image count
- **Header SRV dropdown** — shows `🖥 Local` plus every registered SSH host; changing the selection re-navigates the current page so the new daemon's data loads in place
- **Active-server persistence** — the choice is stored as the `active_server` setting and restored on container restart
- **Auth-mode badges** in the server table — each row shows 🔑 key / 🔒 password / 📡 agent at a glance

### Architecture — Dynamic Docker Client
- `server/docker.js` keeps a single runtime variable `_docker`; `setActiveServer(id)` reads the server config and rebuilds the client (`createLocalClient()` or `createSshClient()`)
- The exported `docker` is a `Proxy` whose getter forwards every property access to the current `_docker`. This means **none of the existing routes had to change** — every `dockerService.docker.X(...)` call automatically reaches the active daemon
- Dockerode's `protocol: 'ssh'` is used (handled by the `ssh2` library bundled with dockerode), so we get SSH tunneling without managing tunnels ourselves
- Auth precedence inside `createSshClient()`: privateKey → password → agent (ssh2 fallback)

### Technical Changes
- `server/db.js` — new `servers` table (id, type, host, port, username, key_path, password, description, created_at) plus five prepared statements; `active_server` added to the default settings; `ALTER TABLE` migration adds `password` column on existing installs
- `server/docker.js` — adds `setActiveServer()`, `getActiveServerId()`, `testServerConnection()`, plus `createLocalClient()` / `createSshClient()` helpers; the cache is cleared on every switch
- `server/routes/servers.js` — new router: `GET/POST/DELETE /api/servers`, `POST /test`, `POST /active`
- `server/index.js` — restores the saved `active_server` on startup; raises the Express JSON body limit to 5 MB so pasted private keys fit
- `public/index.html` — compact SRV switcher in the header
- `public/js/app.js` — `initServerSwitcher()` populates the dropdown via DOM APIs (XSS-safe escaping for user-supplied host strings) and re-navigates the current page on switch
- `public/js/pages/settings.js` — new "Servers" tab with the server table, a three-tab Add form (Private Key / Password / SSH Agent), inline test result, and a remote-host setup hint

### Migration
- Nothing required for v1.x users — `active_server` defaults to `local`, behaviour is unchanged
- To start using the new feature: Settings → Servers → Add SSH Server

### Security Notes
- Private-key files are written with mode `0600` (owner read-only)
- The `data/ssh-keys/` directory is created with mode `0700` inside the container
- DockGate itself has no built-in auth — anyone who can reach the UI can add or modify servers; **do not expose to untrusted networks**
- SSH key files are owned by the DockGate process user (`node` inside the container)
- Test-connection key files use temporary names (`_test_<timestamp>.pem`) and are deleted when the test completes, regardless of outcome

---

## [1.8.2] - 2026-04-19

### Bug Fixes
- **System Cleanup now matches UI counts** — clicking "Clean N Items" in the Cleanup page actually removes N items; previously only dangling (untagged) images were pruned while the UI counted all unused tagged images too, causing the cleanup action to appear to do nothing
- **Unused named volumes are now pruned** — on Docker 23+ `docker volume prune` defaulted to anonymous volumes only; DockGate now passes `all=true` filter so all unused volumes (named + anonymous) are cleared, matching what the UI displays
- **Full System Prune unified** — `systemPrune` uses the same filters so the Full Prune button's result matches the preview

### Technical Changes
- `server/docker.js` — `pruneImages` default `dangling=false` (all unused, not just dangling); `pruneVolumes` now passes `{ filters: { all: ['true'] } }`; `systemPrune` uses the same filters for both
- `server/routes/cleanup.js` — `/cleanup/images` query parameter flipped: default is now "prune all unused", opt-in `?dangling=true` for dangling-only

---

## [1.8.1] - 2026-04-16

### Features
- **Telegram Bot Notifications** — receive Docker alerts via Telegram alongside or instead of email, zero dependencies (native HTTPS)
- **Container Restart Notification** — alerts when a container restarts, shows restart count to detect restart loops
- **Container Unhealthy Notification** — alerts when a container's health check starts failing, with failing streak count and last health check output; detected both via Docker events and periodic 60s polling
- **Settings Tabbed Layout** — Settings page reorganized into 4 tabs: General, Notifications, Notification Log, Software Update

### Bug Fixes
- **Log Timestamps setting now works** — the toggle was saved but never passed to Docker; now `logs:subscribe` sends `timestamps: true` when enabled in settings

### Technical Changes
- `server/notifications/telegram.js` — new Telegram Bot API module using native `https`, `formatAlert()` for structured messages
- `server/notifications/event-monitor.js` — sends to both email and Telegram, 2 new event handlers (restart, unhealthy), periodic `_checkUnhealthy()` every 60s
- `server/notifications/templates.js` — 2 new HTML templates: `containerRestartTemplate`, `containerUnhealthyTemplate`
- `server/routes/settings.js` — 4 new Telegram endpoints: GET/POST/DELETE `/telegram`, POST `/telegram/test`
- `server/db.js` — 2 new default rules (`container_restart`, `container_unhealthy`), `channel` column on `notification_log`
- `public/js/pages/settings.js` — full rewrite with tab-bar (General, Notifications, Notification Log, Software Update), accordion channels
- `public/js/pages/container-detail.js` — passes `timestamps` setting to `logs:subscribe`
- `public/js/pages/logs.js` — passes `timestamps` setting to `logs:subscribe`

---

## [1.8.0] - 2026-04-16

### Features
- **SMTP Email Notifications** — configure SMTP server from Settings, receive automatic email alerts when containers stop, OOM kill occurs, disk threshold exceeded, or builds fail
- **EventMonitor Service** — persistent Docker events stream listener with auto-reconnect, runs independently of frontend connections
- **Notification Rules** — per-event toggle (container_die, container_oom, disk_threshold, build_failed) with configurable cooldown (1-1440 minutes) to prevent email spam
- **Notification Log** — history of sent/failed emails viewable in Settings, auto-trimmed to 500 records
- **Test Email** — one-click SMTP test from Settings to verify configuration before relying on alerts
- **Email Templates** — professional HTML email templates for each alert type with DockGate branding

### Technical Changes
- `server/db.js` — 3 new tables: `smtp_config`, `notification_rules`, `notification_log`; 13 new prepared statements; 4 default rules on startup
- `server/notifications/mailer.js` — SMTP transport via nodemailer, sendEmail with logging, sendTestEmail
- `server/notifications/templates.js` — 5 HTML email templates (containerDie, containerOom, diskAlert, buildFail, testEmail)
- `server/notifications/event-monitor.js` — EventMonitor class: Docker events stream, throttling, disk threshold check (5min interval), auto-reconnect on stream failure
- `server/routes/settings.js` — 7 new endpoints: SMTP CRUD, test email, notification rules CRUD, notification log
- `server/index.js` — EventMonitor starts on boot, build fail triggers notification, periodic notification log trim
- `public/js/pages/settings.js` — Notifications section: SMTP form, rule toggles with cooldown, recent notifications table
- `public/js/api.js` — added `API.put()` and `API.delete()` methods
- `package.json` — added `nodemailer ^8.0.5` dependency

---

## [1.7.9] - 2026-04-16

### Features
- **Light Theme** — full light mode support with CSS custom properties, instant theme switching via `applyTheme()`, localStorage persistence for flash-free page load + server settings sync
- **Build History bulk selection & deletion** — checkbox column for both Docker Image History and Panel Builds, select-all toggle, bulk hide/delete/clear actions with confirmation dialogs
- **Container Stats UI redesign** — cleaner summary cards with separate lines for Network I/O (↓/↑) and Block I/O (R:/W:), `formatBytes()` on memory chart Y-axis, increased chart height

### Improvements
- **Chart CSS variable colors** — chart grid lines and tick labels now read from `--border` and `--text-muted` CSS variables via `getComputedStyle()`, ensuring proper rendering in both dark and light themes
- **Builds page stale render guards** — added `Router.isActiveNav()` checks after async API calls in `renderCache()`, `renderBuilders()`, and `renderBuildDetail()` to prevent stale page rendering
- **CSS hardcoded colors replaced** — all `rgba(255,255,255,...)` values across components, layout, and design-system replaced with CSS custom property references for full theme compatibility

### Technical Changes
- `public/css/design-system.css` — full `[data-theme="light"]` block with all color overrides, `--hover-bg` variable family (6 levels)
- `public/css/components.css` — buttons, tables, filters, toolbars, toggles now use CSS variables; light theme overrides for toasts, log-viewer, json-viewer, build-log-viewer, terminal-container
- `public/css/layout.css` — sidebar scrollbar, nav hover, header search, brand gradient use CSS variables
- `public/js/app.js` — `applyTheme()` function sets `data-theme` on `<html>`, boot-time theme load from localStorage
- `public/js/pages/settings.js` — theme dropdown "Light (Soon)" → "Light", calls `applyTheme()` on save
- `public/js/pages/container-detail.js` — stats summary grid layout, `formatBytes()` chart Y-axis callback, `getComputedStyle()` for chart colors
- `public/js/pages/builds.js` — `selectedPanelIds`/`selectedDockerIds` Sets, bulk action bars, navId guards on 3 async functions

---

## [1.7.8] - 2026-04-15

### Bug Fixes
- **Docker Events stream fixed** — events page was always showing "Waiting for events..." because empty `filters: {}` was passed to Docker API, blocking the stream on some Docker versions
- **Event stream cleanup** — previous event stream is now destroyed before creating a new one on re-subscribe
- **Event error handling** — added `events:error` listener on frontend to show connection errors instead of silent failure

### Technical Changes
- `server/index.js` — `events:subscribe` handler no longer passes empty filters object, destroys previous stream on re-subscribe, emits errors on stream failure
- `public/js/pages/events.js` — added `events:error` socket listener with error display in empty state

---

## [1.7.7] - 2026-04-15

### Features
- **Bulk selection & deletion — Images** — checkbox column, select-all, search, bulk remove, bulk force remove
- **Bulk selection & deletion — Volumes** — checkbox column (unused only), select-all, bulk remove with data loss warning
- **Bulk selection & deletion — Networks** — checkbox column (removable only, excludes bridge/host/none and in-use), select-all, bulk remove

### Bug Fixes
- **Navigation race condition fixed** — resolved issue where switching between pages (e.g., Images → Logs) could result in blank content or stale page rendering
- **Router navId guard** — added unique navigation ID counter to prevent in-flight async operations from overwriting the active page's content
- **All pages protected** — every page handler now checks `Router.isActiveNav()` after API calls to abort stale renders
- **Command injection fix** — compose routes now use `execFile` instead of `exec` with template literals, preventing shell injection via project names
- **WebSocket listener leak fix** — terminal `input`/`resize` listeners now cleaned up before re-registration on server side
- **Container Detail terminal resize leak** — `window.addEventListener('resize')` now properly removed in cleanup
- **Container Detail socket listener leak** — `terminal:ready` listener now tracked and removed with handler reference
- **Modal cleanup on navigation** — open modals are now closed when navigating between pages
- **Duplicate API call removed** — Containers page no longer makes a second API call just for counts
- **Toast notification limit** — max 5 toasts shown at once to prevent DOM bloat
- **Build cache prune** — uses `execFile` instead of `exec` for safer command execution
- **DB activity log retention** — activity limited to 1000 records, build history to 100, with periodic cleanup every 6h
- **DB indexes added** — indexes on `activity(resource_id, resource_type)`, `activity(created_at)`, `build_history(started_at)`
- **Compose project name validation** — only alphanumeric, dash, underscore allowed

### Technical Changes
- `public/js/router.js` — added `_navId` counter, `isActiveNav()` method, post-handler staleness check, modal cleanup on navigate
- All page handlers — added `pageNavId` capture and guard after async API calls
- `server/routes/compose.js` — replaced `exec` with `execFile`, added `validateProjectName()` and `runCompose()` helpers
- `server/db.js` — added indexes, retention cleanup on startup, `trimActivity`/`trimBuilds` prepared statements
- `server/index.js` — terminal listener cleanup before re-registration, periodic DB trim every 6h
- `server/docker.js` — `pruneBuildCache()` uses `execFile`, removed unused `exec` import
- `public/js/api.js` — toast container limited to 5 children
- `public/js/pages/containers.js` — single API call for containers + counts
- `public/js/pages/container-detail.js` — resize listener tracked in cleanup array, terminal:ready tracked with handler ref

---

## [1.7.3] - 2026-04-14

### Performance
- **Dashboard loads 3-5x faster** — removed `size:true` from `listContainers` (was forcing Docker to calculate disk usage per container)
- **Cache layer** — `getSystemInfo` (60s TTL) and `getDiskUsage` (30s TTL) results are now cached
- **Parallel stats + health** — container stats (CPU/RAM) and health inspect calls now run concurrently
- **Parallel compose projects** — `listComposeProjects` moved into Phase 1 parallel batch
- **Auto-refresh 15s → 30s** — halved Docker daemon load
- **Cache invalidation** — cache is automatically cleared after container actions

### Technical Changes
- `server/docker.js` — added `cached()` function and `invalidateCache()` utility
- `server/index.js` — dashboard endpoint restructured into 2-phase parallel architecture
- `public/js/pages/dashboard.js` — refresh interval 15000 → 30000ms

---

## [1.7.0] - 2026-04-02

### New Features
- **Enhanced Dashboard** — completely redesigned with 7 new sections
- **Container Resource Monitor** — real-time CPU and RAM usage bars for running containers
- **Network I/O** — per-container download/upload traffic overview
- **Health Status** — healthy/unhealthy/no-healthcheck counts with doughnut chart
- **Uptime & Restarts** — container uptime duration and restart count tracking
- **Port Map** — table of all exposed ports mapped to containers
- **Top Images by Size** — visual bar chart of largest Docker images
- **Quick Actions** — Start All / Stop All / Restart All buttons
- **Commit-based update detection** — every push triggers update notification, not just version changes

### Technical Changes
- `server/index.js` — dashboard API now returns containerStats, healthStats, containerDetails, portMap, topImages
- `public/js/pages/dashboard.js` — full rewrite with new sections and Chart.js doughnut
- `Dockerfile` — COMMIT_SHA build arg for update detection
- `.github/workflows/docker-publish.yml` — passes commit SHA to Docker build, lowercase image name fix

---

## [1.6.0] - 2026-04-02

### New Features
- Version is now read from `package.json` everywhere — single source of truth
- Sidebar version display loads dynamically from `/api/meta/version` endpoint
- No more hardcoded version strings in HTML

### Technical Changes
- `server/routes/settings.js` — added `GET /meta/version` endpoint
- `public/js/app.js` — fetches version from API on boot, updates sidebar
- `public/index.html` — version placeholder replaced with dynamic loading

---

## [1.5.0] - 2026-04-02

### New Features
- Auto-update system with pre-built Docker image from GHCR (GitHub Container Registry)
- One-click update: pulls new image and restarts container automatically via helper container
- Settings page "Software Update" section: version comparison, changelog, update button
- Sidebar "UPDATE" badge when new version is available
- GitHub Actions CI/CD: auto-builds and pushes Docker image on every version tag, cleans up old untagged images

### How Auto-Update Works
- **Check**: Compares local version with GitHub `package.json` via `raw.githubusercontent.com` (no rate limits)
- **Apply**: Pulls `ghcr.io/ali7zeynalli/dockgate:latest` → inspects own container config → spawns `docker:cli` helper container → helper stops old container and starts new one with same config
- **Manual**: `docker compose pull && docker compose up -d`

### Technical Changes
- `server/routes/settings.js` — complete rewrite: dockerode-based image pull + helper container restart (replaces broken git-based approach)
- `docker-compose.yml` — uses pre-built GHCR image instead of local build
- `.github/workflows/docker-publish.yml` — CI/CD pipeline: build, push to GHCR, cleanup old images
- `public/js/pages/settings.js` — update UI shows changelog instead of commits
- `public/js/app.js` — `checkForUpdates()` on boot + 24h interval with localStorage cache
- `README.md` — updated installation and update instructions (EN + AZ)

---

## [1.4.0] - 2026-04-02

### New Features
- Docker Image Build History items can now be removed individually — hides from list without deleting the actual image
- Each history card has a delete button with confirmation dialog

### Technical Changes
- `server/db.js` — added `hidden_docker_builds` table and related statements
- `server/routes/builds.js` — added `/builds/docker-history/hide` POST and `/builds/docker-history/hidden` DELETE endpoints, docker-history filters hidden images
- `public/js/pages/builds.js` — added delete button to each Docker history card

---

## [1.3.0] - 2026-04-02

### New Features
- Build History now shows Docker's own image build history — every image listed with all its layers, expandable to see each Dockerfile step, command and size
- Build Cache now groups items by image name instead of flat list — description parsed to extract image names, matched against existing images
- Backend `/builds/docker-history` endpoint — fetches real layer history for each Docker image via Docker API
- Backend `/builds/cache` returns grouped cache data with matched image info

### Technical Changes
- `server/routes/builds.js` — added `/builds/docker-history` endpoint, rewrote `/builds/cache` to group by image name with matching
- `public/js/pages/builds.js` — Build History shows Docker image history cards with expandable layers, Build Cache uses new grouped API

---

## [1.2.0] - 2026-04-02

### New Features
- Builds page redesigned to match Docker Desktop Builds view
- Build Detail with 4 tabs: Info, Source/Error, Logs, History
- Info tab — build timing stats, cache usage bar, dependencies, full configuration, timeline
- Source tab — Dockerfile steps from logs; Error tab when build fails
- Logs tab — List view with collapsible steps + Plain-text view toggle, copy button
- History tab — past builds for same image tag with navigation
- Builders tab — active buildx builder instances
- Colorized build logs
- Build configuration stored in database (context_url, build_args, nocache, pull)

### Technical Changes
- `public/js/pages/builds.js` — fully rewritten with Docker Desktop style tabs
- `server/routes/builds.js` — added `/builds/builders`, `/builds/disk-usage`, detail routes at `/builds/detail/:id`
- `server/db.js` — added context_url, build_args, nocache, pull columns with migration
- `server/index.js` — updated insertBuild to store full build configuration
- `public/css/components.css` — added build-card, build-status-icon, build-log styles

---

## [1.1.0] - 2026-04-02

### New Features
- Docker Image Build system with real-time log streaming via WebSocket
- Build history stored in database
- Grouped build cache view with expandable packages
- New build modal with Git repo URL, Dockerfile path, nocache and pull options
- Build cancel support
- Build Cache API separated to dedicated endpoints

### Bug Fixes
- Fixed duplicate port display — Docker API returns same port for IPv4 and IPv6, now deduplicated

### Technical Changes
- `server/docker.js` — added `buildImage()` stream-based function
- `server/db.js` — added `build_history` table and prepared statements
- `server/routes/builds.js` — rewritten with history and cache endpoints
- `server/index.js` — added build streaming WebSocket events
- `public/js/pages/builds.js` — rewritten with 3 tabs: History, Cache, Live Build
- `public/js/pages/containers.js` — port deduplication in table and card view
- `public/js/pages/container-detail.js` — port deduplication in Ports tab
- `public/js/router.js` — added builds page title
- `public/css/components.css` — added tab-bar, pulse animation, input styles

---

## [1.0.0] - Initial Release

### Features
- Dashboard with system overview, smart insights and favorites
- Containers management with group by compose
- Container detail with logs, terminal, stats, ports, volumes, network, inspect
- Images, Volumes, Networks management
- Compose Projects
- Real-time log streaming and terminal via WebSocket
- Docker event monitoring
- System info and disk usage
- Cleanup tools
- Settings, Favorites, Notes, Tags, Activity log
