# DockGate documentation

How each part of DockGate works, where to click, and what to do when something goes wrong.
The pages follow the sidebar, so the name you see on screen is the name of the page here.

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
- [Resources → Prune](prune.md) — free disk space safely
- [Deploy → Compose stacks](compose.md) — deploy from the editor, Git, a folder or the server; history, rebuild, Git sync
- [Deploy → App templates and Registries](templates-and-registries.md) — 500+ ready-made apps; private registry logins

## Docker Swarm

- [Swarm → Set up, Overview and Nodes](swarm-setup-and-nodes.md) — one server or several, firewall, the node page
- [Swarm → Services and the service page](swarm-services.md) — scale, update, roll back, the full service form, 16 tabs
- [Swarm → Auto Scaling](swarm-auto-scaling.md) — add and remove replicas by CPU and memory, suggested values, capacity
- [Swarm → Stacks and Migrate](swarm-stacks-and-migrate.md) — move Compose projects and containers to Swarm and back
- [Swarm → Secrets & configs and Networks](swarm-secrets-and-networks.md) — passwords and files for services, overlay networks
- [Swarm → Cluster settings](swarm-cluster.md) — autolock, keys and certificates, tuning, backups, recover

## Observe and tools

- [Observe → Logs, Events, Audit log, Notifications sent](observe.md) — the log viewer, Log Doctor, history of changes and alerts
- [Tools → Terminal, Files, Schedules](tools.md) — shells, files over SSH, prune / backup / Git sync on a schedule

## Servers

- [Servers → Servers, SSH keys, Edge agent](servers.md) — add a server, host keys, deploy keys, the outbound agent
- [Server Console](server-console.md) — setup, SSH access, users, firewall, fail2ban, services, logs

## Settings

- [Settings](settings.md) — appearance, notifications (Telegram, email, webhook) and rules, software update, security

## Help

- [Troubleshooting](troubleshooting.md) — common problems and their fixes
- [FAQ](faq.md)
