<p align="center">
  <img src="https://img.shields.io/badge/DockGate-v2.0.50-00d4aa?style=for-the-badge&logo=docker&logoColor=white" alt="DockGate">
  <img src="https://img.shields.io/badge/Node.js-18-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/Changelog-v2.0.50-orange?style=for-the-badge" alt="Changelog"></a>
  <img src="https://img.shields.io/badge/CPU-≤0.5_core-brightgreen?style=for-the-badge" alt="CPU">
  <img src="https://img.shields.io/badge/RAM-<256MB-success?style=for-the-badge" alt="RAM">
  <img src="https://img.shields.io/badge/Lines-~9.6k-informational?style=for-the-badge" alt="Lines of Code">
</p>

<h1 align="center">DockGate</h1>

<p align="center">
  <strong>Lightweight, self-hosted Docker management panel.</strong><br>
  No Docker Desktop. No cloud. No registration. Just run and manage.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#screenshots">Screenshots</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#api-reference">API Reference</a> &middot;
  <a href="#websocket-events">WebSocket</a> &middot;
  <a href="#contributing">Contributing</a>
  <br>
  <a href="CHANGELOG.md">📋 Changelog</a>
</p>

---

## What is DockGate?

DockGate is a browser-based Docker control panel that runs as a single container. It connects directly to your Docker socket (`/var/run/docker.sock`) and gives you full control over containers, images, volumes, networks, and compose stacks — all from a clean, macOS-inspired UI.

Beyond inspecting, DockGate also **does**: run a new container from any image with a guided form, create and edit compose projects in the browser, store private-registry credentials (auto-used on pull/push), and manage **remote Docker hosts over SSH** — all from the same panel.

- **Zero config** — no `.env` files, API keys, or accounts
- **Ultra-lightweight** — ~30-80 MB RAM, <5% CPU at idle
- **Real-time** — live logs, stats, events, and terminal via WebSocket
- **Multi-host** — manage local + remote SSH daemons from one place
- **Self-contained** — everything runs inside a single Docker container
- **~9,600 lines of JavaScript** — easy to read, easy to contribute

---

## Quick Start

**Prerequisites:** Docker Engine + Docker Compose plugin

### Option 1: Pre-built Image (Recommended)

```bash
mkdir dockgate && cd dockgate
curl -O https://raw.githubusercontent.com/Ali7Zeynalli/dockgate/main/docker-compose.yml
docker compose up -d
```

### Option 2: Build from Source (Development)

```bash
git clone https://github.com/Ali7Zeynalli/dockgate.git
cd dockgate
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

This uses `docker-compose.dev.yml` override which adds local build context and source mounts for live editing.

Open **http://localhost:7077** — that's it.

> **Note:** Local builds don't receive auto-updates via Settings. To update, `git pull` and rebuild.

### Update

DockGate has built-in auto-update: **Settings → Software Update → Update Now**

Or manually:
```bash
docker compose pull && docker compose up -d
```

---

## Screenshots

**Dashboard** — Real-time overview: container counts, disk usage, system info, smart insights
<img src="screenshots/1.jpeg" width="100%" alt="Dashboard">

**Containers** — List all containers with status filters, bulk actions, search, group by compose
<img src="screenshots/2.jpeg" width="100%" alt="Containers">

**Container Detail** — 10-tab deep inspect: overview, logs, terminal, stats, environment, ports, volumes, network, inspect, history
<img src="screenshots/4.jpeg" width="100%" alt="Container Detail">

**Images** — Pull, remove, tag images. Filter by in-use, unused, or dangling
<img src="screenshots/3.jpeg" width="100%" alt="Images">

**Volumes** — Track volume usage, see attached containers, prune unused
<img src="screenshots/5.jpeg" width="100%" alt="Volumes">

**Networks** — View all Docker networks with driver, subnet, gateway, container counts
<img src="screenshots/6.jpeg" width="100%" alt="Networks">

**Builds & Cache** — Monitor build cache entries, clear history to reclaim disk space
<img src="screenshots/7.jpeg" width="100%" alt="Builds">

**Compose Projects** — Auto-discover stacks, run up/down/restart/pull actions
<img src="screenshots/8.jpeg" width="100%" alt="Compose">

**Logs** — Real-time log streaming with search, timestamps, auto-scroll, word-wrap
<img src="screenshots/9.jpeg" width="100%" alt="Logs">

**Terminal** — Interactive shell (bash/sh/zsh) inside any running container via xterm.js
<img src="screenshots/10.jpeg" width="100%" alt="Terminal">

**Cleanup** — Preview what gets deleted before pruning. Reclaim disk space safely
<img src="screenshots/11.jpeg" width="100%" alt="Cleanup">

**Settings** — Tabbed layout: General, Notifications (Email + Telegram), Notification Log, Software Update
<img src="screenshots/12.jpeg" width="100%" alt="Settings">

---

## Features

DockGate has **16 modules** organized in 4 groups, plus multi-host SSH:

### Core

| Module | Description |
|--------|-------------|
| **Dashboard** | Real-time overview — container counts, disk usage, compose stacks, favorites, activity log, and smart insights (warns about stopped containers older than 7 days, unused images wasting disk, dangling layers) |
| **Containers** | Full fleet management — **Run Container** (launch a new container from any image via a guided form: ports, volumes, env, restart policy, network, CPU/memory limits; with **Docker Hub search**, volume autocomplete/presets and bulk **Paste .env**), group by compose project, bulk actions (start/stop/restart/remove multiple), tags, notes, favorites, search by name/image/ID/port, table or card view |
| **Container Detail** | Deep inspect with **12 tabs**: Overview (+ healthcheck), Logs, Terminal, Stats (live CPU/memory charts), **Processes** (top + one-off exec), Environment, Ports, Volumes, Network (+ connect/disconnect), **Files** (browse/download/copy-in), Inspect (raw JSON), History. Plus **Export** filesystem to tar, **edit resources** (CPU/memory/restart live), **Recreate** (update image, keep config) and **Commit** to an image |
| **Images** | Pull (+ **Search Docker Hub**), **push to a private registry**, **Run** (launch a container straight from the image), **Layers** viewer, **Tags** (add/untag), **Save**/**Load** `.tar` (air-gap), **Build from this** (inline Dockerfile), remove, tag — filter by in-use, unused, or dangling |
| **Volumes** | Track usage, see which containers are attached, prune unused. **Create** (driver/opts/labels), **Backup**/**Restore** `.tar.gz`, **Clone**, **browse files** a volume's data |
| **Networks** | View all network types (bridge, host, overlay, macvlan, none), subnet/gateway info, container counts. **Create** (driver/subnet/gateway/internal/attachable/IPv6), **Clone** an existing network, connect/disconnect containers |

### Build

| Module | Description |
|--------|-------------|
| **Builds** | Docker Desktop-style build management — Build History (Docker image layer history with expandable steps, bulk selection & deletion), Build Cache (grouped by image name), Builders (buildx instances), real-time build streaming, build detail with Info/Source/Logs/History tabs |
| **Compose** | Auto-discover projects via `com.docker.compose.project` labels. Stack actions: up, down, restart, pull. **Create & edit projects in the UI** — a raw `docker-compose.yml` editor plus a guided "add service" builder; managed files are stored under `data/compose/<project>/`, validated with `docker compose config`, then brought up |
| **App Templates** | A searchable, category-filtered marketplace of ready-to-deploy apps (Portainer "App Templates" v2/v3 format). **Deploy** a container template → prefilled Run modal; a stack template → prefilled Compose editor. Defaults to the community **500+** catalog (falls back to ~14 bundled offline); a **Source** picker switches between Bundled / Portainer Official / Community / custom URL |

### Monitor

| Module | Description |
|--------|-------------|
| **Logs** | Real-time log streaming with configurable tail (50/100/200/500/1000), timestamps, search filter, auto-scroll, word-wrap |
| **Terminal** | Interactive xterm.js shell with full PTY support — auto-detects bash/sh/zsh, resizable, copy/paste |
| **Events** | Live Docker daemon event stream — create, start, die, destroy, pull, mount, etc. Color-coded by type |
| **System** | Docker version, API version, OS, kernel, CPU count, total RAM, storage driver, interactive disk usage charts |
| **Audit Log** | History of every mutation performed through DockGate — *what* was done, on *which host*, and *from where* (source IP). Filter by server/type/action, full-text search, and CSV export. Since there is no auth, this is a "what + from where" audit, not "who" |

### Manage

| Module | Description |
|--------|-------------|
| **Registries** | Store credentials for private image registries (ghcr.io, GitLab, Docker Hub private, self-hosted, …). Add / edit / delete with a **Test login** that verifies against the registry before saving. Stored credentials are auto-matched by registry host, so pulling/pushing private images "just works" from Images, the Run modal, and Compose. Passwords are never shown back |
| **Cleanup** | Preview-before-prune for: stopped containers, unused/dangling images, unused volumes, unused networks, build cache, or full system prune |
| **Settings** | Tabbed UI: General (theme, default view, shell, **display timezone**, log timestamps, auto-start), Notifications (**Email SMTP** + **Telegram Bot**, 6 alert rules with cooldown), Notification Log, Software Update, **System** info |

### Multi-Host (SSH)

DockGate manages both your **local** Docker socket and the Docker daemons of **remote SSH hosts** — all from one panel.

| Capability | Description |
|------------|-------------|
| **Server switcher** | A switcher in the sidebar lets you jump between **Local** and any registered SSH host. The whole UI (containers, images, logs, terminal, etc.) follows the active server |
| **3 auth modes** | **Private key** (with passphrase support for encrypted keys), **password**, or **SSH agent**. Auth hierarchy: **key > password > agent** |
| **All-host notifications** | A dedicated `EventMonitor` runs per registered host, so alerts arrive from **every** server — not just the active one |
| **Key & credential storage** | SSH private keys are written to `data/ssh-keys/*.pem` (mode `0600`); server records live in the `servers` table of the SQLite database |

**Usage:** Add a host in **Settings → Servers** — provide host, port, username, and one of: private key (+ optional passphrase), password, or leave blank to use the SSH agent. Test the connection before saving, then switch to it (sidebar **SRV** dropdown) to manage that daemon. Existing servers can be **edited** in place (host/port/user/auth) via the row's Edit button. Local can never be deleted.

### Container Actions

`start` · `stop` · `restart` · `kill` · `pause` · `unpause` · `remove` · `rename`

---

## Architecture

```
Browser (Vanilla JS + xterm.js + Chart.js)
    │
    ├── HTTP/REST ──► Express API Server
    │                   ├── /api/dashboard
    │                   ├── /api/servers      (local + SSH multi-host)
    │                   ├── /api/containers
    │                   ├── /api/images
    │                   ├── /api/builds
    │                   ├── /api/volumes
    │                   ├── /api/networks
    │                   ├── /api/compose
    │                   ├── /api/registries  (private registry credentials)
    │                   ├── /api/templates   (app templates catalog)
    │                   ├── /api/cleanup
    │                   ├── /api/system
    │                   └── /api/meta
    │
    └── WebSocket ──► Socket.IO
                        ├── logs:subscribe    → real-time log stream
                        ├── stats:subscribe   → CPU/RAM/network/block I/O stream
                        ├── events:subscribe  → Docker daemon events
                        └── terminal:start    → interactive PTY session
                                │
                                ▼
                        Docker Engine (/var/run/docker.sock)
```

### Project Structure

```
dockgate/
├── Dockerfile                    # Node.js 18 Alpine + docker-cli
├── docker-compose.yml            # Deployment with resource limits
├── package.json                  # 5 deps + 1 optional (node-pty, unused at runtime)
├── server/
│   ├── index.js                  # Express + Socket.IO server (~486 lines)
│   ├── docker.js                 # Docker API wrapper via dockerode — local/SSH client hot-swap (~722 lines)
│   ├── db.js                     # SQLite schema & prepared statements
│   ├── audit.js                  # Central audit-log helper (server + source-IP context)
│   ├── templates.json            # Bundled App Templates catalog (offline)
│   ├── notifications/
│   │   ├── mailer.js             # SMTP email sender via nodemailer
│   │   ├── telegram.js           # Telegram Bot API sender (no deps)
│   │   ├── templates.js          # HTML email templates
│   │   ├── event-monitor.js      # Per-host Docker event watcher + alerting
│   │   └── monitor-manager.js    # Multi-host monitor registry (one monitor per server)
│   └── routes/
│       ├── servers.js            # SSH multi-host management (add/edit/test/switch/remove)
│       ├── registries.js         # Private registry credential CRUD + login test
│       ├── templates.js          # App Templates catalog + compose stackfile proxy
│       ├── containers.js         # Container CRUD, actions & guided run
│       ├── images.js             # Image pull/push/remove/tag
│       ├── volumes.js            # Volume CRUD
│       ├── networks.js           # Network CRUD
│       ├── compose.js            # Compose stack orchestration + create/edit managed projects
│       ├── builds.js             # Build cache list & prune
│       ├── cleanup.js            # Prune operations
│       ├── system.js             # System info/version/df
│       └── settings.js           # Favorites, notes, tags, activity, settings, autostart, SMTP, Telegram, notifications
├── public/
│   ├── index.html                # SPA shell
│   ├── vendor/                   # Locally bundled CDN deps (socket.io, chart.js, xterm, fonts) — air-gap support
│   ├── css/
│   │   ├── design-system.css     # Color tokens, typography, spacing
│   │   ├── layout.css            # Sidebar, topbar, page layout
│   │   └── components.css        # Buttons, cards, tables, modals, toasts
│   └── js/
│       ├── app.js                # Sidebar & navigation
│       ├── router.js             # Client-side SPA router
│       ├── store.js              # Simple reactive state store
│       ├── api.js                # HTTP client + Socket.IO + UI utilities + icons
│       ├── run-modal.js          # Shared "Run Container" guided form (Images + Containers + Templates)
│       ├── compose-editor.js     # Shared Compose editor (Compose page + Templates stacks)
│       ├── hub-search.js         # Shared Docker Hub image search modal (Run + Pull)
│       └── pages/                # 17 page modules
│           ├── dashboard.js
│           ├── containers.js
│           ├── container-detail.js  # 10-tab detail view (~616 lines)
│           ├── images.js
│           ├── volumes.js
│           ├── networks.js
│           ├── compose.js
│           ├── builds.js
│           ├── logs.js
│           ├── terminal.js
│           ├── events.js
│           ├── system.js
│           ├── audit.js          # Audit log (filter/search/CSV)
│           ├── registries.js     # Private registry credentials
│           ├── templates.js      # App Templates marketplace
│           ├── cleanup.js
│           └── settings.js
└── data/
    ├── docker-panel.db           # SQLite (auto-created at runtime)
    ├── ssh-keys/                 # SSH private keys for remote hosts (mode 0600)
    └── compose/                  # UI-created (managed) compose projects
```

### Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Runtime | Node.js (Alpine) | 18 |
| Web Framework | Express | 4.x |
| Real-time | Socket.IO | 4.x |
| Docker SDK | dockerode | 5.x |
| Database | better-sqlite3 (WAL mode) | 11.x |
| Container Terminal | Docker `exec` API (TTY stream) | — |
| Frontend | Vanilla JS, CSS3 | ES2020+ |
| Terminal UI | xterm.js (bundled in `public/vendor/`) | 5.3.0 |
| Charts | Chart.js (bundled in `public/vendor/`) | 4.4.4 |
| WebSocket Client | Socket.IO Client (bundled in `public/vendor/`) | 4.7.5 |

> **Note:** `node-pty` is listed as an optional dependency but is **not** used at runtime — interactive terminals are served via the Docker `exec` API with a TTY-enabled hijacked stream. All front-end libraries are bundled locally under `public/vendor/`, so DockGate runs in **air-gapped** environments without any CDN access.

---

## API Reference

All endpoints are prefixed with `/api`. All responses are JSON.

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Full summary: container counts, images, volumes, networks, disk usage, insights, favorites, recent activity |

### Containers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/containers` | List all containers (enriched with tags, notes, favorites) |
| GET | `/api/containers/:id` | Full Docker inspect output |
| GET | `/api/containers/:id/stats` | One-shot stats: CPU, RAM, network I/O, block I/O, PIDs |
| GET | `/api/containers/:id/logs` | Fetch logs (`?tail=200&timestamps=false`) |
| POST | `/api/containers/:id/:action` | Execute: `start`, `stop`, `restart`, `kill`, `pause`, `unpause`, `remove`, `rename` |
| POST | `/api/containers` | Create container (raw dockerode config) |
| POST | `/api/containers/run` | Guided run — body: `{ image, name?, pull?, ports[], volumes[], env[], restart, network, cmd, cpus, memory }` → pulls if missing, creates, starts |
| GET | `/api/containers/:id/top` | Running processes inside the container |
| POST | `/api/containers/:id/exec` | One-off command — body: `{ cmd }` → `{ output, exitCode }` |
| GET | `/api/containers/:id/export` | Stream the container filesystem as a tar download |

### Images

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/images` | List all images (with in-use/dangling flags) |
| GET | `/api/images/:id` | Inspect image |
| GET | `/api/images/search?q=` | Search Docker Hub (server-side proxy) — returns `{ name, description, stars, official }[]` |
| GET | `/api/images/:id/history` | Image layer history (command + size per layer) |
| POST | `/api/images/untag` | Remove a specific `repo:tag` reference — body: `{ tag }` |
| POST | `/api/images/pull` | Pull image — body: `{ "image": "nginx:latest" }`. Auto-authenticates if a matching registry credential is stored |
| POST | `/api/images/push` | Push a tagged local image to its registry — body: `{ "repoTag": "ghcr.io/owner/app:1.0" }`. Credential auto-matched by host |
| DELETE | `/api/images/:id` | Remove image (`?force=true`) |
| POST | `/api/images/:id/tag` | Tag image — body: `{ "repo": "myrepo", "tag": "v1" }` |

### Builds

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/builds` | List panel build history |
| GET | `/api/builds/docker-history` | Docker image layer history for all images |
| POST | `/api/builds/docker-history/hide` | Hide image from build history — body: `{ "imageId": "sha256:..." }` |
| DELETE | `/api/builds/docker-history/hidden` | Unhide all hidden images |
| GET | `/api/builds/detail/:id` | Get panel build detail with logs |
| DELETE | `/api/builds/detail/:id` | Delete panel build record |
| DELETE | `/api/builds` | Clear all panel build history |
| GET | `/api/builds/cache` | Build cache grouped by image name |
| POST | `/api/builds/cache/prune` | Clear all build cache |
| GET | `/api/builds/builders` | List buildx builder instances |

### Volumes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/volumes` | List volumes (with attached container info) |
| GET | `/api/volumes/:name` | Inspect volume |
| POST | `/api/volumes` | Create volume |
| DELETE | `/api/volumes/:name` | Remove volume |

### Networks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/networks` | List networks |
| GET | `/api/networks/:id` | Inspect network |
| POST | `/api/networks` | Create network |
| DELETE | `/api/networks/:id` | Remove network |
| POST | `/api/networks/:id/connect` | Attach a container — body: `{ container }` |
| POST | `/api/networks/:id/disconnect` | Detach a container — body: `{ container, force? }` |

### Compose

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/compose` | List detected projects (via container labels) |
| GET | `/api/compose/:project` | Project details and service list |
| POST | `/api/compose/:project/up` | `docker compose -p <project> up -d` |
| POST | `/api/compose/:project/down` | `docker compose -p <project> down` |
| POST | `/api/compose/:project/restart` | `docker compose -p <project> restart` |
| POST | `/api/compose/:project/pull` | `docker compose -p <project> pull` |
| POST | `/api/compose/create` | Create a managed project — body: `{ project, yaml, up? }`. Writes `data/compose/<project>/docker-compose.yml`, validates, optionally brings it up |
| GET | `/api/compose/:project/file` | Read a managed project's `docker-compose.yml` |
| PUT | `/api/compose/:project/file` | Overwrite a managed project's YAML — body: `{ yaml, up? }` |

> **Note:** Compose actions require the host CLI, so they run on the **local** host only. Discovered projects use the `working_dir` label; managed projects (created in the UI) fall back to `data/compose/<project>`, so even a fully `down` managed project can be brought back up.

### Cleanup

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cleanup/preview` | Preview what will be deleted and space to be freed |
| POST | `/api/cleanup/containers` | Prune stopped containers |
| POST | `/api/cleanup/images` | Prune unused images (`?dangling=true` for dangling only) |
| POST | `/api/cleanup/volumes` | Prune unused volumes |
| POST | `/api/cleanup/networks` | Prune unused networks |
| POST | `/api/cleanup/build_cache` | Clear build cache |
| POST | `/api/cleanup/system` | Full system prune (`?volumes=true` to include volumes) |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/system/info` | Docker system info |
| GET | `/api/system/version` | Docker version |
| GET | `/api/system/df` | Disk usage breakdown |

### Servers (Multi-Host)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/servers` | List all servers (local + SSH); indicates the active one |
| POST | `/api/servers` | Add a new SSH server — body: `{ "id", "host", "port", "username", "privateKey?", "passphrase?", "password?", "description?" }` |
| PUT | `/api/servers/:id` | Edit an existing server (only the fields sent are changed) — same body fields |
| POST | `/api/servers/test` | Test a connection before registering |
| POST | `/api/servers/active` | Switch the active server — body: `{ "id" }` |
| DELETE | `/api/servers/:id` | Remove a server (local cannot be deleted) |

> **Note:** Auth hierarchy is **key > password > agent** — if a private key is supplied it is used; otherwise a password; otherwise the SSH agent.

### Registries (Private Registry Credentials)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/registries` | List stored credentials (passwords masked → `hasPassword`) |
| POST | `/api/registries` | Add — body: `{ "name?", "serverAddress", "username", "password" }` (address is unique) |
| PUT | `/api/registries/:id` | Edit — same fields; an empty/omitted password keeps the current one |
| DELETE | `/api/registries/:id` | Remove a credential |
| POST | `/api/registries/test` | Verify against the registry — body: `{ "serverAddress", "username", "password" }` or `{ "id" }`. Returns 401 on bad credentials |

> Credentials are stored in the SQLite `registries` table (same trust model as SSH passwords — protected by the `data/` volume; DockGate is self-hosted). They are matched to an image by registry host on pull/push, with Docker Hub recognised under its canonical aliases.

### App Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/templates` | The catalog (`{ version, templates[], source }`) — from `template_url` (cached) or the bundled set |
| GET | `/api/templates/stackfile?url=` | Server-side proxy that fetches a stack template's compose file (http(s) URLs only) |

> Source is controlled by the `template_url` setting (blank = bundled). The bundled catalog (`server/templates.json`) ships ~14 curated apps that work offline; a remote catalog yields 100+ but falls back to bundled if unreachable.

### Metadata

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/meta/favorites` | List favorites (`?type=container`) |
| POST | `/api/meta/favorites` | Add favorite — body: `{ "id", "type", "name" }` |
| DELETE | `/api/meta/favorites/:id` | Remove favorite (`?type=container`) |
| GET | `/api/meta/notes` | List all notes |
| GET | `/api/meta/notes/:id` | Get note (`?type=container`) |
| POST | `/api/meta/notes` | Set note — body: `{ "id", "type", "note" }` |
| DELETE | `/api/meta/notes/:id` | Delete note (`?type=container`) |
| GET | `/api/meta/tags` | List all tags |
| GET | `/api/meta/tags/:id` | Get tags for resource (`?type=container`) |
| POST | `/api/meta/tags` | Add tag — body: `{ "id", "type", "tag", "color" }` |
| DELETE | `/api/meta/tags/:id/:tag` | Remove tag (`?type=container`) |
| GET | `/api/meta/activity` | Audit log (`?server=&type=&action=&q=&limit=`) |
| GET | `/api/meta/activity/facets` | Distinct servers/types/actions for filters |
| DELETE | `/api/meta/activity` | Clear activity log |
| GET | `/api/meta/settings` | Get all settings |
| POST | `/api/meta/settings` | Update settings — body: `{ "key": "value" }` |
| GET | `/api/meta/autostart` | Get auto-start status |
| POST | `/api/meta/autostart` | Set auto-start — body: `{ "enabled": true }` |
| GET | `/api/meta/smtp` | Get SMTP configuration (password masked) |
| POST | `/api/meta/smtp` | Save SMTP configuration — body: `{ "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "smtp_to" }` |
| DELETE | `/api/meta/smtp` | Clear SMTP configuration |
| POST | `/api/meta/smtp/test` | Send test email |
| GET | `/api/meta/telegram` | Get Telegram bot config (token masked) |
| POST | `/api/meta/telegram` | Save Telegram config — body: `{ "tg_token", "tg_chat_id" }` |
| DELETE | `/api/meta/telegram` | Clear Telegram configuration |
| POST | `/api/meta/telegram/test` | Send test Telegram message |
| GET | `/api/meta/notifications/rules` | Get notification rules (6 types) |
| PUT | `/api/meta/notifications/rules/:type` | Update rule — body: `{ "enabled": true, "cooldown_minutes": 5 }` |
| GET | `/api/meta/notifications/log` | Notification log with channel (`?limit=50`) |
| DELETE | `/api/meta/notifications/log` | Clear notification log |
| GET | `/api/meta/update/check` | Check for updates from GitHub |
| POST | `/api/meta/update/apply` | Pull latest image and recreate the container (local host) |
| GET | `/api/meta/update/instructions` | Manual update instructions |

---

## WebSocket Events

DockGate uses Socket.IO for all real-time data. Connects on the same port (7077).

### Log Streaming

```javascript
// Subscribe
socket.emit('logs:subscribe', { containerId, tail: 100, timestamps: false });

// Receive
socket.on('logs:data', ({ containerId, data }) => {});
socket.on('logs:end', ({ containerId }) => {});
socket.on('logs:error', ({ containerId, error }) => {});

// Unsubscribe
socket.emit('logs:unsubscribe');
```

### Stats Streaming

```javascript
// Subscribe — fires ~1/sec
socket.emit('stats:subscribe', { containerId });

// Receive
socket.on('stats:data', ({
  containerId,
  cpuPercent,       // 0-100
  memoryUsage,      // bytes
  memoryLimit,      // bytes
  memoryPercent,    // 0-100
  networkRx,        // bytes received
  networkTx,        // bytes transmitted
  blockRead,        // bytes read
  blockWrite,       // bytes written
  pids              // process count
}) => {});
socket.on('stats:end', ({ containerId }) => {});
socket.on('stats:error', ({ containerId, error }) => {});

// Unsubscribe
socket.emit('stats:unsubscribe');
```

### Docker Events

```javascript
socket.emit('events:subscribe');
socket.on('events:data', ({ Type, Action, Actor, time }) => {});
socket.on('events:error', ({ error }) => {});
socket.emit('events:unsubscribe');
```

### Interactive Terminal (PTY)

```javascript
// Start session
socket.emit('terminal:start', { containerId, shell: '/bin/sh' });

// Bidirectional data
socket.emit('terminal:input', rawKeyboardData);
socket.emit('terminal:resize', { cols: 80, rows: 24 });
socket.on('terminal:ready', ({ containerId }) => {});
socket.on('terminal:data', ({ containerId, data }) => {});
socket.on('terminal:end', ({ containerId }) => {});
socket.on('terminal:error', ({ containerId, error }) => {});

// Stop session
socket.emit('terminal:stop');
```

### Build Streaming

```javascript
// Start build
socket.emit('build:start', {
  contextType: 'url',
  contextValue: 'https://github.com/user/repo.git',
  tag: 'myapp:latest',
  dockerfile: 'Dockerfile',
  nocache: false,
  pull: false,
});

// Receive real-time logs
socket.on('build:started', ({ buildId }) => {});
socket.on('build:log', ({ buildId, data }) => {});
socket.on('build:complete', ({ buildId, status, duration, imageId }) => {});
socket.on('build:error', ({ buildId, error }) => {});

// Cancel build
socket.emit('build:cancel');
socket.on('build:cancelled', () => {});
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7077` | HTTP server port |
| `NODE_ENV` | `production` | Node environment |

### Custom Port

```yaml
ports:
  - "8080:7077"    # Access on localhost:8080
```

### Resource Limits

Enforced via `docker-compose.yml`:

| Resource | Limit | Reserved |
|----------|-------|----------|
| CPU | 0.50 core | 0.05 core |
| RAM | 256 MB | 64 MB |

Typical usage: ~30-80 MB RAM, <5% CPU at idle.

### Default Settings

| Key | Default | Description |
|-----|---------|-------------|
| `theme` | `dark` | UI theme (dark/light) |
| `refreshInterval` | `5000` | Auto-refresh interval (ms) |
| `defaultView` | `table` | Container list view (table/card) |
| `sidebarCollapsed` | `false` | Sidebar state |
| `logTailLines` | `200` | Default log tail |
| `logTimestamps` | `false` | Show timestamps in logs |
| `logAutoScroll` | `true` | Auto-scroll logs |
| `logWrapLines` | `true` | Word-wrap log lines |
| `terminalShell` | `/bin/sh` | Default container shell |
| `terminalFontSize` | `14` | Terminal font size |
| `dateFormat` | `relative` | Date display (relative/absolute) |
| `confirmDestructive` | `true` | Confirm before destructive actions |

### Database

SQLite (WAL mode) at `data/docker-panel.db` — auto-created, persisted via volume mount.

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `favorites` | Pinned resources | `id`, `type`, `name` |
| `notes` | User notes per resource | `id`, `type`, `note` |
| `tags` | Color-coded labels | `id`, `type`, `tag`, `color` |
| `activity` | Action audit log (what + on which host + from where) | `resource_id`, `resource_type`, `action`, `details`, `server`, `source_ip` |
| `settings` | Panel preferences | `key`, `value` |
| `smtp_config` | SMTP + Telegram config (key-value) | `key`, `value` |
| `notification_rules` | Alert rules (6 event types) | `event_type`, `enabled`, `cooldown_minutes` |
| `notification_log` | Sent/failed notification history | `event_type`, `subject`, `status`, `channel` |
| `build_history` | Panel build records | `image_tag`, `status`, `started_at` |
| `servers` | Registered SSH hosts (multi-host) | `id`, `host`, `username`, `key_path` |
| `registries` | Private registry credentials | `name`, `server_address`, `username`, `password` |

All Docker state is read live from the engine — nothing is cached in the database.

---

## Security

> **Warning:** DockGate requires Docker socket access, which grants **root-equivalent control** over the host.

- Do **not** expose port 7077 to the public internet
- No built-in authentication (by design — it's a local tool)
- Socket.IO CORS is set to `origin: '*'` — safe for localhost, but restrict if deploying on a network
- For remote access, use a VPN or SSH tunnel
- Compose actions are executed via `child_process.exec` — only accessible through the API, not user-injectable

---

## Contributing

Contributions are welcome! Here's how:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally with `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`
5. Commit (`git commit -m 'Add my feature'`)
6. Push (`git push origin feature/my-feature`)
7. Open a Pull Request

### Development

```bash
# Run locally without Docker (requires Docker socket access)
npm install
npm run dev
# Server starts at http://localhost:7077
```

---

## 🌐 Remote Access Solution

> **💡 Need to manage DockGate from anywhere?**
> 
> Use **[NovusGate](https://github.com/Ali7Zeynalli/NovusGate)** — a self-hosted WireGuard® VPN to securely reach DockGate from home, travel, or remote offices **without static IP or port forwarding**.

---


## License

[MIT](LICENSE) — free to use, modify, and distribute with attribution.

**Original Author: Ali Zeynalli** — this attribution must be preserved in all copies and derivative works.

---

<p align="center">
  <strong>DockGate</strong> — Docker management without the bloat.
</p>
