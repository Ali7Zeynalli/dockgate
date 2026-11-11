<p align="center">
  <img src="https://img.shields.io/badge/DockGate-v2.38.4-00d4aa?style=for-the-badge&logo=docker&logoColor=white" alt="DockGate">
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/Changelog-v2.38.4-orange?style=for-the-badge" alt="Changelog"></a>
  <img src="https://img.shields.io/badge/CPU-≤0.5_core-brightgreen?style=for-the-badge" alt="CPU">
  <img src="https://img.shields.io/badge/RAM-≤256MB-success?style=for-the-badge" alt="RAM">
</p>

<h1 align="center">DockGate</h1>

<p align="center">
  <strong>Self-hosted Docker control panel — for your local daemon, a fleet of remote hosts over SSH, and Docker Swarm.</strong><br>
  Manage containers and Compose stacks, run a Swarm cluster, provision and secure fresh servers, monitor hosts, and get alerts — from one browser UI.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#docker-swarm">Swarm</a> &middot;
  <a href="#notifications--edge-agent">Notifications</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#security">Security</a> &middot;
  <a href="#limitations">Limitations</a> &middot;
  <a href="#api-reference">API</a>
  <br>
  <a href="CHANGELOG.md">📋 Changelog</a>
</p>

---

## What is DockGate?

DockGate is a **self-hosted Docker and server-management panel** for one administrator. It runs as a single container, connects to your **local** Docker socket *and* to any number of **remote Docker hosts over SSH**, and lets you operate all of them from one place.

- **One panel, many hosts** — choose the server in use at the top; containers, images, logs, terminal and files follow it.
- **Run & deploy** — run containers from a guided form, build images, create and edit Compose projects (locally or on a remote server), keep a deploy history, and deploy from an App-Templates marketplace.
- **Docker Swarm** — set up a cluster on one or several servers, move Compose projects and containers to it and back, and manage nodes, services, stacks, secrets, configs and networks — each service with its own page like a container's.
- **Keep images current** — a daily newer-image check for containers, Compose services and Swarm services, with safe update and roll back.
- **Server management** — provision a fresh server, create a non-root deploy user, manage SSH access, users and keys, the firewall (incl. Docker ports), fail2ban, time sync and auto updates, and monitor the host.
- **Alerts** — Telegram, email and webhook (Slack, Discord, Teams, ntfy, JSON) for containers, servers, image updates, schedules and Swarm, plus an optional **outbound-only Edge agent** that keeps alerting when DockGate is offline.
- **Authenticated & audited** — one admin password (scrypt + signed session cookie), secrets encrypted at rest, and an audit log of every change.
- **Lightweight** — capped at **256 MB RAM / 0.5 CPU**; vanilla-JS frontend with no build step, works without internet access.

> **Scope:** DockGate is **single-admin** — one password, full control. There are no user accounts or roles. See [Security](#security) and [Limitations](#limitations).

---

## Quick Start

**Prerequisites:** Docker Engine + the Docker Compose plugin.

### Option 1 — Pre-built image (recommended)

```bash
mkdir dockgate && cd dockgate
curl -O https://raw.githubusercontent.com/Ali7Zeynalli/dockgate/main/docker-compose.yml
docker compose up -d
```

### Option 2 — Build from source (development)

```bash
git clone https://github.com/Ali7Zeynalli/dockgate.git
cd dockgate
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Open **http://localhost:7077** and **set an admin password** (min 8 characters). From the internet the first setup also needs a one-time **setup token**, printed in the log (`docker logs dockgate-control-panel`).

### Update

Built-in: **Settings → Software update → Update now** (pulls the latest image and recreates the container in place). Or manually:

```bash
docker compose pull && docker compose up -d
```

> Source builds don't auto-update — `git pull` and rebuild.

### Back up DockGate itself

Back up the `data/` folder (database, SSH keys, `.master.key`, managed compose projects). Volume data is backed up separately: Resources → Volumes, or a volume backup task in Tools → Schedules.

### ⚠️ Note — container restart-loops on SELinux-confined Docker

On most systems (Ubuntu, Debian, Docker Desktop, **Fedora/RHEL with Docker CE**) DockGate runs with no extra steps. If instead the container **restart-loops on first start** with one of:

```
SqliteError: unable to open database file        (code: SQLITE_CANTOPEN)
[EventMonitor:local] Failed to connect: connect EACCES /var/run/docker.sock
```

…then your **Docker daemon confines containers with SELinux** (as `container_t`), which blocks the bind-mounted Docker socket and the `data/` directory — even though the container runs as root. **This is a host Docker setting, not a DockGate bug.**

**Confirm it:**

```bash
docker info --format '{{.SecurityOptions}}'   # if it lists "selinux", that's the cause
```

**Recommended fix** — make Docker behave like standard Docker CE (host-wide):

```bash
# Set "selinux-enabled": false in /etc/docker/daemon.json, then restart Docker
sudo sed -i 's/"selinux-enabled": *true/"selinux-enabled": false/' /etc/docker/daemon.json
sudo systemctl restart docker
```

> **openSUSE Leap 16** ships `/etc/docker/daemon.json` with `"selinux-enabled": true` by default.

**Alternative** — keep SELinux-confined Docker and add this to the `dockgate` service in `docker-compose.yml` (a no-op on non-SELinux hosts):

```yaml
    security_opt:
      - label:disable
```

> ⚠️ Never add `:z`/`:Z` to the `/var/run/docker.sock` mount — relabeling the host's Docker socket can break Docker on the host.

---

## Screenshots

| | |
|:--:|:--:|
| **Dashboard** — the server in use at a glance | **Containers** — stacks, filters, Swarm tasks |
| <img src="screenshots/02-dashboard.png" width="100%" alt="Dashboard"> | <img src="screenshots/03-containers.png" width="100%" alt="Containers"> |
| **Containers · Topology** — live graph of the running stacks | **Container · Terminal** — a shell in the browser |
| <img src="screenshots/23.png" width="100%" alt="Containers Topology"> | <img src="screenshots/11-terminal.png" width="100%" alt="Container terminal"> |
| **Container · Logs** — one log viewer everywhere | **Compose stacks** — up, history, Move to Swarm |
| <img src="screenshots/10-logs.png" width="100%" alt="Logs"> | <img src="screenshots/08-compose.png" width="100%" alt="Compose stacks"> |
| **Swarm · Overview** — servers, managers, tasks, events | **Swarm · Services** — replicas, CPU / memory, ports |
| <img src="screenshots/25-swarm-overview.png" width="100%" alt="Swarm overview"> | <img src="screenshots/26-swarm-services.png" width="100%" alt="Swarm services"> |
| **Swarm · A service's page** — tasks, logs, terminal, files, stats | **Swarm · Stacks** — moved from Compose, from a file, from a container |
| <img src="screenshots/27-swarm-service.png" width="100%" alt="Swarm service page"> | <img src="screenshots/28-swarm-stacks.png" width="100%" alt="Swarm stacks"> |
| **Swarm · Nodes** — role, state, CPU and memory | **Swarm · Cluster settings** — tokens, autolock, backups |
| <img src="screenshots/29-swarm-nodes.png" width="100%" alt="Swarm nodes"> | <img src="screenshots/30-swarm-cluster-settings.png" width="100%" alt="Swarm cluster settings"> |
| **Monitoring** — every server, live and 48 hours | **App templates** — 500+ apps |
| <img src="screenshots/24-monitoring.png" width="100%" alt="Monitoring"> | <img src="screenshots/09-templates.png" width="100%" alt="App templates"> |
| **Volumes** — backup, restore, files, used by | **Audit log** — every change, server and source IP |
| <img src="screenshots/06-volumes.png" width="100%" alt="Volumes"> | <img src="screenshots/14-audit.png" width="100%" alt="Audit log"> |
| **Notifications** — channels and 21 rules | **Login** — one admin password |
| <img src="screenshots/18-settings-notifications.png" width="100%" alt="Notifications"> | <img src="screenshots/01-login.png" width="100%" alt="Login"> |

---

## Features

The sidebar is grouped into **Overview · Docker · Server · System**:

| Group | Pages |
|---|---|
| **Overview** | Dashboard · Monitoring |
| **Docker** | Resources (Containers, Images, Volumes, Networks, Builds, Prune) · Deploy (Compose stacks, App templates, Registries) · **Swarm** (Overview, Nodes, Services, Stacks, Migrate, Secrets & configs, Networks, Cluster settings) · Observe (Logs, Events, Audit log, Notifications sent) · Tools (Terminal, Files, Schedules) |
| **Server** | Servers (Servers, SSH keys, Edge agent) · Server Console (Overview, Monitoring, Setup, Access & SSH, Users & keys, Firewall, Fail2ban, Services, Logs, Settings) |
| **System** | Settings (General, Notifications, Software update, System, Security) |

**Ctrl/Cmd + K** opens a search palette: any page, common actions, and the containers, images, volumes, networks and stacks of the server in use.

### 📊 Overview

- **Dashboard** — the server in use at a glance: count cards, Quick Actions (start / stop / restart all), top CPU and memory, network I/O, health, disk usage, port map, top images, **Smart Insights** (old stopped containers, unused images, detached volumes → Prune), host metrics (local and remote), a Swarm badge when the server is in a swarm, and a strip of all servers.
- **Monitoring** — every server's CPU, memory, disk and load: **Live** (refreshes every few seconds, nothing stored) and **Last 48 hours** (one sample a minute per server, kept in DockGate's database).

### 🐳 Docker

<details open>
<summary><strong>Resources</strong> — Containers · Images · Volumes · Networks · Builds · Prune</summary>

- **Containers** — table / card / **topology** views, filters (Running, Stopped, Unhealthy, Restarting, Paused, **Swarm**), search and sort, group by stack, favorites / notes / tags, bulk actions, and the guided **Run container** form (image with Hub search, ports, volumes, env with "paste .env", restart policy, network, CPU / memory). Swarm tasks and containers moved to Swarm are marked.
- **Newer images** — a daily check (and **Check for updates**) compares each container's tag with its registry. **Update** pulls the new image, recreates the container, checks it starts and stays healthy, and puts the old image back if not. Versions are shown instead of digests; **Update history** lists every update and **Roll back** returns to the previous image.
- **Container page** — start / stop / restart / pause / remove, live resources update, **Recreate**, **Commit**, **Export**; tabs: Overview, Logs, Terminal, Stats, Processes, Environment, Ports, Volumes, Network, **Files** (browse, edit text files, new file / folder, rename, delete, upload / download), Inspect, Updates, History.
- **Images** — in use / unused / dangling, pull (with stored registry logins) and Docker Hub search, push, layers, tags, save to tar, build, remove.
- **Builds** — from a Dockerfile, inline or Git with a live log, build history, build cache and prune, buildx builders.
- **Volumes** — create, **backup / restore** (.tar.gz), **clone**, **files** (browse, edit, new file / folder, rename, delete), the containers and Swarm services that use each one.
- **Networks** — create (bridge / macvlan / ipvlan / overlay, subnet, gateway, internal, attachable, IPv6), inspect, clone, connect / disconnect containers.
- **Prune** — one table of unused data with what each removes and the space it frees; volumes are never pre-selected.
</details>

<details>
<summary><strong>Deploy</strong> — Compose stacks · App templates · Registries</summary>

- **Compose stacks** — finds projects by their `com.docker.compose.project` label, locally and on remote servers; **create and edit** in a YAML editor; **up / down / restart / pull**; deploy a folder, adopt a project already on a server, or deploy from **Git** (with sync); on a remote server Compose runs **on that server over DockGate's SSH session** (password, key or key with passphrase), so bind mounts and build contexts are the server's own. A re-openable **Deploys** console shows live job logs; the **deploy history** keeps each deploy's files, shows what changed and can redeploy an earlier version. Image updates per service. With Swarm on, **Move to Swarm…** on each project.
- **App templates** — a searchable marketplace (Portainer App-Templates format, 500+ apps from the default catalog, or a bundled offline set or your own URL). A container template opens the Run form; a stack template opens the Compose editor — or, with Swarm on, a Swarm stack.
- **Registries** — private-registry logins, encrypted, matched by host so pull, push, Compose and Swarm deploys use them. Includes a login test.
</details>

<details>
<summary><strong>Observe</strong> — Logs · Events · Audit log · Notifications sent &nbsp;·&nbsp; <strong>Tools</strong> — Terminal · Files · Schedules</summary>

- **Logs** — one log viewer everywhere: live tail or a time range (15 min … 7 days, or from–to), levels, search, wrap, copy and download.
- **Events** — the Docker event feed with history (15 m / 1 h / 24 h / live), type filter, CSV export.
- **Audit log** — every change: what, on which server, from which IP, when; filter, search, CSV export.
- **Notifications sent** — every alert and whether each channel delivered it.
- **Terminal** — container exec (sh / bash / zsh) and a host shell, plus a **Quick Terminal** from any page (`` Ctrl+` `` or `Alt+T`) that can be minimized, maximized and split into two.
- **Files** — an **SFTP file manager** for a remote server (on **Local**: the folders you share with DockGate under `/host`, e.g. `- /srv:/host/srv`; `FILES_ROOT` changes the root): browse, edit, upload / download, rename, delete, copy / move. An **Explorer** mode adds two-pane transfers between your computer and the server: folder upload, parallel transfers, conflict handling, retry and cancel.
- **Schedules** — tasks DockGate runs on a chosen server: **prune** (never volumes), **volume backup** (newest N kept) and **Git sync**; daily, weekly or hourly; a failed run sends an alert.
</details>

### 🐝 Docker Swarm

See [Docker Swarm](#docker-swarm) below.

### 🖥 Server

<details open>
<summary><strong>Servers</strong> — Servers · SSH keys · Edge agent</summary>

- **Servers** — add / edit / remove SSH hosts (key with optional passphrase, password, or SSH agent), test the connection, choose the server in use, give the login the docker group. Passwords and passphrases are encrypted at rest (AES-256-GCM).
- **SSH keys** — generate or import keys and use them for servers.
- **Edge agent** — see [Notifications & Edge Agent](#notifications--edge-agent).
</details>

<details>
<summary><strong>Server Console</strong> — Overview · Monitoring · Setup · Access &amp; SSH · Users &amp; keys · Firewall · Fail2ban · Services · Logs · Settings</summary>

- **Overview** — security status (deploy user, password login, root login, firewall, Docker ports, host key, fail2ban), each linking to the place that fixes it.
- **Monitoring** — the host's CPU, load, memory, swap, disks, disk I/O, network, processes and ports (Live and Last 48 hours), and its alert limits.
- **Setup** — provision a fresh server: system update, Docker Engine, Docker log limits, fail2ban, swap, docker group, **deploy user**, safe SSH hardening and a firewall; presets or your own choice; pre-flight checks, cancel, reboot notice, and every run kept with its log.
- **Deploy user** — a wizard creates a non-root user with sudo and Docker access and an ed25519 key, proves the new login works, and only then switches DockGate to it.
- **Access & SSH** — root login, password login, SSH port and hardening in DockGate's one `sshd_config.d` file. Every change is tested (`sshd -t`), armed with a **120 s automatic rollback** and kept only after a new SSH login works.
- **Users & keys** — create / delete / lock users, sudo and docker membership, SSH keys. DockGate never lets you lock out its own login.
- **Firewall** — inbound and outbound rule tables like cloud firewalls, sources (any, IP lists such as Cloudflare or GitHub webhooks, addresses), default policies, UFW on / off with a lifeline, and **Docker port isolation** so published container ports no longer bypass UFW. Also works with firewalld.
- **Fail2ban** — banned IPs, unban / ban / allowlist, ban history, jails and settings applied in one tested reload, problem detection (a jail on the wrong port, a recidive jail that can not trigger, an allowlist not in effect…), and **Move to DockGate** for settings kept in other files.
- **Services** — **Docker** (log limits, live restore), **Time sync** and **Auto updates**, each with its state, a guarded config editor and its log.
- **Logs** — host logs (journald, auth, syslog, kernel, boot, any unit or `/var/log` file).
- **Host key pinning** — every SSH connection pins the server's host key on first use and refuses a different one; re-trust it after a rebuild.
</details>

### ⚙️ System — Settings

**General** (theme, default view, timezone, default shell, log timestamps, container list, auto-start), **Notifications** (channels and rules), **Software update** (self-update from GHCR), **System** (Docker engine and host info), **Security** (change the admin password, sign out everywhere).

---

## Docker Swarm

Swarm runs services on several servers at once, moves them when a server goes down and updates them without downtime. DockGate sets it up and manages it from the server in use (a manager).

- **Set up** — one server, or several at once (DockGate checks each server first, opens the Swarm ports in UFW / firewalld, and undoes everything if a server can not join); add servers later; choose the overlay address pool, encrypted overlay networks and autolock.
- **Overview** — ready servers, managers and how many losses they tolerate, running tasks per server, warnings, recent Swarm events. The Dashboard shows a Swarm badge.
- **Nodes** — CPU and memory per node; pause, drain (with what moves and what stops), activate; promote / demote with quorum checks; labels; remove; add a node's server to DockGate; **Rebalance**.
- **Services** — create and edit with a full form (image, replicas, resources, placement, updates and rollback, restart, health check, env, secrets and configs, ports, networks, mounts), scale, update image, roll back, restart, remove. **Check for updates** and **Update to newest** pin the new build (tag@digest) on every node.
- **A page for each service** — like a container's page: Overview, Tasks, Logs (all tasks or one), **Terminal** and **Files** of a task on any node in DockGate, Stats (now and 48-hour graphs), Environment, Ports, Volumes, Networks, Secrets & configs, Placement, Updates, Events, Inspect.
- **Stacks** — move **Compose projects** to Swarm (whole, or the part that can run on Swarm), redeploy, Swarm settings, history, and **Move back to Compose**; new stacks from a **stack file** or an **app template**; **take over** stacks deployed outside DockGate; move a **`docker run` container** to Swarm and back. Volumes keep their names, so data stays; a move that does not come up is put back by itself.
- **Secrets & configs** — create, view config content, **rotate** (a new version, services moved one at a time), remove when unused.
- **Networks** — overlay networks (encrypted with ESP firewall rules), gateway and the services using each, change the ingress subnet.
- **Cluster settings** — certificate lifetime, task history, autolock (with the unlock key kept encrypted), join tokens (show, copy, rotate), **backups** (nightly, download, upload, **Restore…** of missing services, networks, configs and secrets), **Recover cluster** when most managers are lost, and turn Swarm off.
- **Alerts** — a service below its replicas, a node down or back, an update rolled back, managers without a majority.

---

## Notifications & Edge Agent

**Channels** — **Telegram**, **SMTP email** and **webhook** (Slack, Discord, Microsoft Teams, ntfy or JSON). Secrets are encrypted at rest; Swarm alerts that fail to send are retried for 15 minutes.

**Alert rules (21)** — each with an on / off switch and a cooldown (`0` = every time):

| Group | Rules |
|---|---|
| Containers | stopped or died (split into Stopped / Crashed / OOM), killed by OOM, restarted, unhealthy, started, paused, unpaused |
| Docker | disk usage above a limit, image build failed, newer image available, image update failed or rolled back, scheduled task failed |
| Servers | not reachable, reachable again, disk almost full, memory high, CPU high — shared limits or per server |
| Swarm | service below its replicas, server down or back, update rolled back or paused, managers lost their majority |

A `docker restart` sends a single "Restarted" alert, and crash / OOM / unhealthy alerts include the container's recent logs.

**How it watches** — one event monitor per server (local and every SSH server), the server health check once a minute, and the Swarm monitor every 30 seconds, so alerts come from every server, not only the one in use.

**Edge agent (optional)** — a small **outbound-only** container DockGate installs on each server. It watches that host's Docker events, container logs and host logs and sends alerts **directly** to your channels, so it:

- works behind NAT and firewalls (no inbound ports),
- **keeps alerting when DockGate is offline**,
- installs without manual steps (ready images for amd64 and arm64, or built and shipped by DockGate).

Manage it under **Servers → Edge agent**: install on several servers, start / stop, update, remove, a different channel per server, re-openable job logs, and automatic sync of rules and channels. A server with the agent is no longer watched by DockGate's own monitor (no duplicate alerts).

> The agent runs with a **read-only** docker-socket mount, `no-new-privileges`, memory / CPU caps and no published ports. A read-only socket is defense in depth, not a security boundary — use an alert-only bot or a send-only SMTP login.

---

## Architecture

```
Browser (vanilla JS + xterm.js + Chart.js)
   │  cookie-gated session (login required)
   ├── HTTP/REST ─────────► Express API  (/api/*  behind requireAuth + origin check)
   │                          containers · images · volumes · networks · builds · compose
   │                          swarm · servers · security · firewall · monitoring · schedules
   │                          registries · templates · agent · settings · audit
   │
   └── WebSocket ─────────► Socket.IO  (same session cookie)
                              logs · stats · events · container / task PTY · host PTY · build
                                          │
                  ┌───────────────────────┼─────────────────────────────┐
                  ▼                       ▼                              ▼
          Local Docker socket     dockerode SSH transport        isolated forked SSH workers
          (/var/run/docker.sock)  (remote daemons)               (host stats / logs / provision /
                  │                       │                        service control)
                  └─── the "server in use" Docker client (switchable) ───┘
                                          │
                       SSH sessions (ssh2): remote Compose, stack deploy, SFTP files

          Event monitor (per server) · health monitor (1/min) · Swarm monitor (30 s)
          ──► Telegram / SMTP / webhook  (retry queue)
          Edge agent deployer ── ships ──► outbound-only agent container (per server)
          better-sqlite3 (WAL) ── settings, audit, servers, metrics, jobs, deploy history, Swarm records
          AES-256-GCM at rest ── SSH / registry / channel secrets, Swarm unlock key, stack variables
```

**Key ideas**

- **One Docker client for the server in use.** Every Docker call goes to the current server — the local socket or an SSH-transport client — so the whole app follows the server you choose.
- **Commands run where the files are.** On a remote server, Compose and `docker stack` run on that server over DockGate's SSH session; files and variables go through SFTP into a private temp folder.
- **Isolated workers for host jobs.** Host metrics, host logs, provisioning and service control run in forked one-shot SSH workers, so a slow host never blocks the UI.
- **One light sample a minute.** Each server is read once a minute for its alerts; the same sample is Monitoring's 48-hour history.
- **Secrets at rest.** AES-256-GCM (`DG_MASTER_KEY` or a generated `data/.master.key`).

---

## Security

> **Docker socket access = root-equivalent control of the host.** Treat DockGate as a privileged tool.

- **Authentication.** One **admin password** — scrypt hash + salt, set on first run (min 8). Login gives an **HMAC-signed, HttpOnly, SameSite=Lax** session cookie (7-day TTL; `Secure` with `COOKIE_SECURE=true`). Login is **rate-limited** (10 / 15 min per IP; `X-Forwarded-For` is used only when `TRUST_PROXY` trusts the proxy). Changing the password signs out every other device; **Sign out everywhere** ends all sessions.
- **First-run setup.** From the same machine or a private network the password can be set directly; from the internet a one-time **setup token** is required (printed in the log, or set with `DG_SETUP_TOKEN`).
- **Every `/api` route and WebSocket stream needs a valid session**, except login and setup.
- **CSRF defense.** State-changing requests whose `Origin` host ≠ `Host` are rejected (403), together with `SameSite=Lax`.
- **Encrypted at rest.** SSH, registry and channel secrets, the Swarm unlock key and stack variables (AES-256-GCM).
- **Audited.** Every change (including terminal, file edits, agent, provisioning and Swarm operations) is recorded with the server and source IP.
- **SSH host keys are pinned** on first use; a changed key is refused.
- **No secrets to the browser.** Settings never return the session secret or the password hash.
- **Still:** don't expose port 7077 to the internet — use a VPN or SSH tunnel (see [Remote access](#-remote-access)). Anyone with the password controls every connected server.

---

## Limitations

- **Single admin.** One password; no user accounts, roles or per-user data.
- **Self-update and auto-start** need DockGate's own host (Local).
- **Provisioning and host management** need SSH with root or passwordless sudo on the target; try it on a throwaway server first.
- **Docker port isolation needs UFW** (Debian / Ubuntu). On firewalld hosts the Firewall tab manages ports, services and rich rules of the default zone, but ports published by Docker skip firewalld.
- **Swarm** is managed through a manager node; a node that is not added to DockGate shows no CPU / memory and has no terminal or files. Volumes stay on the server where they are — Swarm does not move data, so a service with data is kept on its server. Files changed inside a Swarm task are lost when the task is replaced.
- **Edge agent** — channel secrets are in the agent's environment on each host (use a dedicated bot / login).

---

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 22 LTS (Alpine) + `docker-cli`, `docker-cli-compose`, `openssh-client`, `git` |
| Web / real-time | Express 4 · Socket.IO 4 |
| Docker SDK | dockerode 5 (local socket + SSH transport) |
| SSH | `ssh2` (remote Compose and stacks, SFTP, host shell, workers) |
| Database | better-sqlite3 11 (WAL) |
| Email | nodemailer 10 |
| Frontend | Vanilla JS / CSS (no build step) · xterm.js · Chart.js — bundled in `public/vendor/` (works offline) |
| Agent image | `agent/` — `node:22-alpine`, dockerode + nodemailer, its own version |

Footprint: capped at 256 MB / 0.5 CPU by `docker-compose.yml`.

---

## API Reference

All under `/api`, JSON, **session-gated** (except `/api/auth/{status,setup,login}`). A selection (see `server/routes/` for the full surface):

**Auth** — `GET /auth/status` · `POST /auth/setup` · `POST /auth/login` · `POST /auth/logout` · `POST /auth/change-password`
**Containers** — `GET /containers` · `GET /containers/:id` · `POST /containers/:id/:action` · `POST /containers/run` · `GET /containers/:id/files` · `GET|PUT /containers/:id/text` · `POST /containers/:id/{mkdir,rename,delete-path,upload}`
**Images** — `GET /images` · `GET /images/search?q=` · `POST /images/pull` · `POST /images/push` · image updates and roll back
**Volumes / Networks** — full CRUD, volume files (`/volumes/:name/{files,text,mkdir,rename,delete-path}`), backup / restore / clone, network connect / disconnect
**Compose** — list / detail · up / down / restart / pull · create · `GET|PUT /compose/:p/file` · deploy history and redeploy
**Swarm** — `GET /swarm/{status,overview,nodes,services,stacks,objects,networks,backups,settings}` · `POST /swarm/{init,cluster,servers/add,rebalance}` · `/swarm/services/:id/{scale,image,update-newest,rollback,restart,logs,tasks,history,events,summary}` · `/swarm/stacks` (new, `:name/{file,redeploy,move-back,take-over}`) · `/swarm/migrate` · `/swarm/containers/:id/move` · `/swarm/tasks/:task/{files,text,file,upload}` · `/swarm/backups/:file/{restore-plan,restore}` · `PUT /swarm/settings` · `POST /swarm/join-tokens`
**Servers & security** — servers, provisioning, host metrics / logs, access, users, firewall, fail2ban, services (see `server/routes/servers.js`, `security.js`, `firewall.js`)
**Schedules / Monitoring / Builds / Cleanup / System** — schedules CRUD and run · fleet metrics · builds · prune · system info
**Registries / Templates / Agent / Settings** — CRUD and tests · catalog and stack files · Edge agent jobs · settings, notifications, audit, backup, self-update

**WebSocket** (Socket.IO, same port): `logs:subscribe` · `stats:subscribe` · `events:subscribe` · `terminal:start` (container or Swarm task PTY, with `serverId` for another node) · `hostterm:start` · `build:start`.

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `7077` | HTTP port |
| `BIND_HOST` | `0.0.0.0` | address to listen on |
| `NODE_ENV` | `production` | Node env |
| `DATA_DIR` | `./data` | where DockGate keeps its database, keys and backups |
| `DG_MASTER_KEY` | *(generated)* | 64-hex AES key for secrets at rest (else `data/.master.key`, mode 0600) |
| `DG_SESSION_SECRET` | *(generated)* | session-cookie signing secret (else kept in the database) |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS to mark the session cookie `Secure` |
| `TRUST_PROXY` | *(none)* | reverse proxies allowed to set the client IP: `loopback`, `uniquelocal`, IPs / CIDRs, or a hop count |
| `DG_SETUP_TOKEN` | *(random, printed in the log)* | first-run setup token; when set it is required even from the local network |
| `ALLOWED_ORIGIN` | *(same-origin)* | allow a specific cross-origin panel |
| `FILES_ROOT` | `/host` | root of Tools → Files on Local |

**Data** lives under `data/`: `docker-panel.db` (SQLite), `ssh-keys/` (0600), `compose/` (managed projects), `swarm-backups/` (Swarm backups), `.master.key`.

---

## Contributing

1. Fork → feature branch → make changes.
2. Run the tests: `npm test`.
3. Try it: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`, or `npm install && npm run dev` (needs Docker socket access) → http://localhost:7077.
4. Open a PR.

---

## 🌐 Remote Access

> Need DockGate from anywhere without a static IP or port forwarding? Use **[NovusGate](https://github.com/Ali7Zeynalli/NovusGate)** — a self-hosted WireGuard® VPN — and reach DockGate over the tunnel.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute with attribution.

**Original Author: Ali Zeynalli** — this attribution must be preserved in all copies and derivative works.

---

<p align="center">
  <strong>DockGate</strong> — Docker &amp; servers, managed from one place.
</p>
