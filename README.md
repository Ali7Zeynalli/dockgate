<p align="center"><img src="screenshots/logo.png" width="88" alt="DockGate logo"></p>

<h1 align="center">DockGate</h1>

<p align="center">
  <strong>Self-hosted control panel for Docker, Compose, Docker Swarm and your servers.</strong><br>
  One container, one admin login, every host - local and over SSH.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DockGate-v2.93.0-00d4aa?style=for-the-badge&logo=docker&logoColor=white" alt="DockGate">
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/Changelog-v2.93.0-orange?style=for-the-badge" alt="Changelog"></a>
  <img src="https://img.shields.io/badge/RAM-≤256MB-success?style=for-the-badge" alt="RAM">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> |
  <a href="#screenshots">Screenshots</a> |
  <a href="#features">Features</a> |
  <a href="#docker-swarm">Swarm</a> |
  <a href="#notifications">Notifications</a> |
  <a href="#security">Security</a> |
  <a href="guide/README.md">Docs</a> |
  <a href="CHANGELOG.md">Changelog</a> |
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="screenshots/00-demo.gif" alt="DockGate: dashboard, containers, Swarm, the database client, Proxies &amp; SSL (proxies, sites, certificates), Deploy projects, Server sections (Status, Security, Software, Automation) and monitoring" width="100%">
</p>

---

## What is DockGate?

- **Docker** - containers, images, volumes, networks and builds, with logs, a terminal and file editing inside containers. Networks are fully managed: each one has a page compared with its compose files, settings changed with every container put back, and a check of whether one container can reach another.
- **Compose** - create, edit and deploy projects locally or on a remote server, with deploy history and image updates. **Tasks** runs your Makefile, justfile, npm scripts and deploy.sh, and **deploy recipes** deploy on a GitHub / GitLab / Bitbucket push with checks and rollback. Replicas, auto-heal, Auto Scaling and updates without downtime - **without Swarm**, your compose files untouched.
- **Docker Swarm** - set up a cluster and move Compose projects and containers to it and back, as well protected as before. Each service gets its own page; published ports are firewalled on every server at once.
- **Servers** - provision, secure (SSH, users, firewall, fail2ban, an SSH honeypot on port 22 whose bans can reach every server) and monitor any number of hosts over SSH; a **live firewall** view shows the rules the kernel really uses and whether a connection will pass, each with an optional access password asked once per session; cron jobs with alerts, **scripts** (templates, blocks or your own shell), system settings (network with automatic rollback, DNS, kernel, disks and swap) and a file manager with a safe editor.
- **Databases** - a database client for PostgreSQL in your containers, on any server: an Explorer tree, tabs and right-click menus; tables edited like a spreadsheet, a SQL editor with autocomplete and plans, table design (columns, indexes, keys) with a rolled-back Test, export to SQL / CSV / Excel, `.sql` and CSV import, test data, users, backups - read-only until you allow changes, no port opened.
- **Uptime** - checks your sites (HTTP, SSL, TCP, DNS) from DockGate and from your other servers, linked to the containers behind them.
- **Proxies & SSL** - nginx, Caddy, Traefik, HAProxy and Apache, in containers (images built from them too) or installed on the server: which domain goes to which container, putting a container on a domain, Let's Encrypt certificates that DockGate gets and renews (or you renew by hand), every certificate watched with alerts before it expires, a config editor that checks, reloads and puts the old file back if a site breaks, load balancing, logs, stats and Traefik's live routers.
- **Alerts** - Telegram, email and webhook, plus an optional Edge agent that keeps alerting - and keeps replicas, healing and Auto Scaling running - when DockGate is offline.
- **Light** - at most 256 MB RAM and 0.5 CPU; plain JavaScript, no build step, works offline.

> DockGate is **single-admin**: one password, full control, no user roles.

### Where things are

| Sidebar | What is in it |
|---|---|
| **Overview** | Dashboard, Monitoring (every server) |
| **Docker** | Resources (Containers, Images, Builds, Volumes, Networks, Cleanup), Deploy (Projects, App templates, Tasks), Swarm, Databases, Logs & events |
| **Web** | Uptime, Proxies & SSL |
| **Servers** | Servers, SSH keys, Edge agent |
| **Server** - the one picked in the top bar | Status (overview, graphs, alerts, logs, system info, connection), Security (SSH, users, firewall, fail2ban, honeypot, live firewall), System (names, network, time, disks and swap, kernel, config files), Software (setup, services, Docker engine, auto updates), Automation (cron, timers, scripts, schedules) |
| **Tools** | Terminal, Files |
| **System** - DockGate itself | Settings, Activity (audit log, notifications sent), Help (this guide, inside DockGate) |

---

## Quick Start

```bash
mkdir dockgate && cd dockgate
curl -O https://raw.githubusercontent.com/Ali7Zeynalli/dockgate/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:7077** and set the admin password. From the internet, the first setup also asks for the token printed by `docker logs dockgate-control-panel`.

| | |
|---|---|
| **Update** | Settings > Software update > **Update now**, or `docker compose pull && docker compose up -d` |
| **Back up** | the `data/` folder (database, SSH keys, `.master.key`, compose projects); volumes from Resources > Volumes or Server > Automation > Schedules |

**From source:**

```bash
git clone https://github.com/Ali7Zeynalli/dockgate.git && cd dockgate
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

<details>
<summary><strong>Container restart-loops on SELinux-confined Docker (openSUSE Leap 16 and similar)</strong></summary>

If the container keeps restarting with `SQLITE_CANTOPEN` or `connect EACCES /var/run/docker.sock`, the Docker daemon confines containers with SELinux. Check with `docker info --format '{{.SecurityOptions}}'`.

Either set `"selinux-enabled": false` in `/etc/docker/daemon.json` and restart Docker:

```bash
sudo sed -i 's/"selinux-enabled": *true/"selinux-enabled": false/' /etc/docker/daemon.json
sudo systemctl restart docker
```

or add this to the `dockgate` service in `docker-compose.yml`:

```yaml
    security_opt:
      - label:disable
```

Never add `:z` / `:Z` to the `/var/run/docker.sock` mount.
</details>

---

## Screenshots

**Docker**

<table>
<tr>
<td width="50%"><img src="screenshots/02-dashboard.png" alt="Dashboard"><br><sub><b>Dashboard</b></sub></td>
<td width="50%"><img src="screenshots/03-containers.png" alt="Containers"><br><sub><b>Containers</b> - stacks, filters, Swarm tasks</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/23.png" alt="Topology"><br><sub><b>Topology</b> - live graph of the stacks</sub></td>
<td width="50%"><img src="screenshots/11-terminal.png" alt="Container terminal"><br><sub><b>Container terminal</b></sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/10-logs.png" alt="Logs"><br><sub><b>Logs</b> - one viewer everywhere</sub></td>
<td width="50%"><img src="screenshots/08-compose.png" alt="Projects"><br><sub><b>Projects (Compose)</b> - history, Move to Swarm</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/34-databases.png" alt="Databases"><br><sub><b>Databases</b> - Explorer, tabs, right-click menus, data, design, SQL</sub></td>
<td width="50%"><img src="screenshots/35-tasks.png" alt="Tasks"><br><sub><b>Tasks</b> - Makefile, npm, scripts, deploy recipes</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/37-project.png" alt="A project's page"><br><sub><b>A project's page</b> - Overview, Services, Files, Deploys, Automation (auto-deploy in one click), Settings</sub></td>
<td width="50%"><img src="screenshots/38-new-project.png" alt="New project"><br><sub><b>New project</b> - Git, a folder, already on the server, YAML, template, or connect a stack to Git</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/39-proxies.png" alt="Proxies & SSL"><br><sub><b>Proxies & SSL</b> - which domain goes to which container, in every proxy on the server</sub></td>
<td width="50%"><img src="screenshots/40-certificates.png" alt="Certificates"><br><sub><b>Certificates</b> - who renews each one, Renew now, alerts before expiry</sub></td>
</tr>
</table>

**Docker Swarm**

<table>
<tr>
<td width="50%"><img src="screenshots/25-swarm-overview.png" alt="Swarm overview"><br><sub><b>Overview</b> - servers, tasks, events</sub></td>
<td width="50%"><img src="screenshots/26-swarm-services.png" alt="Swarm services"><br><sub><b>Services</b> - replicas, CPU, memory, ports</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/27-swarm-service.png" alt="Service page"><br><sub><b>Service page</b> - tasks, logs, terminal, files</sub></td>
<td width="50%"><img src="screenshots/28-swarm-stacks.png" alt="Swarm stacks"><br><sub><b>Stacks</b> - from Compose, a file or a container</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/31-swarm-migrate.png" alt="Migrate"><br><sub><b>Migrate</b> - Compose projects and containers</sub></td>
<td width="50%"><img src="screenshots/29-swarm-nodes.png" alt="Nodes"><br><sub><b>Nodes</b> - role, state, CPU, memory</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/32-swarm-secrets.png" alt="Secrets and configs"><br><sub><b>Secrets & configs</b></sub></td>
<td width="50%"><img src="screenshots/33-swarm-networks.png" alt="Overlay networks"><br><sub><b>Overlay networks</b></sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/30-swarm-cluster-settings.png" alt="Cluster settings"><br><sub><b>Cluster settings</b> - tokens, autolock, backups</sub></td>
<td width="50%"></td>
</tr>
</table>

**More**

<table>
<tr>
<td width="50%"><img src="screenshots/24-monitoring.png" alt="Monitoring"><br><sub><b>Monitoring</b> - every server, live and 48 h</sub></td>
<td width="50%"><img src="screenshots/09-templates.png" alt="App templates"><br><sub><b>App templates</b> - 500+ apps</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/06-volumes.png" alt="Volumes"><br><sub><b>Volumes</b> - backup, restore, files</sub></td>
<td width="50%"><img src="screenshots/14-audit.png" alt="Audit log"><br><sub><b>Activity > Audit log</b></sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshots/18-settings-notifications.png" alt="Notifications"><br><sub><b>Notifications</b> - channels and rules</sub></td>
<td width="50%"><img src="screenshots/01-login.png" alt="Login"><br><sub><b>Login</b></sub></td>
</tr>
</table>

---

## Features

| Area | What you can do |
|---|---|
| **Dashboard, Monitoring** | The server at a glance with Smart Insights and host metrics; every server's CPU, memory, disk and load, live and for 48 hours. `Ctrl/Cmd+K` jumps anywhere. |
| **Containers** | Table, cards or topology (by stack or by network); run, start, stop, recreate, commit, export. Each container has a page with logs, terminal, stats, environment, ports, volumes, network, **files (edit, upload, download)**, updates and history. |
| **Images, Volumes, Builds, Cleanup** | Pull, push, tag, Docker Hub search; volume backup, restore, clone and file editing; builds from a Dockerfile or Git with live logs; one Prune table. |
| **[Networks](guide/networks.md)** | Search, filters, a **Map** of every network with its containers (those on several networks marked), remove the unused ones. **Create** any driver: macvlan / ipvlan with the server's interface as parent, IPv6 subnet, MTU, bridge options, labels; the subnet is checked as you type against other Docker networks and the server's own LAN, VPN and routes. Each network has **a page**: its containers with addresses, aliases and ports, **compared with the compose files** (missing containers, connected by hand, missing aliases, services no longer in the file) with a fix next to each; connect with aliases and a fixed address; **Change settings** (Docker can not change a network in place: DockGate makes it again and puts every container back, and puts the old one back if a step fails); **Can a container reach another?** (name, address, port, from inside its network); history. |
| **Image updates** | A daily check of every tag against its registry; safe update with a health check, automatic roll back, version names and history. |
| **Compose** | Every stack has **its own page** - Overview, Services, Files, Deploys, Automation, Settings. Discover, create and edit projects; deploy a folder, adopt a project already on a server, or deploy from Git. On a remote server Compose runs on that server over SSH. Deploy history with changes and redeploy. A project uploaded as files can be **connected to Git in the same folder** ([Connect to Git](guide/git-connect.md)): compare, backup, undo, or the first push to an empty repository. **Set up auto-deploy** on a stack's page makes a deploy recipe with its webhook in one click. |
| **[Scaling & health](guide/compose-scaling.md)** (Compose, without Swarm) | **Replicas** with one click - DockGate writes its own override file, your compose files stay as they are; host ports and `container_name` fixed only after you see the fix; proxies reloaded. **Auto-heal** restarts a replica that stays unhealthy. **Keep running** brings a service back when it is stopped or removed (made again from its kept config). **Auto Scaling** - Off / Suggest / Auto (24 h simulation first), measured against your own limits, adds a replica only when the server has room, values suggested from the last 48 hours. **Roll out** - updates replica by replica without downtime, also for *newer image* updates. |
| **[Tasks](guide/tasks.md)** (SSH servers and the local server) | Finds the tasks of a project folder - `Makefile` targets, `justfile`, `Taskfile.yml`, `package.json` scripts (npm / pnpm / yarn / bun), `*.sh`, Ansible playbooks, Kamal - and runs them with a live log: dry run, variables, run as root, cancel, one run per folder, history. **Env & secrets** per folder (encrypted, masked in logs). **Deploy recipes:** Git pull -> your tasks -> docker compose up -> check a URL / a container's health; **recovery steps** (back to the commit before, your rollback) when a step fails; several servers; schedule; alerts. Started by **GitHub, GitLab, Bitbucket Cloud / Server webhooks** (signatures checked, branch filter) or **CI** with a token, and the result marked on the commit. |
| **App templates, Registries** | 500+ apps as a container, a Compose project or a Swarm stack; private registry logins used everywhere. |
| **Logs & events, Uptime, Tools** | Logs, Docker events, **Uptime** (HTTP / SSL / TCP / DNS checks of your sites from DockGate and other servers: uptime %, response time, incidents, certificate days left, linked containers with their logs and Restart, alerts), audit log, notifications sent; container and host terminal (`` Ctrl+` ``); SFTP file manager (also as **Quick Files** over any page, Ctrl+Shift+F) with two-pane transfers, a safe editor (colours, checks with compose / nginx / sshd / visudo / findmnt / `bash -n`, diff before save, earlier versions, sudo for root-owned files, never half written), Places and bookmarks, log tail, image preview, and permissions / owner; scheduled prune, volume backup and Git sync. |
| **[Proxies & SSL](guide/proxies.md)** (Web) | Finds nginx, Caddy, Traefik, HAProxy and Apache in containers (and on SSH servers, on the host) and shows which domain goes to which container, with warnings (config that fails its check, a site pointing to a stopped container, a domain in two proxies). **Put a container on a domain** with a preview of the exact lines; the proxy joins the container's network when needed. **Let's Encrypt by DockGate** (nginx, Apache) - it gets the certificate through the proxy itself and renews it 30 days before expiry. **Every certificate is watched**, whoever renews it (certbot, Caddy, Traefik, Nginx Proxy Manager, acme-companion): alerts 14 / 7 / 3 / 1 days before expiry, a renewed certificate that is not loaded (with Reload), certbot Renew now and reload hook, all servers in one list. A **config editor** where every save is checked (`nginx -t`, `caddy validate`, `haproxy -c`, `configtest`), reloaded and tested on the sites - anything fails, the old file goes back; history with restore. **Load balancing** (nginx upstream, Caddy, HAProxy), access-log **stats**, **Traefik live** routers. |
| **[Databases](guide/tools.md#databases)** | A database client for PostgreSQL in containers (postgres, postgis, timescaledb, pgvector, supabase, bitnami...), reached with `docker exec psql` - no published port. **Explorer** (container > database > schema > tables, views, functions > columns, indexes, keys), **tabs** and **right-click menus** (generated SELECT / INSERT / UPDATE / DELETE, count, export, truncate, drop), database overview with bulk actions, status bar. **Data** edited like a spreadsheet in one transaction with Test, foreign-key links, who wrote a row, CSV import, bulk changes. **SQL workbench** (autocomplete, Ctrl+Enter, transactions across runs, EXPLAIN, saved queries). **Design**: columns, indexes, foreign keys, checks, triggers, new tables, rename / duplicate - Show SQL, 🧪 Test (rolled back), Save in one transaction. **Export** to SQL (pg_dump), CSV zip or Excel; **import** `.sql` files and CSV into new tables; **test data** that fits the columns and foreign keys. Users and grants, sessions, VACUUM, backups with restore and swap. Read-only until you allow changes, every change in the audit log. |
| **Servers** (sidebar: Servers, and Server > Status, Security, System, Software, Automation) | Hosts over SSH (password, key, key with passphrase); provisioning presets; deploy user; SSH access; users and keys; firewall (UFW / firewalld, IP lists, Docker port isolation that shows for every port, before it is turned on, whether it stays open); a **live firewall** view (the rules the kernel really holds, where each comes from, *will this connection pass?*, rules left behind with a fix, connections dropped in the last hour); fail2ban; an **SSH honeypot** on port 22 once SSH has moved (every address that connects is banned on every port, Docker's included; the user names and passwords tried are shown; its bans can be **shared with every server**); **cron jobs** (crontabs, cron.d, systemd timers, edit with diff, run now, failed / did not run alerts); **scripts** - 18 templates (updates and reboots, database / volume / folder backups, self-repair, deploy) with a few questions, a block builder (fix steps that run only if an earlier step failed), **your own shell** with blocks to insert, and scripts **already on the server** added where they are - run once or scheduled in Cron, checked with `bash -n`; **system settings** (hostname, hosts, DNS, network with automatic rollback, kernel, limits, journal, fstab, swap file and swappiness); time sync; auto updates; host logs; pinned host keys. |

---

## Docker Swarm

- **Set up** on one server or several at once: checks, firewall ports, undo on failure. Add servers later.
- **Nodes** - pause, drain, promote, demote, labels, remove, rebalance. Each node has a **page** with its tasks, CPU and memory (live and 48 h), labels, events and history.
- **Services** - full form, scale, update image, **Update to newest**, roll back, restart, resume a paused update. Each service has a **page** with tasks, logs, terminal and files on any node, stats, settings, updates and events.
- **[Auto Scaling](guide/swarm-auto-scaling.md)** - Swarm does not scale by itself: DockGate adds or removes replicas when CPU or memory per replica stays high or low (min / max, thresholds, average or every replica, separate waits). It suggests each replica's limits and reservations from the last 48 hours of use, shows the free capacity and how many more replicas fit, and spreads them over the servers.
- **Stacks** - move Compose projects (whole or in part, one at a time even when they share a network) and `docker run` containers to Swarm and back, with limits, start order, names and local-only ports kept; new stacks from a file or a template; take over stacks made elsewhere. Volumes keep their names, so data stays; a move that fails puts the project back.
- **[Protected as before](guide/swarm-stacks-and-migrate.md#protected-as-before)** - the plan compares each service's protection in Compose and on Swarm (user, read-only, no-new-privileges, seccomp, AppArmor, capabilities, mounts, where ports are reachable); `no-new-privileges` and seccomp are kept on the Swarm service; a weaker service stays in Compose unless you choose otherwise; every task is checked after the move and the project is put back if it is weaker than planned.
- **[Build & push](guide/swarm-stacks-and-migrate.md#build--push-services-built-from-source)** - services with `build:` are built with Compose, pushed to your registry and deployed from there, again on every Redeploy. **Secrets and configs from files** are versioned by content, so Redeploy never fails on a changed file (also for remote projects). **privileged** images of known families run with only the `cap_add` they need, when you accept it. **macvlan / ipvlan** networks are made on every server.
- **[Firewall](guide/swarm-firewall.md)** - the published ports of every service on every server in one table: open (to whom), closed, or open to everyone; open or close a port on all servers at once, for anyone, an IP list or addresses. Servers that join later get the same rules.
- **Secrets, configs, overlay networks** - create, rotate, remove; encrypted overlays.
- **Cluster** - certificates and CA rotation, autolock and unlock-key rotation, heartbeat and Raft tuning, join tokens, nightly backups, restore of missing services, Recover cluster.

---

## Notifications

Channels: **Telegram**, **SMTP email** and **webhook** (Slack, Discord, Teams, ntfy, JSON). There are 36 rules, each with an on / off switch and a cooldown:

| Group | Rules |
|---|---|
| Containers | stopped / crashed / OOM, restarted, unhealthy, started, paused, unpaused |
| Docker | disk usage, build failed, newer image, image updated, image update failed, scheduled task failed |
| Servers | down, back, disk, memory, CPU - shared or per-server limits; cron job failed, cron job did not run |
| Firewall | web traffic (80 / 443) blocked by the firewall, Docker port isolation rules left behind |
| Sites | site down, back up, slow (Uptime); certificate expires soon, certificate invalid |
| Deploy | deploy failed, deploy finished (Tasks recipes) |
| Compose | auto-heal restarted a container (or gave up), Auto Scaling changed a service or the server was full |
| Swarm | service short of replicas, node down / back, update rolled back, quorum lost, autoscale changed a service |

The optional **Edge agent** runs on each server, makes only outbound connections and sends alerts directly - behind NAT, and when DockGate is offline. It also keeps the [Scaling & health](guide/compose-scaling.md) rules there (replicas, auto-heal, Auto Scaling) while DockGate is away; it takes them only [signed by the DockGate that installed it](guide/agent-security.md).

---

## Security

- One admin password (scrypt), an HMAC-signed HttpOnly session cookie, a login rate limit, and a setup token for the first setup from the internet.
- Every API route and WebSocket needs a session; cross-origin changes are refused.
- SSH, registry and channel secrets, the Swarm unlock key and stack variables are encrypted at rest (AES-256-GCM).
- Every change is in the audit log with the server and source IP; SSH host keys are pinned.
- The Edge agent has **no network port**: DockGate signs every rule and command with an Ed25519 key only it holds (one per install), the agent checks signature, server, order and age, and does only a short list of actions within their limits - [details](guide/agent-security.md).
- **The Docker socket is root on the host:** keep port 7077 off the internet and use a VPN such as [NovusGate](https://github.com/Ali7Zeynalli/NovusGate) or an SSH tunnel.

**Limitations:** single admin; self-update only for DockGate's own host; provisioning needs root or passwordless sudo; Docker port isolation needs UFW; Swarm volumes stay on their server, and files changed inside a Swarm task are lost when the task is replaced.

---

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT`, `BIND_HOST` | `7077`, `0.0.0.0` | where DockGate listens |
| `DATA_DIR` | `./data` | database, keys, Swarm backups |
| `DG_MASTER_KEY` | generated | AES key for secrets at rest |
| `DG_SESSION_SECRET` | generated | session cookie key |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS |
| `TRUST_PROXY` | - | proxies allowed to set the client IP |
| `DG_SETUP_TOKEN` | printed in the log | first-run setup token |
| `ALLOWED_ORIGIN` | same origin | allow another panel origin |
| `FILES_ROOT` | `/host` | root of Tools > Files on Local |
| `DG_HOST_ACCESS` | on | `off` stops DockGate running commands on its own host (Proxies & SSL for proxies and certbot installed on the host) |

<details>
<summary><strong>Architecture and tech stack</strong></summary>

```
Browser (vanilla JS, xterm.js, Chart.js)
  ├─ REST  -> Express API  (/api/*, session + origin check)
  └─ WS    -> Socket.IO    (logs, stats, events, terminals, builds)
                 │
   Docker client of the server in use: local socket or dockerode over SSH
   SSH sessions (ssh2): remote Compose, docker stack, SFTP, forked host workers
   Monitors: events per server, health 1/min, Swarm 30 s, uptime, certificates,
             cron and firewall 5 min, honeypot bans 5 min -> Telegram / SMTP / webhook
   better-sqlite3 (WAL), AES-256-GCM secrets at rest
```

Node.js 22 (Alpine) with `docker-cli`, `docker-cli-compose`, `openssh-client`, `git`, Express 4, Socket.IO 4, dockerode 5, ssh2, better-sqlite3 11, nodemailer 10. Frontend libraries are bundled in `public/vendor/`.
</details>

<details>
<summary><strong>API</strong></summary>

Everything is under `/api`, in JSON, behind the session (except `/api/auth/{status,setup,login}`). Main groups: `auth`, `containers`, `images`, `volumes`, `networks`, `builds`, `cleanup`, `compose`, `swarm`, `tasks`, `hooks`, `templates`, `registries`, `databases`, `proxies`, `uptime`, `files`, `servers` (with each server's security, firewall, cron, scripts and system settings under `/api/servers/:id/...`), `ssh-keys`, `firewall-lists`, `fleet-bans`, `git-connect`, `schedules`, `monitoring`, `agent`, `system`, `help`, `meta`. The routes are in `server/routes/`. WebSocket events: `logs:subscribe`, `stats:subscribe`, `events:subscribe`, `terminal:start`, `hostterm:start`, `build:start`, `image:push`.
</details>

---

## Contributing

Bug reports, fixes and ideas are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run DockGate locally, test and open a pull request. Report security problems privately as described in [SECURITY.md](SECURITY.md). Please follow the [Code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) - free to use, modify, and distribute with attribution.

**Original Author: Ali Zeynalli** - this attribution must be preserved in all copies and derivative works.

<p align="center"><strong>DockGate</strong> - Docker &amp; servers, managed from one place.</p>
