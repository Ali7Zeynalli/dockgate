# Server - Status, Security, System, Software, Automation

> **Where:** the sidebar group **SERVER** (its heading names the server in use), or click a server in **Servers**
>
> | Sidebar | Tabs |
> |---|---|
> | **Status** | Overview, Monitoring, Alerts, Logs, System info, Connection |
> | **Security** | Access & SSH, Users & keys, Firewall, Fail2ban, Honeypot |
> | **System** | Name & addresses, Network, Time sync, Disks, Kernel & limits, Config files |
> | **Software** | Setup, Services, Docker engine, Auto updates |
> | **Automation** | Cron, Timers, Scripts, Schedules |
>
> These pages were one page, *Server Console*, until 2.74.0; old links open the new place.
>
> **Works on:** one remote (SSH) server. Opening a server's console also makes it the server in use in the top bar.

The console manages the **server itself**, not Docker: what is installed, who can log in, the firewall, fail2ban, system services, cron jobs, scripts, system settings (network, DNS, kernel, disks) and logs. It works over SSH; most changes need a user with passwordless `sudo` (the deploy user has it).

**Safety first:** every change that could lock you out (SSH port, password login, firewall) is tested with a **new SSH login** before it is kept. If DockGate can not log in again, it rolls the change back by itself.

---

## Status > Overview

The state of the server and what to do next: OS, uptime, CPU, memory and disk, Docker, firewall, fail2ban, the honeypot, SSH settings, pending updates and whether a reboot is needed. Items that need attention link to the tab that fixes them; the honeypot shows as **Optional** while it is off - it is never something to fix.

## Status > Monitoring and Alerts

CPU, memory, disk, network and load: live and the last 48 hours; top processes; disks and mounts. **Alerts** sets this server's own limits (CPU, memory, disk, server down). Empty limits use the shared ones from **Settings > Notifications**.

## Software > Setup

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
| **Swap file** | Optional: a 4 GB `/swapfile` with swappiness 10 (a swappiness already set in Kernel is kept). A safety net for Docker builds and memory spikes. Refused with the reason when the disk lacks 5 GB free or the server is a container VPS (LXC, OpenVZ); a file the kernel does not take is removed again. Change it later in System > Disks > Swap |
| **Docker Engine + Compose** | From Docker's own repository |
| **Docker log limits** | Caps container logs (10 MB × 3 per container) so they can not fill the disk, and turns on live-restore (containers keep running while Docker restarts; not in Swarm mode). Merges into an existing `daemon.json` |
| **Deploy user (non-root + SSH key)** | A user with `sudo` and Docker access, and a key DockGate makes. DockGate then connects as it |
| **Docker group** | Lets the SSH user run `docker` without `sudo` |

**Set up N missing -> ** runs only what is missing or failed. Risky components ask for a tick first. A run keeps going if you leave the page; you can cancel between components. **Run history** keeps the last 200 runs with their full log.

## Security > Access & SSH

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
| **Host key** | The server's identity. **Re-trust...** after you rebuilt or reinstalled the server |

DockGate writes its SSH settings into one file (`DockGate sshd drop-in`), so the system's own `sshd_config` stays as it was.

## Security > Users & keys

Who can log in: human accounts (UID ≥ 1000) and root, with their last login. **Add user**, **Disable...** / **Re-enable...** a user, and manage the **SSH keys** in each user's `authorized_keys` (**Add SSH key**, remove). The page names the user DockGate connects as.

## Security > Firewall

UFW (or firewalld on RHEL-type systems).

| Part | What it does |
|---|---|
| **Inbound rules** | Traffic coming to the server. Anything not allowed is blocked. **Add rule**: port, protocol and, optionally, the addresses it is allowed from |
| **Outbound rules** | Traffic leaving the server, and the default for it |
| **IP lists** | Named address sets to use as sources (your office, a monitoring service, Cloudflare). Official lists change only when you **Check for updates** and confirm |
| **Firewall service** | Turn the firewall on or off (**Turn off...**), reload it |

Docker publishes ports past UFW by default. DockGate adds rules so a container's published port obeys the firewall too.

## Security > Fail2ban

Bans addresses that fail to log in over SSH too often (and, with the [Honeypot](#security--honeypot), every address that connects to port 22).

- The banned addresses, per jail; **Unban & allow** lets one back in.
- **Ban an IP** by hand.
- **Configuration**: ban time, find time, max retries, addresses never banned, and more. Change cards, then **Review & apply all**, or **Save this card** one at a time. Changes are tested before they apply; current bans are kept.

## Security > Honeypot

A fake SSH server on port 22, for a server whose real SSH listens on another port. Nobody with a reason to be there connects to port 22, so **every address that connects to it is banned on every port of the server** - the host's ports and the ports Docker publishes - before it finds the real SSH. It records the user names and passwords tried. Every login is refused; there is no shell.

**Before it can be turned on** (the page shows each check and where to fix it):

- the real SSH does not listen on 22, and DockGate connects on the new port (change it in **Access & SSH**)
- nothing else listens on port 22
- Docker is installed, and fail2ban is running (**Setup > Fail2ban**)

**Turn on...** asks for a ban time (one day, a week, 30 days) and addresses that are never banned (your office, a monitoring service). Loopback, private networks (10.x, 172.16-31.x, 192.168.x) and fail2ban's own allowlist (DockGate's address) are never banned anyway. Then one job:

| Step | What |
|---|---|
| Checks | the same checks, on the server |
| Image | `dockgate-honeypot`, built on the server from `node:22-alpine` and the honeypot's code (~2 MB on top of the base image, which the Edge agent uses too). Nothing else is downloaded |
| Container | on port 22; runs as an unprivileged user, read-only, without capabilities, 96 MB of RAM, 0.25 CPU, at most 100 connections at a time, each closed after 60 s |
| ipset | installed when missing, so a long ban list stays fast |
| fail2ban | the `dockgate-honeypot` jail: one connection = banned. Bans go to the host's firewall (iptables or firewalld) and to Docker's `DOCKER-USER` chain |
| Test | port 22 answers like an SSH server (from the server itself, which is never banned) |

A failed step removes everything again.

**What it saw**: connections and addresses (24 hours and in all), the user names, passwords, addresses and SSH programs seen most, and the latest login attempts. A connection is written down when it opens, so port scanners that never speak SSH are banned too. Banned addresses are in the **Fail2ban** tab, where **Unban & allow** lets one back in.

| On the server | |
|---|---|
| `/var/log/dockgate-honeypot/honeypot.log` | what it saw; rotated weekly, 4 kept, at most 5 MB each |
| `/var/lib/dockgate-honeypot/` | its SSH host key (the same fingerprint after a restart) |
| `/etc/fail2ban/jail.d/dockgate-honeypot.conf`, `filter.d/dockgate-honeypot.conf` | the jail and how it reads the log |
| `/etc/logrotate.d/dockgate-honeypot` | log rotation |

**Settings...** changes the ban time and the allowed addresses. **Turn off...** removes the container, its image, the jail and the rotation; you choose whether its log stays. Addresses already banned stay banned until their time runs out. While the honeypot is on, **Access & SSH** does not move the real SSH back to port 22.

## Software > Services, Docker engine, Auto updates - and System > Time sync

System services DockGate manages on the server (Docker, SSH, the firewall, fail2ban, time sync...). Select one for its state, **Start at boot**, start / stop / restart, its settings and its log.

## Automation > Cron and Timers

The server's scheduled jobs in one table: the SSH user's crontab, root's crontab, `/etc/cron.d/*`, `/etc/crontab`, the scripts in `/etc/cron.hourly | daily | weekly | monthly`, and **systemd timers** (many distributions run apt, logrotate, fstrim and certbot with timers instead of cron).

- Each job: on / off switch, the schedule in words (*Every day at 03:30*) and as written, the command, user and file, the **next run** and the **last run** (✓ / ✗ exit code, from DockGate's wrapper or the cron log).
- The top shows the **server's time** next to yours - cron runs on the server's clock - and whether a cron daemon runs at all.
- Chips filter by source, read-only system files, timers and failed jobs.

**What DockGate writes:** the SSH user's crontab, root's crontab (passwordless `sudo`) and its own file `/etc/cron.d/dockgate`. Files of the system and of packages are shown, not changed - ⋯ -> **Open in Files** to edit one yourself.

**+ New job / Edit:** name, runs as (SSH user, root, or a user of your choice in `/etc/cron.d/dockgate`), **When** picked from lists - every few minutes, every few hours, every day, days of the week or once a month, at an hour 00-23 and minute 00-59 (24-hour, server time) - or *At reboot*, or your own expression in the box, with the **next 5 runs**, the command. **Review changes...** shows what changes in the crontab before it is written; the crontab before each change is kept (**Earlier versions...**). Turning a job off keeps it as a comment (`#dg-off# ...`), so it can be turned on again.

Options for a named job:

| Option | What it does |
|---|---|
| Keep its output in a log | `>> /var/log/dockgate-cron/NAME.log 2>&1` (root) or `~/.dockgate/cron-logs/NAME.log`; ⋯ -> **Open its log** follows it |
| Notify when it fails | the job runs through DockGate's small wrapper `dg-cron`, which records the exit code; an exit code other than 0 sends **Cron job failed** with the last output lines |
| Notify when it does not run | no start within 30 minutes of its time sends **Cron job did not run** (cron stopped, the server was off) |

The wrapper of root's jobs is a root-owned copy (`/usr/local/lib/dockgate/dg-cron`), so a job of root never runs a file another user could change. DockGate checks the jobs with alerts every 5 minutes; the rules are in Settings > Notifications -> *Cron jobs*.

⋯ -> **Run now...** runs the command once as its user and shows the output and exit code (up to 2 minutes).

**Timers:** each systemd timer has an on / off switch (`systemctl enable --now` / `disable --now`, asked first; it lasts over a reboot), **Run now** (starts the service the timer runs, once, and shows its last log lines; up to 2 minutes) and **Log** (`journalctl -u <service>`). Turned-off timers are listed too. The timer files themselves are not changed. On a machine where systemd does not run (a container, WSL) timers are listed but can not be started or stopped.

## Automation > Scripts

Build a shell script from **blocks** - DockGate writes the script, safely quoted - then save it to the server, run it once, or schedule it.

| Block | What it does |
|---|---|
| Database backup | `pg_dump` / `mysqldump` / `mariadb-dump` from a database container into a `.sql.gz` file |
| Volume backup / Folder backup | a Docker volume or a folder into a `.tar.gz` file |
| Copy to another place | `rsync` to another server (`user@host:/path`) or folder |
| Delete old files | files older than N days in a folder (never in `/`, `/etc`, `/usr` ...) |
| Container: restart / stop / start, Pull an image, Docker cleanup, Compose: pull and redeploy | the Docker work |
| Check a URL, Check disk space | fail when the status is not the expected one, or the disk is fuller than the limit |
| Send a message | POST to a webhook (Slack, Discord, ntfy, Teams); `$(hostname)` and `$SCRIPT_STATUS` can be used |
| Update the system | `apt` / `dnf` / `yum`: security updates only or everything, optionally remove unused packages (needs root) |
| Reboot if an update needs it | only when the system asks for it (`/var/run/reboot-required`, `needs-restarting`), optionally only in a time window such as 04:00-05:00 |
| System service: restart / reload / check | `systemctl`; *check* fails when the service is not running |
| Shrink the system journal | `journalctl --vacuum-size`, and rotated logs in `/var/log` older than N days |
| Wait until a container is healthy, Git pull, Database maintenance | health check (or running) with a time limit, `git pull --ff-only`, Postgres `vacuumdb --analyze`, MySQL / MariaDB `--optimize` |
| Check a port, memory, CPU load, an SSL certificate | fail when the port does not answer, more memory or load than the limit, fewer days left than the limit |
| Report the busiest containers | `docker stats` sorted by memory |
| Telegram message | with a bot token and chat ID |
| Wait, Custom command | a pause; any shell, run as written |

- Each step says what happens **if it fails**: *stop* (default) or *go on*. A step stops at its first failing command.
- A step can **run only if an earlier step failed** - a fix: *check the site -> (only if it failed) restart the container -> wait until healthy -> check again*. When the fix works the run ends as *fixed*; when the last check still fails, the run fails and Cron's alert says so.
- The script it writes is shown next to the steps while you edit.
- **Templates** (18, by category - always shown below your scripts, and under **+ New script**) ask a few questions first - containers, volumes and project folders of the server are offered - then open with the answers filled in:
  - *Updates and upkeep:* daily security updates with a night reboot when needed, weekly full update (system, Docker images, reboot when needed), update a Compose project's images and check the site, monthly cleanup (Docker, journal, old logs), weekly Docker cleanup.
  - *Backups:* PostgreSQL (keep 7 days, copy off the server), MySQL / MariaDB, volume, `/etc` and the projects folder, weekly database maintenance.
  - *Health and self-repair:* restart a container when its site does not answer, start a system service again when it stopped, free disk space when the disk gets full, show the busiest containers when memory runs low, renew a certificate that expires soon.
  - *Deploy:* deploy from Git (pull, build, start, check), pull and redeploy a Compose project, restart a container every night.
- Steps that need root are marked; such scripts need passwordless sudo (they are written root-owned). Services > Auto updates still handles daily security updates by itself - the update templates add full updates and Docker on your schedule.
- **Save** writes `/opt/dockgate/scripts/NAME.sh` (root-owned, when the SSH user has passwordless sudo) or `~/.dockgate/scripts/NAME.sh`. Every write is checked with `bash -n` first - a script with a syntax error is not written.
- If the file of a blocks script was changed on the server by hand, **Save** asks first: **Keep the server's version** (the script becomes your own code, the file stays as it is) or **Write my steps over it**.
- **Run** runs it once and shows the output and exit code (up to 5 minutes). **Schedule...** (when picked from lists, as in Cron) adds it to the **Cron** tab with its log and *failed / did not run* alerts.

### Your own code

A script does not have to be made of blocks:

- **+ New script > Write my own code** - give it a name and write (or paste) the whole script. It is written like a blocks script (`/opt/dockgate/scripts/NAME.sh` or `~/.dockgate/scripts/NAME.sh`).
- **Edit** opens the file in the file editor: highlighting, **Ctrl+S**, the changes shown before saving, **Versions** (the content before each save, to compare or put back), **Check** (`bash -n`), and a warning when the file changed on the server after you opened it. **+ Insert block** puts any block (a backup, a check, a restart, a Telegram message...) at the cursor as plain shell, with its values quoted.
- **⋯ > Convert to code** turns a blocks script into your own code (one way - the steps are not kept).

### Scripts already on the server

**Add existing...** lists the shell scripts DockGate finds on the server - in `/opt`, `/root`, `/home`, `/usr/local/bin`, `/srv`, `/var/www` and `/etc/cron.*`, plus every `.sh` a crontab runs (marked *in cron*) - or takes a path you type. The file **stays where it is**: DockGate edits, runs and schedules it there, and **Remove from the list** never deletes it. A root-owned script runs as root (sudo).

Run, Schedule..., the log and the alerts work the same for every kind.

Only *Custom command* carries your own shell; every other value is checked and quoted, so a name, path, URL or message can not run a command.

## System - Name & addresses, Network, Disks, Kernel & limits, Config files

The server's own settings, each through a form. Every change shows what changes in the file, is checked by the tool that owns it, and is restored when a check fails. DockGate writes its own files where the system has a `.d` folder, so the distribution's files stay as they are.

| Setting | Written to | Checked by |
|---|---|---|
| **Hostname** | `hostnamectl`, and the `127.0.1.1` line of `/etc/hosts` | - |
| **/etc/hosts** (table) | `/etc/hosts` - localhost lines stay | `localhost` still resolves |
| **DNS servers** and search domains | `/etc/systemd/resolved.conf.d/99-dockgate.conf` (systemd-resolved) or `/etc/resolv.conf` | a name you choose must resolve, else the previous DNS is restored |
| **Network** (per interface): DHCP or static addresses, gateway, DNS, MTU | `/etc/netplan/99-dockgate.yaml` (netplan) or the NetworkManager connection | `netplan generate` / NetworkManager; **kept only when a new SSH login works** - otherwise the server restores it by itself after 120 s |
| **Kernel** (ip_forward, somaxconn, swappiness, inotify, max_map_count ...) | `/etc/sysctl.d/99-dockgate.conf` | the kernel (`sysctl -p`) |
| **Open files limit** | `/etc/security/limits.d/99-dockgate.conf` and systemd `DefaultLimitNOFILE` | - (services get it when they restart) |
| **Journal size** | `/etc/systemd/journald.conf.d/99-dockgate.conf` | journald restarts; the journal is shrunk to it |
| **Disks** (`/etc/fstab`): add or remove a mount | `/etc/fstab` | `findmnt --verify`, and a new mount is mounted once - a failure restores the file. `/`, `/boot` are not removed here |
| **Swap** (under Disks): make, resize, or turn off & remove a swap file; swappiness | the swap file, its `/etc/fstab` line, `vm.swappiness` in `/etc/sysctl.d/99-dockgate.conf` | the kernel (`swapon`) - a file it does not take is removed again; turning swap off is refused when the free RAM can not take back what is in it. Swap partitions are shown, not changed |

**The address DockGate connects to** is protected: changing it needs the new address, and DockGate then tests a login to it and switches to it.

**Config files** lists where things are set (SSH, sudoers, network, fstab, sysctl, journald, logrotate, Docker, nginx, Caddy, HAProxy) and opens them in the [editor](tools.md#the-editor). The editor checks `sshd_config` (`sshd -t`), `sudoers` (`visudo -c`) and `/etc/fstab` (`findmnt --verify`) before saving, as it already does for compose files and nginx.

Docker daemon settings (log size limits, live-restore) stay in **Services > Docker**.

## Status > Logs

The system journal and log files of the server in the [log viewer](observe.md#the-log-viewer). Most sources need passwordless `sudo`.

## Status > Connection

| Row | Meaning |
|---|---|
| **Name**, **Description** | Shown everywhere in DockGate. The ID stays the same |
| **Connection** | Host and port DockGate connects to |
| **Login** | The user and how DockGate authenticates (key or password) |
| **Connection test** | Logs in now and checks Docker |
| **Docker access** | **Grant...** adds the SSH user to the `docker` group (needs passwordless `sudo`) |
| **Host key** | Pinned on first connect; **Re-trust...** after a rebuild |
| **Access password** | A second password, asked once per DockGate session before this server is used (switching to it, its console, its pages, terminals and logs). See [Servers](servers.md). |
| **Notifications** | Turn Telegram / email alerts for this server on or off |
| **Remove server from DockGate** | DockGate forgets the server, its SSH key file and history. Nothing on the server is changed |

## Errors and fixes

| You see | Why | What to do |
|---|---|---|
| `sudo: a password is required` | The SSH user has no passwordless `sudo` | Use the deploy user (Setup), or allow `sudo` without a password for this user |
| System: `Names do not resolve with these servers - restored` | The DNS servers did not answer | Check the addresses; the previous DNS is back |
| System: network change *restored* | The new SSH login failed after the change | Nothing to do - the previous settings are back; check the address, gateway and firewall |
| System: `DockGate connects to ... - keep that address` | The change would remove DockGate's address | Keep it, or fill in the new address DockGate should use |
| System: `findmnt found errors - restored` / `mount failed - restored` | The new fstab line is wrong, or the disk / share can not be mounted | Check source, type and options (`nofail` keeps the server starting without it) |
| Scripts: `step N failed - stopping` | A command of that step failed | Run it with **Run**, read the output; set *if it fails: go on* for optional steps |
| Cron: *No cron daemon is running* | cron / crond is stopped or not installed | Start it in **Services**, or install `cron` (Debian/Ubuntu) / `cronie` (RHEL) |
| Cron: `The crontab changed after it was read` | Someone edited the crontab meanwhile | The tab reloads; make the change again |
| Cron: `Give the job a name to keep its log or to be notified` | Log or alerts ticked without a name | Fill in **Name** |
| `Provisioning targets a remote SSH server` | Setup on *Local* | Pick a remote server |
| `Scan failed - the server may be unreachable, or the login cannot be used for the scan` | SSH failed, or the user can not read the system | Check **Settings > Connection test** |
| `Tick the confirmation for the risky components first` | A risky component without the tick | Read it, tick it, run again |
| A change is rolled back by itself | The test login after the change failed, so it would have locked DockGate out | Nothing changed. Check the new port is reachable from DockGate, or that the key is in place, then try again |
| `Host key mismatch - ...` | The server's host key changed | After a rebuild: **Re-trust...**. Otherwise do not connect |
| `Updates need a reboot to take effect.` | Kernel or core libraries were updated | Reboot when it suits you |
| `Job not found (it may have finished - see run history)` | An old setup run | Open **Run history** |
