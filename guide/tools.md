# Tools → Terminal, Files, Schedules

> **Where:** sidebar **Tools**
>
> **Works on:** the server picked in the top bar (**SERVERS ▾**).

---

## Terminal

![Terminal](images/terminal.png)

| Tab | What you get |
|---|---|
| **Container** | A shell inside a running container. Pick the container and the shell (`/bin/sh`, `/bin/bash`…), then **Connect** |
| **Server** | A shell on the server. On a remote server it is a real SSH shell (`apt`, `systemctl`, `docker`…). On *Local* it is a shell inside the DockGate container, which has the `docker` CLI |

**Ctrl+`** opens the **quick terminal** from any page: a drawer at the bottom that keeps running while you move around. The **Terminal** button in the top bar does the same.

The default shell is set in **Settings → General → Default shell**. When a session ends, press **Reconnect**.

> Opening a container terminal is recorded in **Observe → Audit log** (`terminal_open`). What you type is not recorded.

---

## Files

**Remote server:** browse, edit, upload and download files on the server over SSH (SFTP).

**Local:** DockGate runs in a container, so it sees only the folders of this machine you share with it. Add them to the DockGate service in its `docker-compose.yml` and restart DockGate:

```yaml
    volumes:
      - /srv:/host/srv    # any folder you want to manage
```

They then appear under `/host/…`. Remote servers need nothing: pick one in the top bar.

![Files](images/files.png)

| Action | What it does |
|---|---|
| Open a folder, **Up one level** | Move around; the path bar shows where you are |
| **New folder** / **New file** | Create in the current folder |
| **Upload** | Files or whole folders, with progress. Drop them on the page |
| **Edit** | Text files open in an editor (see below) |
| **Permissions** | Click the `rw-r--r--` in a row: change the mode (ticks or a number like `644`) and the owner and group; for a folder, optionally everything inside too |
| **Rename** / **Delete** | One item, or tick several and **Delete selected** |
| **Download** | A file, or a folder as `.tar.gz` |
| **📦 Extract** | Unpacks `.zip`, `.tar`, `.tar.gz`, `.tar.bz2` and `.tar.xz` in place |
| **Two-pane transfer** | Your computer on one side, the server on the other: tick items and move them across |

### Quick Files

The **Files** button in the top bar (or **Ctrl+Shift+F**, or ⌘K → *Open quick files*) opens the same file browser in a window over any page — like the Terminal button. It works on the server picked in the top bar and switches with it.

- **—** or **Esc** minimizes it: the folder stays, and a dot on the Files button shows it is still open. Click the button to bring it back.
- **⤢** fills the screen; **Open page** goes to Tools → Files; **×** closes it.
- It opens in the folder you were last in on that server.

### The editor

| | |
|---|---|
| **Ctrl+S** (⌘S) | Save |
| **Esc** | Close — if something is not saved, DockGate asks first. A ● after the name means unsaved changes |
| **Save…** | Shows the changed lines (green added, red removed) before anything is written |
| **Versions** | The content the file had before each save from DockGate — the last 5 per file (up to 512 KB each). Pick one to compare it with the editor, then **Put it in the editor** and save. Kept encrypted in DockGate's database, not next to the file (a `default.conf.bak` in nginx's `conf.d/` would be loaded too) |

A save is never half written: the new content goes to a temporary file next to it, which gets the file's mode and owner, then replaces the file in one step. If the owner can not be kept (the file belongs to another user), the file is written in place, so its owner stays.

**Files of another user** (for example `/etc/nginx/nginx.conf` owned by root): DockGate offers **Open with sudo** / **Save with sudo**. This needs passwordless sudo for the SSH user — the deploy user made in Server Console → Setup has it. Owner and mode stay the same. Changing the owner (Permissions) always uses sudo on a remote server; on *Local* use numbers (uid and gid).

**Changed on the server:** if someone changed the file after you opened it, Save stops and asks: **Load theirs**, or **Save mine anyway**.

Files inside containers and volumes are edited on their own pages: **Resources → Containers →** a container **→ Files**, and **Resources → Volumes → Browse**.

---

## Schedules

Jobs DockGate runs by itself on a server.

![Schedules](images/schedules.png)

| Task | What it does |
|---|---|
| **Prune unused data** | Removes the things you tick: unused images, stopped containers, unused networks. Unused volumes are never pruned |
| **Back up a volume** | Saves the volume as a `.tar.gz` in a folder on the server and keeps the newest *N* copies (1–365, default 7) |
| **Sync Git stacks** | Pulls the chosen Git stacks (or every DockGate-managed Git stack on the server) and redeploys, only when there is a new commit |

**How often:** every hour (at a minute), every day or every week, at a time in `HH:MM`. Times are in UTC unless a timezone is set in **Settings → General → Timezone**.

The list shows each task's server, schedule, last run (with its result) and next run. Each row has an on/off switch, **Run now**, **Edit…** and **Delete…**. Deleting a task keeps the backups it made. A failed run sends the **Scheduled task failed** notification.

## Errors and fixes

| You see | Why | What to do |
|---|---|---|
| *No folder of this machine is shared with DockGate yet* | Files on *Local* with no folder shared | Add a volume under `/host` as shown above, or pick a remote server |
| `Permission denied: … belongs to another user — open it with sudo` | The SSH user may not read or write this file | **Open with sudo** / **Save with sudo**, or tick **Use sudo** in Permissions |
| `sudo asks this user for a password — DockGate needs passwordless sudo` | The SSH user has sudo only with a password | Connect with the deploy user (Server Console → Setup), or allow passwordless sudo for this user |
| *Changed on the server* | The file changed after you opened it | **Load theirs** to see it, or **Save mine anyway** |
| `Mode: 3 or 4 octal digits, e.g. 644 or 0755` | Wrong mode in Permissions | e.g. `644` for files, `755` for folders |
| `Owner and group: a user / group name or number` | Wrong owner or group | A user name like `www-data`, or a number like `33` |
| `Session expired — sign in again` | You were signed out during a transfer | Sign in and start the transfer again |
| *— session ended (press Reconnect) —* | The shell exited, or the connection dropped | **Reconnect** |
| `Time must look like 03:30` | Wrong time format | `HH:MM`, 24-hour |
| `The backup folder must be an absolute path at least two levels deep, e.g. /var/backups/dockgate` | A folder like `/` or `/backups` | Use a deeper folder |
| `Keep between 1 and 365 copies` | Value out of range | e.g. `7` |
| `Tick at least one thing to prune` | Prune task with nothing ticked | Tick images, containers or networks |
| `Choose a volume` / `Choose a server` / `Choose a day of the week` | Empty field | Fill it in |
