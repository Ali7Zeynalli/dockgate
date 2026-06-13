# Changelog

---

## [2.0.112] - 2026-06-13

### Added — host metrics history + trend chart (PHASE 3)
- A `host_metrics` time-series table stores a compact sample (CPU / memory% / disk% / swap% / load / net / processes) each time the live monitor fetches `/host/stats` — **opportunistic sampling** (no always-on background poller hammering every server). `GET /api/servers/:id/host/metrics?limit=` returns the stored series (kept to ~2000 rows per server; cleared when the server is deleted)
- The Monitoring view now leads with a **Trend chart** (chart.js) of CPU / Memory / Disk over time — seeded from the stored history on open, then appended live on each 5s tick

---

## [2.0.111] - 2026-06-13

### Added — host logs in the console (PHASE 3)
- The server console gains a **Logs** tab: the last N lines of **journald / auth / syslog / dmesg** over SSH, with a source selector, line count (200/500/1000), manual refresh and an auto-5s toggle
- The log command is built from a server-side allowlist (the client only picks a source key + a clamped line count — no free shell) and runs read-only via an isolated worker. `GET /api/servers/:id/host/logs?source=&lines=`. auth/syslog/dmesg need passwordless sudo

---

## [2.0.110] - 2026-06-13

### Added — fail2ban + firewall rich operations (Manage UI)
- The Manage tab's **fail2ban** card now expands to show each jail and its banned IPs — click an IP to unban it — plus a "Ban IP" form (jail + IP)
- The **firewall** card shows the live `ufw status numbered` (or `firewall-cmd --list-all`) output and gives Allow / Deny / Delete-rule forms
- Lockout-capable operations (ban an IP, deny or delete a firewall rule) prompt for confirmation; all inputs go through the validated, injection-safe backend ops

---

## [2.0.109] - 2026-06-13

### Added — fail2ban + firewall rich operations (backend, PHASE 5b)
- New parameterised service operations: **fail2ban** — list jails + banned IPs, ban an IP, unban an IP (per jail); **firewall** — list current rules, allow a port, deny a port, and (ufw) delete a rule by number (firewalld add/remove port on RHEL)
- `GET /api/servers/:id/services/:itemId/ops` lists current state; `POST /api/servers/:id/services/:itemId/op {opId,params,confirm}` runs an operation
- Every param (IP/CIDR, port, protocol, jail, rule number) is validated to a charset that **cannot contain shell metacharacters** — both at the route and again in the worker — before it is interpolated into the catalog command. Lockout-capable ops (ban an IP, deny/delete a firewall rule) require confirmation; every op is audited. +2 unit tests (33 total). The Manage-tab UI for these lands next

---

## [2.0.108] - 2026-06-13

### Security — PHASE 5 service-management hardening (adversarial-review follow-up)
- **Lockout symmetry:** stopping or disabling SSH over a password login is now refused (it was only confirm-gated) — that is a worse lockout than editing the SSH config, which was already refused. `restart` (which maps to `reload` for SSH and keeps the connection) stays allowed
- **Timer health check:** a config write now always probes `is-active` after applying — including timer units like auto-updates, which previously skipped the check — so a write that fails to come back is caught and auto-restored. Added an `apt-config` validator for the auto-updates config
- **Verified rollback:** after an auto-restore the worker re-probes and reports whether the service actually recovered (vs "still down — manual intervention needed")
- **Backup retention:** only the 5 most recent `.dockgate.bak.*` files per config path are kept (was unbounded under `/etc`)
- **Read errors:** a failed config read returns a fixed message instead of echoing raw `sudo` stderr
- +1 unit test (31 total)

---

## [2.0.107] - 2026-06-13

### Changed — sidebar regrouped: Docker vs Server management
- The navigation is now split into clear domains so server-control is no longer mixed in with Docker: **Docker** (Dashboard, Containers, Images, Volumes, Networks, Builds, Compose, Templates, Swarm), **Activity** (Logs, Terminal, Events, Files, Audit), **Server** (Infrastructure, Server Console), and **System** (Settings)

---

## [2.0.106] - 2026-06-13

### Fixed — Software Update check never worked on Alpine (always showed "up to date")
- The update check fetched GitHub with `wget --timeout=5`, but the runtime image is `node:18-alpine` → **busybox wget**, which does not accept the GNU `--timeout=` long flag, so the fetch failed on every deployed instance. Switched to `-T 5` (supported by both busybox and GNU wget)
- The failure was also **silent**: `/update/check` swallowed the error and returned `updateAvailable:false`, and the UI rendered "DockGate is up to date" regardless. The Software Update tab now shows **"Could not check for updates"** (with the reason) when the check fails, instead of falsely claiming it's current

---

## [2.0.105] - 2026-06-13

### Changed — Setup tab decluttered
- Removed the long per-item "How it works — detect / install / verify" command dump at the bottom of the Setup tab (it was tiring to scroll). The component status cards already show each item's name, description and install state; the detect-first behaviour is noted next to the Run button

---

## [2.0.104] - 2026-06-13

### Added — Manage tab: guarded config editor (completes PHASE 5 service management)
- Each manageable service now has an **Edit config** panel that reads its allowlisted config file over SSH into an editor
- Saving runs a strict, guarded sequence in the isolated worker: re-check the path against the allowlist → back up the file (timestamped) → write via base64 (raw bytes never touch the command line) → validate where possible (`sshd -t` / `fail2ban-client -t` / `firewalld --check-config`) → on validation failure restore the backup → restart/reload → if the service fails to come back active, restore the backup and re-apply. **A service is never left with a broken config.**
- Editing the SSH config over a password login is refused (lockout); firewall / SSH edits show a lockout warning and require explicit confirmation. Every write (success and failure) is audited

---

## [2.0.103] - 2026-06-13

### Added — Manage tab: service control (start / stop / restart / enable / disable)
- The console's **Manage** tab now lists each manageable service as a card — live active / enabled-at-boot status, unit name, editable config paths — with action buttons
- Start / stop / restart / enable / disable run over SSH via the isolated worker; the concrete command is resolved from the catalog (never free shell). **Destructive actions on a high-risk service (firewall / SSH) or on Docker require confirmation** — the backend returns 409 first (no change is made), then a confirm dialog resends with `confirm:true`. Every action (success and failure) is written to the activity audit log

---

## [2.0.102] - 2026-06-13

### Added — service status backend (read-only, PHASE 5)
- A new isolated `server/service-ctl-worker.js` (forked, like the host-stats worker, so SSH never contends with the live monitors) reads the **live status of the 6 manageable services** over SSH — for each it runs the catalog's `is-active` / `is-enabled` commands and reports active / enabled-at-boot / unit / editable config paths
- `GET /api/servers/:id/services/status` returns it (auth-gated, remote-only); the provisioning catalog endpoint now also lists which items are manageable. Read-only — no mutation yet. Every command is resolved from the catalog and any config path is re-checked against the allowlist inside the worker

---

## [2.0.101] - 2026-06-13

### Added — service-control catalog matrix (PHASE 5 groundwork)
- `server/provision/catalog.js` gains an **additive** per-distro `service` block for the 6 manageable services (Docker, fail2ban, firewall, SSH, time sync, auto-updates): the systemd/openrc unit, lifecycle action commands, and an **allowlist** of editable config paths
- Pure helpers — `serviceFor` / `serviceAction` / `manageableItems` / `isConfigPathAllowed` / `guardedServiceAction` — resolve every command from catalog constants, so the UI can only pass an item id + an action (never free shell, never a path). The guard refuses an SSH-config edit over a password login (lockout) and requires confirmation for config writes + destructive actions on high-risk services / Docker. +8 unit tests
- No SSH or endpoints yet — the read-only status worker and the Manage UI land in the next versions

---

## [2.0.100] - 2026-06-13

### Docs — backfilled the changelog for v2.0.72 → v2.0.99
- Reconstructed a changelog entry for **every released version from v2.0.72 through v2.0.99** (auth + hardening, the Infrastructure refactor, the provisioning system, host monitoring, and the per-server console) — the changelog had stopped at v2.0.71. README version + changelog badges bumped to match. Going forward, every version gets a changelog entry as part of its commit

---

## [2.0.99] - 2026-06-13

### Improved — Setup tab: component status cards + a clean "How it works"
- The flat checkbox list is now **grouped component status cards** (Base / Security / System), each with an on-card **status pill** (installed / missing / n-a) and a colour-coded left border — always visible as a live preview of what's already on the server
- Checkboxes are interactive **only in the Custom preset** (a hint line explains this); the other presets show the cards read-only
- The raw `<pre>` detect/install/verify dump became a per-item **"How it works"** built from clean `detail-grid` rows (Detect / Install / Verify). Preset cards, the risky-steps confirm, Run and the live-run view are unchanged

---

## [2.0.98] - 2026-06-13

### Improved — console: Overview + Monitoring merged into one Dashboard-grade view
- The console drops from 4 tabs to **[Overview | Setup | Manage]**: Monitoring is folded into Overview, the Logs placeholder is removed, and a Manage stub is added (service control lands next)
- Overview now shows a compact **readiness banner** (Ready / Needs setup + installed/missing counts + "Set up N missing →"), then the **full live host-metrics dashboard**, then the per-group component cards — one comfortable view
- A single catalog+scan feeds the banner and cards; the embedded host monitor keeps its own self-terminating 5s poll (no double-scan, no leak). Old `?tab=monitoring` / `?tab=logs` deep-links fall back to Overview

---

## [2.0.97] - 2026-06-13

### Improved — console UI now matches the app design system
- The Monitoring view was rebuilt with the **same primitives as the main Dashboard**: summary-grid KPI tiles (CPU / Memory / Disk / Swap / Uptime / Load, colour-coded), a Resource Usage card with usage bars (used/total), a System detail grid, an Open Ports card, a per-mount Disks card, and a Dashboard-style Top Processes table, plus a live pulse badge
- Overview leads with KPI tiles; the cramped `max-width` was removed so the console uses the full page width like every other screen

---

## [2.0.96] - 2026-06-13

### Added — Server Console entry in the sidebar
- A **Server Console** item under the Manage nav group, revealed once at least one remote SSH server is registered. It opens the active remote server's console (or routes to Infrastructure → Servers to pick one)

---

## [2.0.95] - 2026-06-13

### Added — live host monitoring in the console
- A Monitoring view polls the host every 5s and shows CPU / Memory / Disk / Swap, load average, network ↓/↑ rate, uptime, open ports, per-mount disks and the top processes. Polling stops when you leave the view

---

## [2.0.94] - 2026-06-13

### Added — host stats backend (PHASE 3)
- `server/host-stats.js` parses `/proc` (CPU% via two samples, RAM/swap, load, uptime), `df`, `/proc/net/dev` (rx/tx rate), `ps` (top processes) and `ss`/`netstat` (open listening ports). An isolated worker collects the snapshot over SSH; `GET /api/servers/:id/host/stats` returns it (auth-gated, remote-only). +8 parser unit tests
- Note: live SSH collection needs ssh2 (not runtime-tested here); the parsing is unit-tested

---

## [2.0.93] - 2026-06-13

### Improved — modern dashboard look for the Setup tab
- Preset selection became cards with a clear selected highlight; items show installed / missing / n-a pills; the risky-steps confirm is a styled danger callout. The run view is now **step cards** (one per item — ✓ / ✗ / ⊘ / ⟳, colour-coded) with the raw output moved into a collapsible "Show full log"

---

## [2.0.92] - 2026-06-13

### Added — console Overview: card-based server readiness
- A new Overview builds a card dashboard from the live SSH scan: a Ready / Needs-setup banner (OS + counts + "Set up N missing →"), then per-group (Base / Security / System) cards showing each item ✓ installed / ○ missing / ⊘ n-a. The console defaults to Overview

---

## [2.0.91] - 2026-06-13

### Improved — idempotent "Grant Docker"; removed the duplicate add-form checkbox
- Grant Docker now checks group membership first and skips the change if the user is already in the `docker` group ("already in the docker group — nothing to do" vs "added"). Removed the redundant "Grant Docker access after adding" checkbox from the Add SSH Server form (the standalone Grant button and provisioning's docker-group step are both idempotent)

---

## [2.0.90] - 2026-06-13

### Changed — full-page per-server console
- The console is now a **top-level page** (`#/server-console?id=…&tab=…`, deep-linkable sub-tabs) instead of being nested in the Infrastructure tab. Infrastructure → Servers → **Manage** opens it; Back returns to Servers

---

## [2.0.89] - 2026-06-13

### Changed — per-server console replaces the cramped provisioning modal
- Per feedback the modal was confusing. A remote server's **Manage** button now opens a per-server **console** (tabs: Setup / Monitoring / Logs / Overview) with the provisioning panel rendered full-width instead of in a modal

---

## [2.0.88] - 2026-06-13

### Added — live read-only scan when Setup opens
- Setup now **live-scans** the server (detect-only, nothing is installed) and shows each item as ✓ installed / ○ missing / ⊘ n-a with the detected OS and a missing count, instead of only DB history. `GET /api/servers/:id/provision/scan`

---

## [2.0.87] - 2026-06-13

### Added — provisioning UI (Setup) — completes PHASE 2
- A Setup flow with a preset picker (just-docker / secure-baseline / full / custom), custom item checkboxes, a risk-confirm for lockout-class steps, a current-status matrix and a read-only "how it works" explainer. Run streams a **live log** that keeps running if you close the dialog
- Note: provisioning runs install commands as root over SSH and is not yet runtime-tested — exercise it on a throwaway VPS first

---

## [2.0.86] - 2026-06-13

### Added — provisioning API
- Six auth-gated endpoints under `/api/servers`: catalog, per-server matrix, run history, run detail, live job poll, and start (`POST /:id/provision {preset,only,confirm}` — decrypts secrets, resolves the key path, returns 409 + the risk list on unconfirmed high-risk steps)

---

## [2.0.85] - 2026-06-13

### Added — provisioning worker + job runner + lockout/risk guards
- An isolated forked worker detects the distro, builds the plan from the catalog and runs detect → install → verify over one SSH connection (NDJSON progress). An in-memory job runner keeps the live log going if the browser closes and persists each item + outcome to SQLite. Guards: SSH-hardening is dropped when the server has no key (lockout), UFW allows the live SSH port before enabling, only catalog ids run (no free shell), and high-risk items require confirm

---

## [2.0.84] - 2026-06-13

### Added — provisioning history tables
- `provision_runs` + `provision_items` tables (kept ~200 runs, separate from the activity audit) with indexes for per-server lookups and the latest-state-per-item matrix; idempotent migration + retention

---

## [2.0.83] - 2026-06-13

### Added — server-setup check-matrix catalog
- `server/provision/catalog.js`: 10 items (update, base-utils, time sync, firewall, SSH hardening, fail2ban, unattended-upgrades, swap, Docker, docker-group) with detect/install/verify commands per distro family (debian / rhel / alpine) and presets (just-docker / secure-baseline / full / custom). The UI can only toggle known ids — no free-form shell; unknown distros throw rather than fabricate commands. +6 unit tests

---

## [2.0.82] - 2026-06-13

### Changed — new Infrastructure section (Servers + Registries + Cleanup)
- A new **Infrastructure** nav section hosts Servers, Registries and Cleanup as deep-linkable sub-tabs. Servers moved out of Settings; the old `#/registries` and `#/cleanup` routes redirect into Infrastructure
- Note: not browser-tested yet (no runtime in this environment)

---

## [2.0.81] - 2026-06-13

### Security — encrypt SSH & registry secrets at rest (AES-256-GCM)
- SSH passwords/passphrases and registry passwords are now **encrypted at rest** with AES-256-GCM (master key from `DG_MASTER_KEY` or a generated `data/.master.key`, mode 0600) and decrypted at every consumer. encrypt/decrypt are idempotent so a half-migrated DB never breaks; a one-time boot migration encrypts any pre-existing plaintext. Completes the PHASE 0 hardening
- Note: the full round-trip is not runtime-tested here — verify on a real instance

---

## [2.0.80] - 2026-06-13

### Security — SSRF guard + shell-injection / path-traversal fixes
- The stackfile proxy now rejects internal/metadata hosts and manual redirects (a public host can't bounce into the private network). Container/volume file-browse pass the path as a positional argument instead of interpolating it into a shell script, and the path sanitiser was rewritten segment-based to close a `....//` bypass

---

## [2.0.79] - 2026-06-13

### Security — same-origin CORS, login rate-limit, CSRF origin-check, BIND_HOST
- socket.io CORS is no longer `*` (same-origin by default; `ALLOWED_ORIGIN` opts in a cross-origin panel). Login/setup are rate-limited (10 attempts / 15 min per IP). A cross-origin state-changing request is rejected (403) as CSRF defence atop SameSite=Lax. `BIND_HOST` lets the server bind 127.0.0.1 behind a reverse proxy

---

## [2.0.78] - 2026-06-13

### Security — require a session on the socket.io handshake
- An unauthenticated client can no longer open any live stream (build / logs / stats / events / terminal / host shell) — the handshake verifies the same session cookie as the REST gate

---

## [2.0.77] - 2026-06-13

### Added — login + first-run setup screens
- On boot the app checks auth status and shows a first-run **setup** screen (create the admin), a **login** screen, or the panel. A 401 from any data call bounces to login; the sidebar has a Log out button. The static shell stays public, all data is gated

---

## [2.0.76] - 2026-06-13

### Added — auth endpoints + gate every /api route behind a session
- `/api/auth` (open): status, first-run setup (min-8 password + auto-login), login, logout. Every other `/api` route and the dashboard now require a valid session

---

## [2.0.75] - 2026-06-13

### Added — auth foundation (password hashing + signed session tokens)
- scrypt password hashing (salted, constant-time verify) and HMAC-signed session tokens with HttpOnly / SameSite=Lax cookies (secret from `DG_SESSION_SECRET` or generated). +5 unit tests

---

## [2.0.74] - 2026-06-13

### Fixed — accessibility: associate modal form labels with their inputs
- Added `for=` attributes linking labels to inputs in the Run, Swarm service, SSH server, Build, Network and Volume-clone forms — screen readers announce each field and clicking a label focuses its input

---

## [2.0.73] - 2026-06-12

### Fixed — template logos load same-origin (kills the CORP console warning)
- Template logos are re-served from our own origin via `GET /api/templates/logo?url=` (http(s) only, SSRF host block, image/* only, 2 MB cap, 8s timeout, browser-cacheable). Card logos are lazy-loaded so only visible cards fetch. Fixes Firefox blocking logos that upstream hosts send with `Cross-Origin-Resource-Policy: same-origin`

---

## [2.0.72] - 2026-06-12

### Fixed — hash-based routing (browser Back/Forward + refresh restore)
- Each navigation now syncs to `location.hash` (`#/<path>?<params>`), so the browser **Back/Forward** buttons work and a hard refresh on a Settings sub-tab restores that exact tab (previously Back exited the app and refresh reset to General)

---

## [2.0.71] - 2026-06-12

### Added — App Templates: click an app for full details + Docker Hub popularity
- Clicking a template card now opens a **detail view**: logo, image, full description, categories, **environment variables** (name/label/default), exposed ports and volumes, and a **Deploy** button
- Shows **Docker Hub popularity** for the app's image — **pull count + star count** (a real "how popular is this" signal), fetched server-side and cached (`GET /api/templates/hubstats`). Non-Docker-Hub images (ghcr.io, quay.io…) simply omit the line
- Note: the Portainer template format has no screenshots or star-ratings; the logo + Docker Hub stats are the available signals

---

## [2.0.70] - 2026-06-12

### Added — Deploys console on the Compose page
- A **Deploys** panel under the project list shows running and recent background deploy jobs (● running / ✓ done / ✗ failed) with their current phase. **"view log"** re-opens the **live log** of any job — so if you closed the deploy dialog or navigated away, you can come back and watch it (the deploy keeps running on the server). `GET /api/compose/deploy-jobs`

---

## [2.0.69] - 2026-06-12

### Fixed — remote project: Update now applies, and Files shows the actual server files
- **Update / Rebuild now force-recreate the container** (`up -d --build --force-recreate`) — previously a re-upload could rebuild the image but leave the old container running, so changes didn't take effect
- **📁 Files on a remote-deployed project now browses the folder ON THE SERVER over SFTP** (view / edit / delete), instead of DockGate's local pointer dir (which only held the deploy metadata and showed empty). The dialog opens instantly with a loading state, then lists the remote files. Edits are written back over SFTP and audited

---

## [2.0.68] - 2026-06-12

### Fixed — Compose page broke (SyntaxError: 'started' already declared)
- A duplicate `const started` introduced with the background-deploy job (2.0.66) made `compose.js` fail to parse, breaking the Compose page. Renamed the second one; the page loads again

---

## [2.0.67] - 2026-06-12

### Fixed — remote builds failed with "buildx/.lock: permission denied"
- On a remote host where `~/.docker` is owned by root (e.g. a server previously used by Coolify/root), deploying a project that **builds an image** failed with `open ~/.docker/buildx/.lock: permission denied` and appeared to hang on "starting". DockGate now runs remote `docker compose` with a **writable, DockGate-owned `DOCKER_CONFIG`** (`~/.dockgate/.docker-config`), so builds work regardless of who owns `~/.docker`. Existing registry credentials (`~/.docker/config.json`) are copied in so private-image pulls still work
- Verified on a real host whose `~/.docker` was root-owned: a `build:`-based project built and came up cleanly

---

## [2.0.66] - 2026-06-12

### Improved — folder deploy runs as a background job (won't get lost if you close the modal)
- Once the upload finishes, the **SFTP transfer + `docker compose up`** run as a **tracked background job**. Closing the dialog (or even the browser) no longer aborts it — the deploy keeps running on the server and the project appears when it's done
- The dialog now shows the **live phase and output** (uploading → compose up → image pull / build logs), doesn't auto-close, and ends with a **Close** button. `GET /api/compose/deploy-job/:id` exposes the job's status + log

---

## [2.0.65] - 2026-06-12

### Added — Update a remote folder-deployed project (re-upload + rebuild)
- A remote project deployed from a folder now has an **↻ Update** button: re-pick the (updated) local folder, the files are uploaded to the project's **existing folder on the server**, and `docker compose up -d --build` applies the changes — no need to delete and redeploy
- Two modes: **overwrite** (default — changed/new files only, keeps the rest) or **clean replace** (wipe the folder's contents first). The project name and target path are locked to the existing deployment

---

## [2.0.64] - 2026-06-12

### Improved — pick the deploy folder by browsing the server
- The remote **Deploy from folder** dialog now has a **📁 Browse** button: navigate the server's directory tree (starting at your home) and pick the parent folder — the project folder is created under it. The path field is still editable, and the default stays `~/.dockgate/projects/<project>`
- Clearer note: the files **persist on the server** through Down/Up/restart and are removed **only** when you Delete the project with “remove files”
- `GET /api/files/context` now also returns the remote `home` directory

---

## [2.0.63] - 2026-06-12

### Added — Delete a whole Compose project (containers + files)
- A new **🗑 Delete** button on each project: stops & removes the containers (`docker compose down`), and — with a clear confirmation — also removes the **project files** (the folder on the remote server, or the DockGate-managed files) and, optionally, the **data volumes** (irreversible). Then DockGate stops tracking it
- For remote projects this runs `docker compose down` and `rm -rf` **in the project's own folder on the remote host** (the path DockGate stored). Safety guard: only deep, absolute paths are ever removed — never `/`, `/home`, a home root, or anything with `..`
- `DELETE /api/compose/:project?volumes=&files=` — audited

---

## [2.0.62] - 2026-06-12

### Added — Deploy a folder TO the remote server (files live & run there)
- When a remote SSH server is active, **Deploy from folder** can now put the project **on that server**: pick the target folder (default `~/.dockgate/projects/<project>`), the files are uploaded there over SFTP, and `docker compose up` runs **in that folder on the remote** — so **bind-mounts and build contexts resolve correctly and the files persist** where they run (you can SSH in and find them)
- Up / Down / Restart / **Rebuild** (`up -d --build`) for a remote project run `docker compose` in its remote folder over SSH. A remote project that's brought down stays listed (via a small local pointer) so you can bring it back up
- Local deploys are unchanged (files stay on DockGate). Requires `docker compose` (v2) on the remote; falls back with a clear message if missing

---

## [2.0.61] - 2026-06-12

### Added — Files: a server file manager (remote SSH/SFTP)
- New **Files** section (sidebar → Monitor) to manage files on the **active server** over SFTP: browse folders, **upload**, **download**, create folders, **rename**, and **delete** — DockGate uses the SSH key/password it already stores, no extra setup
- Path breadcrumb + up/refresh, per-row download/rename/delete, drag-to-folder navigation. Every operation is audited (`upload`/`download`/`mkdir`/`rename`/`delete`)
- When **Local** is the active server, the page shows a "switch to a remote server" notice (local host browsing is intentionally not enabled). Refuses to delete `/`

---

## [2.0.60] - 2026-06-12

### Added — Compose project file browser/editor (not just the YAML)
- A managed Compose project keeps more than `docker-compose.yml` — **Dockerfile, .dockerignore, .env, config files** (from Deploy-from-folder/Git). The new **📁 Files** button on each project lists them all and lets you **view and edit** any text file, add a new file, or delete one (the compose file itself is protected)
- Endpoints: `GET /api/compose/:project/tree`, `GET/PUT/DELETE /api/compose/:project/filecontent`. Path-traversal + symlink-escape guarded; the stored git token (`.dockgate-git.json`) and `.git` internals are hidden; binary/oversized files are flagged (not opened); edits are audited (`file-edit` / `file-delete`)

---

## [2.0.59] - 2026-06-12

### Added — System (host) terminal
- The Terminal page now has two tabs: **🐳 Container** (the existing exec-into-a-container shell) and **💻 System** — a shell on the **server itself**
- The System terminal targets the **active server from the header**: a **real SSH shell** on a remote host (DockGate already holds the key/password — manage it directly: apt, systemctl, docker…), or the DockGate container shell when Local is active. No separate connection setup — it follows whichever server you've switched to
- Audited as `hostterm_open` with the host name; sessions are cleaned up on disconnect

---

## [2.0.58] - 2026-06-12

### Fixed — Compose editor opened empty for `.yaml` projects
- The editor (and managed-project detection) only looked for `docker-compose.yml`, so a project deployed with **`docker-compose.yaml`** (e.g. via Deploy from folder) opened as an empty "paste YAML to adopt" editor even though its file was right there. Now **all standard names** are found: `docker-compose.yml/.yaml`, `compose.yml/.yaml`
- Editing writes back to the project's **existing** compose filename — previously an adopt would create a second `.yml` next to the `.yaml`, and since Docker Compose prefers `.yaml`, edits silently never applied
- Remote deploys and validation use the same lookup (a `.yaml` managed project now works on a remote host too)

---

## [2.0.57] - 2026-06-12

### Fixed — Events page no longer sits on "Waiting for events…"
- The Events page now **replays recent history** when it opens (Docker `since`), then keeps streaming live — previously it only showed events that happened *after* the page was opened, so on a quiet host it looked stuck on "Waiting for events…" until the next activity burst
- New **range selector**: Last 15 min / **Last 1 hour** (default) / Last 24 hours / Live only — switching ranges re-subscribes instantly

---

## [2.0.56] - 2026-06-12

### Improved — Deploy from folder shows live per-file upload progress
- Files now upload **one by one** into a staging session, so the dialog shows a live list — **"12 / 45 uploaded, 33 remaining"** counter, progress bar, and a scrolling file list with per-file status (· waiting → ⏳ uploading → ✓ done / ✗ failed)
- New endpoints: `deploy-folder-start` → `deploy-folder-file` (per file) → `deploy-folder-finish` (validate + `compose up`), plus `deploy-folder-abort`; stale sessions are cleaned up automatically (30min TTL)
- Side benefit: no single giant request anymore — large folders no longer brush against the request-size limit, and a failure shows exactly which file it stopped on
- The original single-shot `POST /api/compose/deploy-folder` endpoint still works (API compatibility)

---

## [2.0.55] - 2026-06-11

### Fixed — audit-log coverage gaps (full-app audit)
A 143-action audit of every section confirmed all mutations are logged except four gaps — now closed:
- **Build start is audited** (`build_start`) — previously only the outcome (`build_success`/`build_failed`) was logged, so a cancelled or never-finishing build left no trace
- **Build cancel is audited** (`build_cancel`) — destroying an active build is a state-changing operation and now appears in the Audit Log with the build's tag and id
- **Network attach/detach is dual-logged** — alongside the existing network-perspective entry, a container-perspective entry (`network-connect`/`network-disconnect`) is written so the action shows up in the container's history too
- **Registry operations log `server: local`** — registries live in DockGate's own DB (control-plane), so their audit entries no longer inherit the active Docker host's name

---

## [2.0.54] - 2026-06-11

### Fixed — "Payload Too Large" when deploying from a folder
- The global 5MB JSON body limit was rejecting folder uploads before the route's own limit applied (a folder of files is sent as base64 JSON, which inflates ~33%). The body parser is now **path-aware**: `/api/compose/deploy-folder` accepts up to **100MB** (≈50MB of files), every other endpoint keeps the 5MB limit
- Oversized requests now return a **clean JSON 413** ("Request body too large…") instead of an HTML error page
- Raised the WebSocket `maxHttpBufferSize` to 10MB so large build-log / exec streams don't trip the 1MB default

---

## [2.0.53] - 2026-06-11

### Added — Deploy from Git (clone, re-deploy, webhook)
- **Compose → "Deploy from Git"** — clone a repo (branch + monorepo subdir supported), then `docker compose up` on the active host (local or remote). Private repos: supply an access token (embedded into the https URL, never logged). `POST /api/compose/deploy-git`
- **Re-deploy** — the project detail dialog shows the repo/branch and a **Redeploy (pull latest)** button: fetches the latest commit, hard-resets, and `up --build`. `POST /api/compose/:project/redeploy`
- **Webhook** — each Git project gets a secret **webhook URL**; POST to it (e.g. a GitHub push webhook) to auto re-deploy. Secured by the per-project key; wrong/missing key → 403. `POST /api/compose/webhook/:project?key=…`
- Shallow clone with an automatic **full-clone fallback** for servers that don't support it (dumb-HTTP / older git). The Docker image now includes `git`

> Verified end-to-end: cloned a public repo, deployed over HTTP with the shallow→full fallback, re-deployed, and triggered a webhook (right key → redeploy, wrong key → 403).

---

## [2.0.52] - 2026-06-11

### Added — Deploy from a folder
- **Compose → "Deploy from folder"** — pick a local project folder (containing a `docker-compose.yml`); DockGate uploads it as a managed project and runs `docker compose up`. Works on the **active host**, so you can deploy a ready project straight to a **remote SSH server**. `.git` / `node_modules` are skipped, subfolders are preserved, paths are sanitized (no escaping the project dir). `POST /api/compose/deploy-folder`

---

## [2.0.51] - 2026-06-11

### Improved — "Join a node" dialog redesigned
- A small **cluster diagram** (this manager + the nodes that join it), a clear **① One-click** card (server + role + Join, or a "+ Add a server" shortcut), and a collapsed **② Manual command** section
- **Copy buttons** for the worker/manager join commands and the firewall ports; long tokens are shown **truncated** (the full command is copied)

---

## [2.0.50] - 2026-06-11

### Changed
- **Tighter sidebar spacing** so all navigation items fit without a scrollbar (slightly reduced item padding and group gaps)

---

## [2.0.49] - 2026-06-11

### Fixed — stable Swarm page (no flicker on SSH)
- The Swarm page no longer rebuilds the whole page on its 10s auto-refresh. Now it refreshes **only the active tab**, and **only touches the DOM when the data actually changed** — so the table no longer blinks, scroll position is kept, and row buttons stay responsive. This is most noticeable on a remote SSH host, where each refresh previously rebuilt everything over the slower SSH transport
- The Initialize-Swarm form is no longer re-rendered by the poll (your advertise-address input isn't cleared mid-typing)

---

## [2.0.48] - 2026-06-11

### Added — Compose & Swarm stacks now work on remote SSH hosts
- **Compose actions and `docker stack deploy` no longer require switching to Local.** When a remote SSH host is active, the host CLI is pointed at that daemon via `DOCKER_HOST=ssh://…` (using DockGate's stored key), so you can deploy/manage Compose projects and Swarm stacks on a remote host straight from the UI
- Compose: only **DockGate-managed** projects deploy remotely (the compose file lives on DockGate); private images still pull via stored registry credentials
- Requires a **key-based** SSH server **without a passphrase** (the SSH connection helper runs non-interactively); password/passphrase servers get a clear message to switch to Local. Bind-mount paths resolve on the remote host
- The Dockerfile now installs `openssh-client` for the remote CLI transport

> Verified end-to-end on a real remote host: created a Compose project + deployed a Swarm stack remotely, then tore them down — all from DockGate.

---

## [2.0.47] - 2026-06-11

### Improved
- **Network create form guides overlay use** — selecting the `overlay` driver now auto-enables **Attachable** and explains that it needs Swarm mode and spans the cluster. This is the network you create for swarm services (pairs with the service form, which now lists only overlay networks)

---

## [2.0.46] - 2026-06-11

### Fixed
- **Swarm service form only offers overlay networks now** — picking a local bridge network used to fail with `network ... cannot be used with services` (403). A service can only attach to a swarm-scoped **overlay** network, so the dropdown lists only those (with a hint to create one when there are none)
- **Removed the SSH "Connection troubleshooting" panel** from the Add-Server form (the Grant Docker button and the on-error hint already cover it)

---

## [2.0.45] - 2026-06-11

### Improved — in-app guidance for private images/repos
- Inline hints added where they're needed: **Pull Image** (use the full ref + add the registry first), **Compose editor** (private images pull automatically with a saved registry — no `docker login`), **New Build** (private `FROM` uses saved registry creds; private repos use the Git token field). Complements the existing GHCR hint on the Registries form

---

## [2.0.44] - 2026-06-11

### Added — one-click Docker access on remote servers
- **"Grant Docker access"** for SSH servers — a checkbox on the Add-Server form (runs it right after adding) and a per-server button. DockGate SSHes in and runs `sudo usermod -aG docker <user>` for you, so you don't have to do the stage-2 step manually. Requires the SSH user to have **passwordless sudo**; the action is audit-logged
- Runs in an isolated worker process so it never contends with the live event-monitor SSH connections

---

## [2.0.43] - 2026-06-11

### Added — Swarm node auto-join (zero manual commands)
- **Initialize Swarm on a remote SSH server now auto-advertises that server's host IP** — leave the advertise field blank and other VPSes can reach it (no more useless `127.0.0.1`)
- **Join-token address is corrected** — a loopback/empty advertise is replaced with the active server's host so the printed `docker swarm join` command is actually usable
- **One-click "Join a node"** — instead of copy-pasting a command, pick one of your DockGate SSH servers and a role (worker/manager); DockGate connects to that server and runs the join for you. Guarded when the manager only advertises a loopback address
- New endpoint `POST /api/swarm/nodes/join { serverId, role }`

> Firewall ports between nodes (`2377/tcp`, `7946/tcp+udp`, `4789/udp`) still have to be opened on your provider/host — DockGate can't do that for you.

---

## [2.0.42] - 2026-06-11

### Added — "P3" private registries & GitHub repos end-to-end
- **Builds can now pull private base images** — stored registry credentials are sent as the build's `X-Registry-Config`, so `FROM ghcr.io/you/private:tag` works in Git-context and inline-Dockerfile builds
- **Build from a private Git repo** — the New Build form has an optional **Git token** field (e.g. a GitHub PAT); it's embedded only into the clone URL handed to the daemon and is **never stored or logged** (the build history keeps the clean URL)
- **Compose can pull private images** — `docker compose up/pull/build` now runs with a generated `DOCKER_CONFIG` containing the stored registry credentials (previously compose ignored DockGate's registries and required a manual `docker login`)
- **Compose Build action** — a **Build** button per project runs `docker compose build` (for services with a `build:` section)

---

## [2.0.41] - 2026-06-11

### Added — "P2b" Swarm cross-module handoffs
When the active daemon is a swarm manager, Swarm entry points appear across the app:
- **Images** — a "Deploy as Swarm service" action on every image row (opens the service form prefilled)
- **Run Container modal** — a "**Deploy to Swarm →**" button that converts the filled form (image, name, ports, volumes, env, command) into the Swarm service form
- **Compose editor** — "**Deploy as Stack (Swarm)**" deploys the same YAML with `docker stack deploy`
- **App Templates** — stack templates get a one-click "**Swarm**" deploy (stack name prompt → `docker stack deploy`)

---

## [2.0.40] - 2026-06-11

### Added — "P2a" Swarm service form at full power
- **New Swarm Service form completely rebuilt** (now a shared module, `swarm-service-modal.js`) with every Run-Container convenience: **Docker Hub search**, local-image autocomplete, **image ENV-key suggestions**, row-based **ports** (with **udp**), row-based **mounts** with volume autocomplete + quick presets, **Paste .env** bulk import, command override
- **New swarm-only fields:** restart condition (any / on-failure / none), **overlay network** attach (service-to-service DNS), **CPU / memory limits** per replica, and **mount existing secrets & configs** into the service (dropdown + target path)
- Backend `createService` extended accordingly (RestartPolicy, Resources.Limits, TaskTemplate.Networks, SecretReference/ConfigReference)

---

## [2.0.39] - 2026-06-11

### Fixed — "P1" correctness & audit batch
- **Memory limit no longer disables swap** — Edit Resources used to set `MemorySwap = Memory` (which means *zero* swap). Now `MemorySwap = -1` (unlimited swap; only RAM is capped)
- **Audit log coverage** — 15+ previously-unlogged actions are now recorded: container **export** / **file download**, image **save**, volume **file download**, registry **credential test** (success *and* failed attempts), build history **hide/unhide/delete/clear**, notification-log clear, SMTP/Telegram tests, favorites/notes/tags changes. Settings changes now log **before → after** values
- **Swarm gating hardened** — every swarm endpoint now checks the node is a **manager** (workers got raw Docker errors before); service/node/secret/config mutations gate up-front with a clear 400
- **Secret/config size pre-validation** (500KB / 1000KB) with friendly errors
- **Leader node remove** is blocked with a clear message (demote first)
- **Helper-image errors** (volume backup/browse on air-gapped remote hosts) now explain the cause instead of an opaque failure

---

## [2.0.38] - 2026-06-11

### Fixed / Improved — "P0" quality batch
- **Cache-busting** — every JS/CSS asset URL in `index.html` is stamped with `?v=<version>` (server-side substitution). Browsers now pick up new code right after an update — no more hard-refresh to see new features
- **SSH server form** — the Add form now has a **key passphrase** field (it existed only in Edit before, so adding a server with an encrypted key always failed). Auth-failure messages now explain the two stages: *SSH login* ("All configured authentication methods failed" → user/key/passphrase) vs *Docker permission* (`usermod -aG docker`), with a matching troubleshooting panel
- **Swarm init form** — advertise-address hints: single host → `127.0.0.1`; multi-VPS → run init on that VPS (switch the active server) with *its own* public IP
- **Registries form** — GHCR how-to hint (PAT with `read:packages`, pull via full `ghcr.io/user/image:tag` ref)

---

## [2.0.37] - 2026-06-11

### Added — Swarm secrets & configs
- **Secrets & Configs tab** in Swarm — list, create (name + value, base64-encoded server-side) and remove swarm **secrets** (write-only) and **configs**. `GET/POST /api/swarm/secrets` · `DELETE /api/swarm/secrets/:id` · same for `/configs`

This completes the Swarm module: cluster bootstrap (init/join/leave/nodes), services (create/scale/update/logs/inspect/remove), stacks (deploy/remove), and secrets/configs.

---

## [2.0.36] - 2026-06-11

### Added — Swarm cluster bootstrap (multi-VPS)
- **Initialize Swarm** from the UI — turn a non-swarm host into a manager (with an optional advertise IP). No SSH needed. `POST /api/swarm/init`
- **Join a node** — shows the ready-to-run `docker swarm join` commands (worker & manager) plus the required firewall ports, so you can add other VPSes to the cluster. `GET /api/swarm/jointokens`
- **Leave Swarm** — `POST /api/swarm/leave`
- **Remove node** — drop a node from the cluster (Nodes tab). `DELETE /api/swarm/nodes/:id`

> Point DockGate at a manager node (Local or an SSH server) and it manages the whole multi-VPS cluster — every node, service and stack — from one place.

---

## [2.0.35] - 2026-06-11

### Added — Swarm stacks
- **Stacks tab** in Swarm — list stacks (grouped by the `com.docker.stack.namespace` label, works on any active daemon), drill into a stack's **services**, **Deploy** a stack by pasting a compose file (`docker stack deploy`, local host), and **Remove** a stack. `GET /api/swarm/stacks` · `POST /api/swarm/stacks/deploy` · `DELETE /api/swarm/stacks/:name`
- Deploy/remove are local-host operations (use the host CLI, like Compose); listing works against the active daemon

---

## [2.0.34] - 2026-06-11

### Added — Swarm service management (filling the gaps)
- **Create Service** — a New Service form (name, image, replicas, ports, mounts, env) deploys a replicated service. `POST /api/swarm/services`
- **Rolling update** — change a service's image (triggers a swarm rolling update). `POST /api/swarm/services/:id/update`
- **Service logs** — view a service's aggregated logs across replicas. `GET /api/swarm/services/:id/logs`
- **Service inspect** — raw service spec in a modal. `GET /api/swarm/services/:id`
- All mutations are written to the Audit Log (create / update / scale / remove)

> Publishing ports on a service requires the swarm's ingress network (present on a normal `docker swarm init`).

---

## [2.0.33] - 2026-06-11

### Added — Docker Swarm
- **Swarm page** (Orchestration group) — manage the active daemon when it's a swarm manager:
  - **Services** — list (name, image, mode, replicas, ports), **scale** replicated services, view **tasks** (per-replica state), remove
  - **Nodes** — list (hostname, role, state, availability, leader), set availability (**activate** / **drain**)
  - Gracefully shows "not in swarm mode" when the host isn't a manager. Uses the same dockerode client + SSH Proxy, so it works on remote hosts too
- New endpoints under `/api/swarm` (`/`, `/services`, `/services/:id`, `/services/:id/scale`, `/services/:id/tasks`, `/nodes`, `/nodes/:id/availability`)

---

## [2.0.32] - 2026-06-10

### Changed
- **System info moved into Settings** — the "System" page is no longer a sidebar item; it's now a **System** tab under Settings (engine version, OS, drivers, raw Docker API inspect). Keeps the sidebar focused on day-to-day actions

---

## [2.0.31] - 2026-06-10

### Added — "L3" inline build
- **Inline Dockerfile build** — the New Build dialog now has a **Git/URL** vs **Inline Dockerfile** toggle; paste/type a Dockerfile (no Git context needed) and DockGate builds it from a generated tar context
- **Build from this** on the Images page — opens the build dialog with `FROM <image>` pre-filled, so you can extend an image into a new one (the practical answer to "edit an image", since image layers are immutable)

---

## [2.0.30] - 2026-06-10

### Added — "L3" container file browser
- **Files tab** in Container Detail — browse the container's filesystem, **download** files, and **copy in** (upload a `.tar` that's extracted at the current path). Uses `docker cp`-style `exec` / `putArchive` (running containers). `GET /api/containers/:id/files` · `GET /api/containers/:id/file` · `POST /api/containers/:id/upload`

---

## [2.0.29] - 2026-06-10

### Added — "L3" volume file browser
- **Browse a volume's files** — navigate directories and download individual files, served by a read-only helper container. Path traversal is blocked (`../` is stripped). `GET /api/volumes/:name/files?path=` · `GET /api/volumes/:name/file?path=`

---

## [2.0.28] - 2026-06-10

### Added — "L3" volume restore
- **Restore a volume** from an uploaded `.tar.gz` (the inverse of Backup) — a helper container extracts the streamed upload into the volume, completing the backup ⇄ restore round-trip. `POST /api/volumes/:name/restore`

---

## [2.0.27] - 2026-06-10

### Fixed
- **App Templates now auto-load the big catalog** — previously an empty/unset `template_url` showed only the bundled ~15. Now empty = the **default community catalog (500+ apps)**, fetched automatically (falls back to bundled if offline). To force the offline set, pick **Bundled (offline only)** in the Source picker (sets the sentinel `bundled`). This fixes instances that had the source cleared during testing

---

## [2.0.26] - 2026-06-10

### Improved
- **Network create form auto-suggests networking** — opening **New Network** (or **Clone**) now pre-fills a **free** private subnet, gateway and IP range (scanning existing networks to avoid overlaps), with a **↻ Suggest** button to cycle to the next free range. No more typing CIDRs by hand
- The driver list stays bridge / macvlan / ipvlan / overlay — `host` and `none` are Docker's built-in singleton networks and **cannot be created** (so they're intentionally not offered)

---

## [2.0.25] - 2026-06-10

### Added — "L2" images
- **Save** an image to a `.tar` download (`docker save`). `GET /api/images/:id/save`
- **Load** images from an uploaded `.tar` (`docker load`) — air-gap transfer. `POST /api/images/load` (streamed, no buffering)

> "Build from this image" (I3) is deferred to a later release — the build pipeline currently only accepts a Git/URL context, so it needs inline-Dockerfile build support first.

---

## [2.0.24] - 2026-06-10

### Added — "L2" volumes
- **New Volume** — a create form (name, driver, driver options, labels). The Volumes page had no create UI before
- **Backup** — download a volume's contents as a `.tar.gz` (a throwaway helper container mounts it read-only and streams the tar). `GET /api/volumes/:name/backup`
- **Clone** — copy a volume's data into a new volume (helper container `cp -a`). `POST /api/volumes/:name/clone`

> Volumes can't be relocated in Docker, so **clone** (copy to a new volume) is the practical equivalent. Restore-from-upload is planned for a later (L3) release.

---

## [2.0.23] - 2026-06-10

### Added — "L2" networks
- **New Network** — a rich create form (driver: bridge / macvlan / ipvlan / overlay, subnet, gateway, IP range, internal, attachable, IPv6). The Networks page had no create UI before
- **Clone** an existing network — prefills the create form from its config (a network's driver/subnet are immutable, so cloning to a new network is the real "edit")

---

## [2.0.22] - 2026-06-10

### Added — "L2" container actions
- **Edit Resources** — change a container's CPU / memory limits and restart policy live (`docker update`). `POST /api/containers/:id/update`
- **Recreate** — rebuild a container with (optionally) a new image while preserving its config (env, ports, volumes, networks); volume data is kept, secondary networks are re-attached. The "update an app" flow. `POST /api/containers/:id/recreate`
- **Commit** — save a container's current state as a new image. `POST /api/containers/:id/commit`

---

## [2.0.21] - 2026-06-10

### Added — "L1" page features
- **Networks**
  - **Connect / disconnect a container** to/from a network, live, from the inspect modal (which now also shows subnet & gateway). Networks themselves are immutable in Docker, so this membership control is the real "edit". `POST /api/networks/:id/connect` · `POST /api/networks/:id/disconnect`
- **Images**
  - **Layers / history** viewer (each layer's command + size). `GET /api/images/:id/history`
  - **Tag management** — add a tag or untag a specific reference. `POST /api/images/untag`
- **Container detail**
  - New **Processes** tab — live process list (`top`) + a **one-off command** runner. `GET /api/containers/:id/top` · `POST /api/containers/:id/exec`
  - **Export** the container filesystem as a `.tar` download. `GET /api/containers/:id/export`
  - **Healthcheck** detail in Overview (status, failing streak, last check outputs)
  - **Connect / disconnect networks** directly from the Network tab

---

## [2.0.20] - 2026-06-10

### Changed
- **Compose guided "Add service" is now row-based** — the ports, volumes and environment inputs use the same repeatable-row UX as the Run Container modal: per-row fields, volume host autocomplete (existing volumes) + presets (docker.sock / ./data / ./config), **Paste .env** bulk import, and image-declared env-key suggestions. The service block is still generated into the editable YAML. The editor's action button also moved to the sticky modal footer

---

## [2.0.19] - 2026-06-10

### Added
- **Faster volume & environment entry** in the Run Container modal:
  - **Volumes** — the host field autocompletes from your existing Docker volumes (datalist), plus quick-preset buttons (**docker.sock**, **./data**, **./config**) that drop in a prefilled volume row
  - **Environment** — a **Paste .env** panel bulk-imports `KEY=VALUE` lines (handles `#` comments, `export `, and quotes) into individual env rows; the env KEY field also suggests the selected **local** image's declared variables (read from its `Config.Env`)
- The Compose guided "Add service" panel gets the same **volume presets** and **Paste .env** import (adapted to its comma-separated fields)
- Shared `parseDotEnv()` helper underpins both

---

## [2.0.18] - 2026-06-10

### Added
- **Search Docker Hub** — the Run Container modal and the Images "Pull Image" dialog now have a **Search Docker Hub** button. It opens a live search (repository name, description, star count, official badge); picking a result fills the image field (and ticks "pull" in the Run modal). Backed by a new `GET /api/images/search?q=` endpoint that proxies the Docker Hub search API server-side (the Hub API isn't reachable from the browser due to CORS)
  - Note: *pulling* from Docker Hub already worked by typing any image name — this adds **discovery/search** so you don't have to know the exact name

---

## [2.0.17] - 2026-06-10

### Changed
- **App Templates now shows a large catalog out of the box** — the default source is the community **500+** Portainer-format catalog (databases, web apps, tools — overlapping what Portainer and Coolify offer). It loads automatically; if offline it falls back to the bundled ~14. A **Source** picker (Bundled / Portainer Official / Community 500+ / custom URL) lets you switch or go fully offline

### Fixed
- **Modals now fit the screen** — modals use a flex layout so the header and action footer stay fixed while only the body scrolls. Tall modals (Run Container, Compose editor) no longer overflow the viewport, and the primary action button is always visible (the Run button moved into a sticky footer)
- **No more horizontal scrolling in the Run Container modal** — the port / volume / env rows now shrink correctly (`.input` gets `min-width: 0`), so adding rows no longer pushes the modal sideways. Same fix also tidies the multi-column server-edit form

---

## [2.0.16] - 2026-06-10

### Added
- **App Templates** — a new marketplace page (Build → App Templates) with a searchable, category-filterable catalog of ready-to-deploy apps in the Portainer "App Templates" v2 format. Click **Deploy**:
  - a **container** template prefills the Run Container modal (image, name, ports, volumes, env, pull)
  - a **stack** template prefills the Compose editor with its `docker-compose.yml`, ready to create & up
- **Bundled catalog** — ships with ~14 curated apps (nginx, postgres, redis, mysql, mongo, grafana, adminer, Uptime Kuma, WordPress+MySQL, Nextcloud+PostgreSQL, …) that work fully offline
- **Configurable source** — Settings key `template_url`: point it at a Portainer-format catalog URL (e.g. a community list) to load 100+ apps; blank uses the bundled set. Remote catalogs are cached and fall back to the bundled set if unreachable
- New endpoints: `GET /api/templates`, `GET /api/templates/stackfile?url=` (server-side proxy, http(s) only)

### Changed
- The Compose editor (New Project / Edit YAML) is now a shared global (`public/js/compose-editor.js`) so the Templates page can reuse it; `openRunContainerModal()` now also accepts a full prefill object (image + ports + volumes + env). No change to existing behaviour

---

## [2.0.15] - 2026-06-10

### Added
- **Edit registered SSH servers from the UI** — each remote server in Settings → Servers now has an **Edit** button that opens a modal to change host, port, username, description, or auth (private key / password). Leaving the key/password blank keeps the current secret; a **Test Connection** verifies the saved server or the new credentials. (The `PUT /api/servers/:id` endpoint already existed — this wires up the front-end.)

### Changed
- **Display timezone now applies everywhere** — the timestamps on Volume detail, Builds (history/detail), Container detail (Created/Started/Finished), and the Notification Log now honour the timezone selected in Settings → General, instead of always using the browser's local time

### Fixed / Security
- **Secrets no longer leak into the audit log** — when a container is created with environment variables, the audit record now masks the values (`DB_PASSWORD=***`) instead of storing them in plain text (which also flowed into the CSV export). Keys are kept, values are redacted

---

## [2.0.14] - 2026-06-10

### Added
- **Private registry credentials** — a new **Registries** page (under Manage) to store and manage credentials for private image registries (ghcr.io, GitLab, Docker Hub private, self-hosted, …). Add / edit / delete, plus a **Test login** that verifies the credentials against the registry before saving. Passwords are never sent back to the browser (masked)
- **Automatic authentication on pull** — stored credentials are matched to an image by its registry host, so pulling a private image now works everywhere it already worked for public images: the Images "Pull", the **Run Container** modal, and the `/run` pull-on-missing path — no code change needed at the call sites
- **Push images to a registry** — `POST /api/images/push` pushes a tagged local image to its registry, authenticating with the matching stored credential
- New endpoints: `GET/POST /api/registries`, `PUT/DELETE /api/registries/:id`, `POST /api/registries/test`

### Notes
- Credentials are stored in the local SQLite database (same trust model as the existing SSH server passwords — protected by the `data/` volume on the host; DockGate is self-hosted, single-user)

---

## [2.0.13] - 2026-06-02

### Changed
- **CI:** bumped `actions/checkout` and `actions/setup-node` from `@v4` to `@v6` — both now run on the Node 24 runtime, clearing GitHub's Node 20 deprecation warning (Node 20 actions are force-migrated on 2026-06-16). No change to application code or behaviour

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
