# Server Console

> **Where:** sidebar **Server Console**, or click a server in **Servers**
>
> **Works on:** one remote (SSH) server. Opening a server's console also makes it the server in use in the top bar.

The console manages the **server itself**, not Docker: what is installed, who can log in, the firewall, fail2ban, system services and logs. It works over SSH; most changes need a user with passwordless `sudo` (the deploy user has it).

**Safety first:** every change that could lock you out (SSH port, password login, firewall) is tested with a **new SSH login** before it is kept. If DockGate can not log in again, it rolls the change back by itself.

---

## Overview

The state of the server and what to do next: OS, uptime, CPU, memory and disk, Docker, firewall, fail2ban, SSH settings, pending updates and whether a reboot is needed. Items that need attention link to the tab that fixes them.

## Monitoring

CPU, memory, disk, network and load: live and the last 48 hours; top processes; disks and mounts. **Alerts** sets this server's own limits (CPU, memory, disk, server down). Empty limits use the shared ones from **Settings → Notifications**.

## Setup

What is installed on the server. Each component is detected first, installed only when missing, and verified after.

| Component | What it does |
|---|---|
| **System update** | Refreshes the package index and applies upgrades |
| **Base utilities** | `curl`, `ca-certificates`, `gnupg`, `git` |
| **Time sync (chrony)** | An accurate clock: TLS, logs and 2FA depend on it |
| **Firewall (UFW)** | Deny incoming by default, allow SSH and 80/443. The current SSH port is allowed before the firewall is turned on |
| **SSH hardening** | Safe limits only: 3 login attempts, 30 s to log in, no empty passwords, no X11 forwarding, drop dead connections after about 10 min. It does **not** turn off password or root login (that is done in Access & SSH, with its lockout guards) |
| **Fail2ban** | Bans addresses after repeated failed SSH logins. Writes its own `jail.d/dockgate.conf`; an existing `jail.local` is left alone |
| **Automatic security updates** | Applies security patches by itself |
| **Swap file** | Optional: 2 GB under 2 GB RAM, else equal to RAM up to 4 GB, with low swappiness. A safety net for Docker builds on small servers |
| **Docker Engine + Compose** | From Docker's own repository |
| **Docker log limits** | Caps container logs (10 MB × 3 per container) so they can not fill the disk, and turns on live-restore (containers keep running while Docker restarts; not in Swarm mode). Merges into an existing `daemon.json` |
| **Deploy user (non-root + SSH key)** | A user with `sudo` and Docker access, and a key DockGate makes. DockGate then connects as it |
| **Docker group** | Lets the SSH user run `docker` without `sudo` |

**Set up N missing →** runs only what is missing or failed. Risky components ask for a tick first. A run keeps going if you leave the page; you can cancel between components. **Run history** keeps the last 200 runs with their full log.

## Access & SSH

How people log in. Every change tests a new SSH login and rolls back if it fails.

| Setting | Meaning |
|---|---|
| **SSH port** | The new port is opened in the firewall first; the old one closes after DockGate logs in on the new one |
| **Password login** | Off is safer: keys only |
| **Root login** | Who may log in as root over SSH. Blocking it does not remove root: `sudo` still works |
| **Login attempts per connection**, **Time to log in** | Limits for wrong passwords or keys, and for slow logins |
| **Dead connection timeout** | Drops a connection whose client stopped answering. Does not log out an idle open terminal |
| **Idle session timeout** | Logs out a terminal left idle |
| **X11 forwarding** | Not needed on servers |
| **Host key** | The server's identity. **Re-trust…** after you rebuilt or reinstalled the server |

DockGate writes its SSH settings into one file (`DockGate sshd drop-in`), so the system's own `sshd_config` stays as it was.

## Users & keys

Who can log in: human accounts (UID ≥ 1000) and root, with their last login. **Add user**, **Disable…** / **Re-enable…** a user, and manage the **SSH keys** in each user's `authorized_keys` (**Add SSH key**, remove). The page names the user DockGate connects as.

## Firewall

UFW (or firewalld on RHEL-type systems).

| Part | What it does |
|---|---|
| **Inbound rules** | Traffic coming to the server. Anything not allowed is blocked. **Add rule**: port, protocol and, optionally, the addresses it is allowed from |
| **Outbound rules** | Traffic leaving the server, and the default for it |
| **IP lists** | Named address sets to use as sources (your office, a monitoring service, Cloudflare). Official lists change only when you **Check for updates** and confirm |
| **Firewall service** | Turn the firewall on or off (**Turn off…**), reload it |

Docker publishes ports past UFW by default. DockGate adds rules so a container's published port obeys the firewall too.

## Fail2ban

Bans addresses that fail to log in over SSH too often.

- The banned addresses, per jail; **Unban & allow** lets one back in.
- **Ban an IP** by hand.
- **Configuration**: ban time, find time, max retries, addresses never banned, and more. Change cards, then **Review & apply all**, or **Save this card** one at a time. Changes are tested before they apply; current bans are kept.

## Services

System services DockGate manages on the server (Docker, SSH, the firewall, fail2ban, time sync…). Select one for its state, **Start at boot**, start / stop / restart, its settings and its log.

## Logs

The system journal and log files of the server in the [log viewer](observe.md#the-log-viewer). Most sources need passwordless `sudo`.

## Settings

| Row | Meaning |
|---|---|
| **Name**, **Description** | Shown everywhere in DockGate. The ID stays the same |
| **Connection** | Host and port DockGate connects to |
| **Login** | The user and how DockGate authenticates (key or password) |
| **Connection test** | Logs in now and checks Docker |
| **Docker access** | **Grant…** adds the SSH user to the `docker` group (needs passwordless `sudo`) |
| **Host key** | Pinned on first connect; **Re-trust…** after a rebuild |
| **Access password** | A second password asked before anyone switches to this server in DockGate |
| **Notifications** | Turn Telegram / email alerts for this server on or off |
| **Remove server from DockGate** | DockGate forgets the server, its SSH key file and history. Nothing on the server is changed |

## Errors and fixes

| You see | Why | What to do |
|---|---|---|
| `sudo: a password is required` | The SSH user has no passwordless `sudo` | Use the deploy user (Setup), or allow `sudo` without a password for this user |
| `Provisioning targets a remote SSH server` | Setup on *Local* | Pick a remote server |
| `Scan failed — the server may be unreachable, or the login cannot be used for the scan` | SSH failed, or the user can not read the system | Check **Settings → Connection test** |
| `Tick the confirmation for the risky components first` | A risky component without the tick | Read it, tick it, run again |
| A change is rolled back by itself | The test login after the change failed, so it would have locked DockGate out | Nothing changed. Check the new port is reachable from DockGate, or that the key is in place, then try again |
| `Host key mismatch — …` | The server's host key changed | After a rebuild: **Re-trust…**. Otherwise do not connect |
| `Updates need a reboot to take effect.` | Kernel or core libraries were updated | Reboot when it suits you |
| `Job not found (it may have finished — see run history)` | An old setup run | Open **Run history** |
