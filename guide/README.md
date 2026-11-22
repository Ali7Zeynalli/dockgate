# DockGate documentation

How each part of DockGate works, where to click, and what to do when something goes wrong.
The pages follow the sidebar, so the name you see on screen is the name of the page here.

> This guide is also inside DockGate: **System → Help** (with search), and the **?** next to a page's title opens the part about that page.

> Every page works on the server picked in the top bar (**SERVERS ▾**). *Local* is the host DockGate runs on; other servers are reached over SSH.

## Start here

- [Getting started](getting-started.md) — install, first password, update, back up, forgot password
- [How DockGate works](concepts.md) — servers, Compose and Swarm, jobs, safety nets, data

## Overview

- [Dashboard and Monitoring](dashboard-and-monitoring.md) — the state of a server, live and 48-hour graphs, alerts

## Docker

- [Resources → Containers](containers.md) — the list, Run container, the container page and its 13 tabs
- [Resources → Images](images.md) — pull, load, tag, push, save
- [Resources → Volumes](volumes.md) — browse and edit files, back up, restore, clone
- [Resources → Networks](networks.md) — create, connect containers, Swarm networks
- [Resources → Builds](builds.md) — build from Git or an inline Dockerfile, steps and cache
- [Resources → Cleanup](prune.md) — free disk space safely
- [Deploy → Projects](compose.md) — deploy from the editor, Git, a folder or the server; history, rebuild, Git sync
- [Connect to Git](git-connect.md) — a project uploaded as files becomes a Git checkout in the same folder: compare, backup, connect, undo; or the first push to an empty repository
- [Deploy → Projects → Scaling & health](compose-scaling.md) — replicas with one click, auto-heal, Auto Scaling and updates without downtime, without Swarm; your files stay as they are
- [Deploy → Tasks](tasks.md) — run the Makefile, justfile, Taskfile, npm scripts, *.sh, Ansible and Kamal of a folder; deploy recipes with checks and recovery, on a schedule, from GitHub / GitLab / Bitbucket webhooks or CI
- [Deploy → App templates · Settings → Registry logins](templates-and-registries.md) — 500+ ready-made apps; private registry logins

## Docker Swarm

- [Swarm → Set up, Overview and Nodes](swarm-setup-and-nodes.md) — one server or several, firewall, the node page
- [Swarm → Services and the service page](swarm-services.md) — scale, update, roll back, the full service form, 16 tabs
- [Swarm → Auto Scaling](swarm-auto-scaling.md) — add and remove replicas by CPU and memory, suggested values, capacity
- [Swarm → Stacks and Migrate](swarm-stacks-and-migrate.md) — move Compose projects and containers to Swarm and back, protected as before; build & push, secrets from files, privileged, macvlan
- [Swarm → Firewall](swarm-firewall.md) — published ports on every server, opened and closed together
- [Swarm → Secrets & configs and Networks](swarm-secrets-and-networks.md) — passwords and files for services, overlay networks
- [Swarm → Cluster settings](swarm-cluster.md) — autolock, keys and certificates, tuning, backups, recover

## Observe and tools

- [Logs & events, Web → Uptime, System → Activity](observe.md) — the log viewer, Log Doctor, site checks (uptime, response time, certificates), history of changes and alerts
- [Web → Proxies & SSL](proxies.md) — nginx, Caddy, Traefik, HAProxy, Apache: put a container on a domain, Let's Encrypt (renewed by DockGate), safe config editing with automatic undo, load balancing, logs, stats, Traefik live
- [Tools → Terminal, Files, Databases, Schedules](tools.md) — shells, files over SSH, PostgreSQL in containers as a database client (Explorer, tabs, data editing, SQL, table design, export / import, test data, users, backups), prune / backup / Git sync on a schedule

## Servers

- [Servers → Servers, SSH keys, Edge agent](servers.md) — add a server, host keys, deploy keys, the outbound agent
- [Edge agent → How DockGate commands it, safely](agent-security.md) — signed rules and commands, no port, what the agent may do
- [Server → Status, Security, System, Software, Automation](server-console.md) — the server in use: state, graphs and alerts, SSH access, users, firewall, fail2ban, names and network, time, disks, kernel, setup, services, Docker engine, updates, cron, timers, scripts, schedules

## Settings

- [Settings](settings.md) — appearance, notifications (Telegram, email, webhook) and rules, software update, security

## Help

- [Troubleshooting](troubleshooting.md) — common problems and their fixes
- [FAQ](faq.md)
