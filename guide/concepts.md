# How DockGate works

A short tour of the ideas behind every page. Read it once; the rest of the docs assume it.

## Servers and the server in use

DockGate manages one or more **servers**:

- **Local** is the host DockGate runs on. DockGate talks to its Docker through the socket mounted into the DockGate container.
- **Remote servers** are reached over **SSH**. Nothing has to be installed on them except Docker, and DockGate can install that too (**Server Console → Setup**).

The **server in use** is picked with **SERVERS ▾** in the top bar. Resources, Deploy, Observe, Tools and Swarm all show that server. Switching is instant; nothing is copied between servers.

DockGate pins each server's **SSH host key** on first connection and refuses to connect if it changes. Logins (keys, passwords) are stored encrypted.

## Docker, Compose and Swarm

| | What it is | Where in DockGate |
|---|---|---|
| **Container** | One running app, from an image | Resources → Containers |
| **Compose stack** | Several containers from one `docker-compose.yml`, on **one** server | Deploy → Compose stacks |
| **Swarm service / stack** | An app run by Docker Swarm as several tasks, over **one or more** servers, with rolling updates and roll back | Swarm |

You can start with Compose and move a project to Swarm later (**Move to Swarm…**), and back.

## Jobs

Long work runs as a **job** on the server side: deploys, builds, image updates, Swarm setup and moves, server setup, agent installs. A job has a live log, keeps running when you close the window or the browser, and can be opened again from its page (or the bar at the top of Swarm pages).

## Safety nets

- **Undo on failure**: a failed Swarm setup, move or image update puts things back as they were.
- **Lockout guard**: SSH and firewall changes in Server Console are tested with a new login and rolled back if it fails.
- **Confirmations**: anything that deletes data asks you to type the name.
- **Audit log**: every change, with the server and the IP address it came from (**Observe → Audit log**).

## Monitoring and alerts

DockGate watches Docker events on every server, checks server health every minute and Swarm every 30 seconds. Alerts go to **Telegram**, **email** or a **webhook** (**Settings → Notifications**). The optional **Edge agent** runs on each server, connects out only, and keeps sending alerts when DockGate is offline.

## Data

Everything DockGate knows is in its data folder (`DATA_DIR`, `./data` by default): one SQLite database, SSH keys, Swarm backups. Secrets in it (SSH logins, registry passwords, channel tokens, the Swarm unlock key, stack variables) are encrypted with AES-256-GCM. Back up that folder to back up DockGate: see [Getting started](getting-started.md).

Your apps' data lives in Docker **volumes** on each server, not in DockGate's folder.

## Access

One admin password protects DockGate. The Docker socket gives root on the host, so **keep DockGate's port (7077) off the internet**: reach it through a VPN or an SSH tunnel.
