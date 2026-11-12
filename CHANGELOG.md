# Changelog

---

## [2.41.0] - 2026-11-12

### Added
- **Swarm autoscale.** Docker Swarm does not scale services by itself; DockGate now can. On a service's page, the new **Autoscale** tab sets:
  - minimum and maximum replicas;
  - add a replica when the average CPU per task stays at or above a % for some minutes (default 75% for 5 min), remove one when it stays at or below a % (default 25% for 10 min);
  - a wait between changes (default 5 min), so new replicas settle;
  - spreading the replicas over the servers (placement preference `spread=node.id`).

  CPU per task is the % of the service's CPU limit, or of one CPU core when it has none. DockGate checks every minute, changes one replica at a time, never during a rolling update, and keeps working whichever server is picked at the top. Each change is shown in the tab's History, in the audit log and through the new **Swarm autoscale** notification rule; the Services list marks services with a rule (*auto 2–5*). Not offered for global services or databases, and a warning is shown for services with volumes. Autoscale does not add servers: a replica that fits nowhere waits as pending.

---

## [2.40.0] - 2026-11-12

### Added
- **A page for each Swarm node**, like the service and container pages. Click a node's name in Swarm → Nodes or on Swarm → Overview. Tabs:
  - **Overview** — role, state, availability, address, capacity, OS, Docker, DockGate server, joined, last change, labels.
  - **Tasks** — every task Swarm placed on the node (running now, or with history), with errors; click a service to open it.
  - **Resources** — CPU, memory, disk and network of the node's DockGate server, live and for 48 hours, with its alert rules.
  - **Labels** — the labels and which services' placement rules use them; edit them here.
  - **Events** — Docker events about the node in the last 24 hours. **History** — what was changed on it from DockGate. **Inspect** — the raw JSON.
  - The buttons on top are the node actions: Activate, Pause, Drain…, Promote / Demote, Server console, Add to DockGate…, Remove….

---

## [2.39.0] - 2026-11-12

### Added
- **Swarm jobs can be reopened from every Swarm page.** While a job runs (move to Swarm, redeploy, add servers, rotate a secret …), a bar at the top of each Swarm tab names it — e.g. *Redeploy · shop is running* — with **Open log**; for 10 minutes after it ends the bar shows how it ended. The sidebar shows **Swarm ▶ 1** while it runs, as Deploy and Servers do for their jobs.
- **Swarm → Overview → Recent jobs:** the Swarm jobs of the last 6 hours with their result and time; any of them opens its steps and log again. Before, a closed job window could only be reopened from Overview while the job was still running, and not at all once it had ended.

### Fixed
- **Back and Forward forgot where you were.**
  - The tab of a container page and of a Swarm service page is now in the address, so Back, Forward and a refresh return to the same tab (it was always Overview).
  - The list you came from keeps its filter, search, sort and scroll position (Containers, Images, Volumes).
  - The **Back** button on a container or service page returns to the page you came from (it always opened the list, and added a history step).
- **The sidebar showed nothing selected on a container or Swarm service page.** It now highlights Resources → Containers or Swarm → Services.

---

## [2.38.13] - 2026-11-12

### Added
- **Contributing guide, security policy and code of conduct** (`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`). GitHub now shows them as tabs next to README and License. The contributing guide explains how to run DockGate locally, test, version and open a pull request; the security policy explains how to report a vulnerability privately and what is in scope.
- **Issue forms** for bug reports and feature requests. Blank issues are off; security problems are sent to the private report form.
- README links to the contributing guide.

---

## [2.38.12] - 2026-11-11

### Fixed
- **Creating a network returned DockGate's internal Docker client object** (with its connection settings) to the browser. It now returns only the new network's ID.
- **Network errors came back as server errors (500).** Creating a network whose name or subnet is taken, or removing one that is in use or built in, now keeps Docker's own status (409 / 403) with its message.

---

## [2.38.11] - 2026-11-11

### Fixed
- **Files tab: a folder that can not be opened was called missing.** When the container's user may not open a folder, the Files tab now says *The folder … can not be opened (permission denied)* instead of *does not exist*. A stray "No such file or directory" in other output is no longer taken for a missing shell.
- **Volume clone accepted a one-character name** that Docker then refused with a server error. The name rule now matches Docker's (at least 2 characters).
- **Resources → Networks** explains that Swarm's own networks and networks with Swarm services can not be removed either.

---

## [2.38.10] - 2026-11-11

### Fixed
- **Restoring a volume from a plain `.tar` failed.** Resources → Volumes → Restore from .tar.gz… lets you pick a `.tar`, but the volume was always extracted as gzip, so a plain tar stopped with *Restore failed (tar exited 1)*. DockGate now looks at the first bytes of the upload and extracts `.tar.gz` and `.tar` alike. An empty file says *The file is empty*, and a file that is neither says so instead of a server error.

---

## [2.38.9] - 2026-11-11

### Fixed
- **Networks in use were shown as unused.** Docker's network list does not say which containers are attached, so every network counted 0 containers. Resources → Prune listed running projects' networks (such as `blog_default`) and Swarm's `ingress` under *Unused networks*, and Resources → Networks let you tick and remove networks that were in use (Docker then refused). DockGate now counts the containers on each network from the container list and the Swarm services attached to it. `ingress` and `docker_gwbridge` are marked *made by Swarm* and never offered for removal, and the *Used by* column shows Swarm services too.

---

## [2.38.8] - 2026-11-11

### Fixed
- **Cloning a volume under a name that was already taken wrote into that other volume.** Docker hands back the existing volume when the name is in use, so Resources → Volumes → Clone… copied the files over its data without a word. Clone now refuses: *A volume named … already exists — choose another name*. A name Docker does not accept and a missing source volume are refused too, and if copying fails the new volume is removed and the error is shown instead of a silent success.

---

## [2.38.7] - 2026-11-11

### Fixed
- **Files tab said "Empty" when it could not list a folder.** In a container without a shell (images built `FROM scratch`, such as `traefik/whoami`) it now says *The container has no shell (sh) — files can only be downloaded and uploaded*, the same message the file editor gives. A folder that does not exist now says *The folder … does not exist*, in containers and in volumes, and a stopped container says *The container must be running*. Real empty folders still show as empty.

---

## [2.38.6] - 2026-11-11

### Changed
- **README opens with the DockGate logo and a short animated tour** (Dashboard, Containers, Compose, Swarm overview, services, a service page, stacks and Monitoring), taken from a running DockGate.
- **Screenshots shown two per row** so the text in them can be read.
- **The "From source" commands have their own code block** instead of one long line in the table.

---

## [2.38.5] - 2026-11-11

### Changed
- **README shortened and tidied.** It is now about half as long: a short intro, Quick Start with update and backup in one table, screenshot galleries for Docker, Docker Swarm and the rest, a features table, and the details (architecture, API) folded away.
- **New Swarm screenshots:** Migrate, Secrets & configs and Overlay networks; the Stacks screenshot was retaken.

### Fixed
- **Stacks made from a `docker run` container were labelled "moved from Compose".** The Last deploy column and the History dialog now say "moved from container", "moved back to the container" and "container started again" for these stacks.

---

## [2.38.4] - 2026-11-11

### Changed
- **Unused screenshots removed.** `screenshots/` now holds only the 18 images the README shows. The 12 removed ones were from the old interface or not shown anywhere: images, builds, networks, events, files, infrastructure, server console, and the general, log, update, system and security settings.

---

## [2.38.3] - 2026-11-11

### Fixed
- **README described a DockGate backup that does not exist.** Settings → System → Backup was taken out in 2.15.1, but the rewritten README still offered it in Quick Start, Settings and the data folder list. It now says to back up the `data/` folder, and that volume data is backed up from Resources → Volumes or a volume backup task in Tools → Schedules.

---

## [2.38.2] - 2026-11-11

### Changed
- **README rewritten for the current DockGate.** It describes the real sidebar, adds a Docker Swarm section, lists the 21 alert rules by group, and updates the architecture, limitations, tech stack (nodemailer 10), API and configuration (`DATA_DIR`, `BIND_HOST`, `FILES_ROOT`). It no longer says that Swarm support was removed or that Compose only works on Local.
- **New screenshots** taken from a running DockGate, including the Swarm pages, Monitoring and the container terminal.

### Fixed
- **Opening a container terminal could stop DockGate.** When the browser sent the terminal size before the shell had started (or after it ended), Docker answered "exec process is not started". That rejected promise was not caught, and Node stopped the whole process. The error is now ignored, as it was meant to be. Fifteen quick open–resize–close rounds stopped the old version and leave the new one running.
- **The Back button on a container's page showed its text upside down** ("Back" was rotated along with the arrow). Only the arrow is turned now.

---

## [2.38.1] - 2026-11-11

### Fixed
- **The image for v2.38.0 was not published** because one test failed on GitHub Actions with "SQLITE_BUSY: database is locked" (test/unit/file-manager-local.test.js). `node --test` runs the test files in parallel processes, and 17 of them shared one `data/docker-panel.db`. On a fresh checkout several processes switched that new database to WAL at the same moment. Each test file now gets its own empty data folder (`test/setup-env.js`, loaded by `npm test`), so the files no longer share a database. DockGate itself is not changed.

---

## [2.38.0] - 2026-11-11

### Added
- **A page for each Swarm service, like a container's page.** Click a service's name in Swarm → Services, choose ⋯ → Open, or use **Open service** on a task in Resources → Containers. The page has the same buttons as the list: Scale, Update to newest, Update image, Roll back, Restart, Settings, Remove. Its tabs:
  - **Overview:** image, mode and replicas, running tasks per server, ports, the name and virtual IP it is reached by, command, resources, update settings and the last update. The reason is shown when tasks do not run.
  - **Tasks:** every task with its server, state, reason, image and age, plus Logs, Terminal, Files and Inspect for each running task.
  - **Logs:** live, for all tasks or one.
  - **Terminal:** a shell in a chosen task, in the page, also on another node in DockGate.
  - **Files:** the files of a chosen task's container, also on another node: browse, edit, new file and folder, rename, delete, download and upload a .tar.
  - **Stats:** CPU and memory now, and graphs for the last 1 to 48 hours.
  - **Environment:** values that look like passwords are hidden until shown.
  - **Ports**, **Volumes**, **Networks**, **Secrets & configs** (with the file path in the task) and **Placement** (constraints, resources, restart). Each has **Edit…**, which opens the service settings.
  - **Updates:** the image now, the registry check, the previous version, Check for updates, Update to newest, Update image and Roll back, plus everything changed from DockGate.
  - **Events:** Docker events of the last 24 hours.
  - **Inspect:** the JSON, with Copy.
- Files and downloads of a task on another node go through that node's DockGate server, and every change is recorded in the audit log.

---

## [2.37.0] - 2026-11-11

### Added
- **Move to Swarm… from Deploy → Compose stacks.** With Swarm on, each compose project row has a **Move to Swarm…** button. It opens the same move dialog (settings, plan, move) on that page. A project that can not move shows why. Before, it was only in the ⋯ menu and opened the Migrate page.
- **Swarm in Resources → Containers.**
  - A Swarm task shows "⎈ Swarm task of *service* · stack *name*".
  - A container moved to Swarm (docker run → stack) shows "⎈ moved to Swarm · stack *name*". It has **Open stack** instead of Start, because starting it would run the app twice.
  - A **Swarm** filter lists only those.

### Fixed
- **Moving a project to Swarm on a remote server with a password, or a key with a passphrase, failed** with "Remote Compose/Stack needs a key-based SSH server with no passphrase", after Compose had already stopped the project; DockGate then started it again. Compose commands ran on the server over DockGate's SSH session, but `docker stack deploy` used the local Docker CLI over ssh://, which can only use a key without a passphrase. Stack commands (`docker stack deploy`, `docker stack config`) now run on the server itself over the same SSH session as Compose, so password, key and key with passphrase all work. The stack file, its variables and the registry logins go to a private temp folder on the server by SFTP and are removed after; they are never on the command line.

---

## [2.36.1] - 2026-11-11

### Fixed
- **App templates whose compose file is in a GitHub repository did not load** ("No compose content found for this template"). That is most stack templates of the default catalog. DockGate asked github.com/…/raw/…, which answers with a redirect that DockGate's safe fetch refuses. It now asks raw.githubusercontent.com directly (main, then master). This affected Deploy → App templates and Swarm → New stack → template.

---

## [2.36.0] - 2026-11-11

### Added
- **Edit files inside containers and volumes.** The container Files tab and the volume file browser now have:
  - **Edit** for a text file up to 1 MB. Saving keeps the file's owner and permissions; Ctrl+S saves.
  - **New file** and **New folder**.
  - **⋯ → Rename… / Delete…**. Deleting asks for the name; a folder is deleted with everything in it.
  - Paths can not leave `/` (container) or the volume. The top folder and system folders such as /etc and /usr can not be deleted.
  - Containers must run (DockGate uses exec there); volumes use a short-lived helper container. Every change is recorded in the audit log.
- **Move part of a compose project to Swarm.** A project where some services can not run on Swarm (privileged, devices, network_mode) shows "Part can move" in Swarm → Migrate instead of "Not possible".
  - The other services move to the stack *project*-swarm; only they are stopped in Compose (`docker compose rm -s`).
  - Volumes are used by their Compose names, so the data stays.
  - The services that stay in Compose are connected to the stack network with their service name, so both sides reach each other by name as before.
  - Compose → Stacks shows "Part on Swarm". Compose Up for the project is refused while part runs on Swarm, because it would start those services twice.
  - Redeploy, Swarm settings and Move back to Compose work as for a whole project. Move back brings the services back into the same project.
- **Restore from a backup.** Swarm → Cluster settings → Backups → **Restore…** recreates on the swarm in use what the backup describes and is missing here:
  - overlay networks, configs with their content, secrets, services (with their networks, configs and secrets matched by name), node labels (by hostname) and DockGate's stack records;
  - secret values are typed in, because a backup has names only (Swarm never gives the values out). A service whose secret has no value is skipped;
  - names that exist are left alone, and you choose which services to restore.
  - **Upload a backup…** adds a backup downloaded from another DockGate, for example from a server that is gone.
  - Backups now also record network IDs, so services get their networks back.

### Fixed
- **Stacks deployed from a stack file or moved from a container were listed in Deploy → Compose stacks** as compose projects "on Swarm". Only projects moved from Compose are listed there now.

---

## [2.35.0] - 2026-11-11

### Added
- **New stack from a stack file.** Swarm → Stacks → **New stack…** takes a stack file (compose format) and optional variables (KEY=VALUE for `${KEY}`, kept encrypted).
  - **Check** validates it with `docker stack config` before anything runs.
  - Deploy runs `docker stack deploy` and waits until every service runs.
  - DockGate keeps the file. **Edit stack file…** changes and deploys it again, and History can deploy an earlier file again.
- **Deploy an app template as a Swarm stack.** With Swarm on, deploying a stack template asks: Compose project (as before) or Swarm stack. New stack… can also start from a template.
- **Take over a stack deployed outside DockGate.** Stacks → ⋯ → **Take over…** writes a stack file from the running services (image, command, environment, ports, volumes, networks, secrets, configs, placement, resources, restart and update settings). Check it and save: DockGate keeps it for Redeploy and Edit stack file. Nothing is deployed when it is taken over; the stack's own volumes and networks keep their names.
- **Move a container started with docker run to Swarm.** Swarm → Migrate → **Containers started with docker run** → Move to Swarm… writes a one-service stack file from the container for you to check, with notes on what does not carry over (privileged, devices, host network, bridge networks, a host address on a port).
  - The container is stopped and kept, with its restart policy set to "no", then the stack is deployed.
  - If the service does not come up, the stack is removed and the container is started again.
  - Named volumes are used by their own name, so the data stays; bind mounts keep their host path. With several servers the service stays on this one.
  - Stacks → ⋯ → **Move back to the container…** removes the stack, gives the container its restart policy back and starts it.

### Fixed
- A new stack could not be given the name of a compose project on the server (that would have blocked the project's Compose commands).

---

## [2.34.0] - 2026-11-11

### Added
- **Newer images for Swarm services.** A service runs its image pinned to one build (tag@digest), so every node runs the same one. DockGate now compares that build with what the registry gives for the same tag.
  - Swarm → Services → **Check for updates** checks now; it also runs once a day with the container check. A service with a newer build shows "newer image" and its version when the image tells it.
  - **Update to newest…** (the service's ⋯ menu) writes the new tag@digest, so all nodes run exactly that build. The update rolls one task at a time and goes back by itself when new tasks fail.
  - With the "Newer image available" alert on, a new build is announced once (email, Telegram, webhook).
- **CPU and memory per node** in Swarm → Nodes: use in percent and the node's CPUs and memory, read from its DockGate server every 30 seconds. A node not in DockGate shows its size only.
- **Service graphs.** Swarm → Services → ⋯ → **Graphs** shows CPU and memory of all the service's tasks for the last 1 to 48 hours. DockGate records every 2 minutes while the server in use is a manager.

### Fixed
- **Newer-image checks failed for a registry on the same machine** (localhost:5000) with "fetch failed": DockGate asked it over HTTPS. Like Docker, it now uses HTTP for localhost and 127.0.0.1.

---

## [2.33.0] - 2026-11-11

### Added
- **Cluster settings can be changed after the swarm was created** (Swarm → Cluster settings):
  - node certificate lifetime and task history per slot (**Change…**);
  - autolock on or off. Turning it on stores the new unlock key (encrypted) and shows it once; turning it off removes the stored key.
- **Join tokens.** Cluster settings → Join tokens → **Show…** gives the full `docker swarm join` command for a worker and a manager, with Copy. **Rotate…** makes a new token; the old one stops working and servers already in the swarm stay. Showing and rotating are recorded in the audit log.
- **Terminal into a Swarm task on any node.** Services → Tasks → **Terminal** opens a shell in that task's container, also when it runs on another server, as long as that server is in DockGate. It does not close a terminal open elsewhere.
- **Inspect (JSON)** for services and nodes (their ⋯ menu) and for tasks (Services → Tasks → Inspect), with Copy.
- **Volumes** list the Swarm services that use a volume (⎈ name), and such a volume counts as in use, so it is not offered for removal.
- **Swarm → Networks** shows each network's gateway under its subnet.

---

## [2.32.1] - 2026-11-11

### Fixed
- **Set up Swarm → Several servers could not be finished when DockGate runs in Docker.** DockGate can not list the addresses then, and the address field stayed hidden behind a list with one entry. The field now shows at once.
- **Rebalance and Rotate sent the whole service spec in the URL and no registry login.** A service with many settings could fail with "URL too long", and tasks of a private image started on another server failed with "No such image". They now update the service the same way the Services page does.
- **Turn Swarm off with stacks moved from Compose** removed those stacks and left their projects stopped, still marked "Runs on Swarm" (Compose Up refused). It is now refused until they are moved back to Compose or removed; DockGate's node records of the cluster are cleaned up after.
- **Move back to Compose failed when the swarm was removed outside DockGate.** The stack is gone with the swarm, so it now goes straight to `docker compose up -d`.
- **An emptied replicas field deployed a service with 0 replicas** (and text gave an invalid file). Empty or invalid now means the default, 1.
- **Compose Build was refused for a project moved to Swarm**, although it only builds images — the way to give a stack with `build:` a new image before Redeploy. It is allowed again.
- **An image update that failed while starting** left the container locked ("an update is already running") until DockGate restarted.
- **The unlock dialog said a key was stored** after the swarm was turned off and created again.
- **The Swarm monitor asked every server for its state every 30 seconds**, also when the cluster had already been read from another manager in that round.

---

## [2.32.0] - 2026-11-11

### Added
- **Swarm in the other pages.**
  - **Dashboard** shows "Swarm · 9/9 tasks" (and the ready servers with several), amber when tasks or servers are missing or the swarm has no leader; it opens Swarm.
  - **Server Console → Firewall:** rules DockGate added for Swarm say "Swarm · between the cluster servers", and deleting one warns that the cluster servers would no longer reach each other — remove a server in Swarm → Nodes instead, which deletes its rules. (Swarm firewall rules are now tagged `dockgate:swarm`, like DockGate's other rules.)
  - **Server Console → Services → Docker:** the Swarm row links to the Swarm page.
  - **App templates:** with Swarm on, opening a compose template says how to run it as a stack (deploy, then Move to Swarm…).

### Fixed
- **Live restore could be turned on for a server in a swarm** (Server Console → Services → Docker). Docker does not start with live-restore on in swarm mode, so saving it would have stopped Docker on that server. The switch now only turns off there, and the server refuses the setting.

---

## [2.31.0] - 2026-11-11

### Added
- **Swarm, phase 7: backup and recovery.**
  - **Cluster settings → Backups:** **Back up now**, a nightly backup (on by default, switch on the page) and the list of backups with **Download**. A backup is one .tar in DockGate's data folder (`data/swarm-backups/`, the last 7 per cluster, readable only by DockGate) with `swarm-dir.tar.gz` — the manager's `/var/lib/docker/swarm` (Raft state), read through a helper container that is never started; `cluster.json` — the cluster spec without join tokens, nodes and labels, services, overlay networks, configs with content and secrets by name only (Swarm never gives their values); with autolock the unlock key encrypted for this DockGate; and `RESTORE.txt`. It is taken while Docker runs; Docker recommends stopping Docker for a perfectly consistent copy. Downloads are in the audit log — the archive holds the node's certificates.
  - **How to restore** explains bringing the cluster back on a new server when every manager is lost (stop Docker, put the swarm folder back, `docker swarm init --force-new-cluster`, unlock, join the others). It is not automatic: that case is rare and runs on a server DockGate does not know yet.
  - **Recover cluster…** — when most managers can not be reached the Overview says so (services keep running, nothing can be changed) and offers to wait or to recover. Recover, with the server name typed in: a backup first, then `docker swarm init --force-new-cluster` on the manager in use (a one-manager cluster that keeps every service and node), then the managers that are gone are removed, and what to do next (promote workers or add managers). It is refused while the cluster has a leader.

---

## [2.30.0] - 2026-11-11

### Added
- **Swarm, phase 6: alerts, numbers and logs.**
  - **Four Swarm alerts** in Settings → Notifications (on by default, sent through email, Telegram and webhook): a service runs fewer tasks than wanted for 2 minutes (the limit can be changed) and when it is back, with the reason from its tasks; a server of the swarm goes Down and when it is Ready again (with how long, and a hint to Rebalance); a service update was rolled back or paused; most managers can not be reached and when they are back. DockGate looks at every swarm it knows every 30 seconds through one of its managers. After a DockGate restart the first look only records the state, so nothing already known is sent again. A server's notification switch applies.
  - **Services: CPU and memory** of each service — the sum over its running tasks, read with `docker stats` from each node's DockGate server (a node not in DockGate has no numbers), refreshed every few seconds.
  - **Observe → Logs → Swarm service**: `docker service logs` of every task of a service on every server in the log viewer, the source is task @ server. Shown while Swarm is active.
  - **Resources → Containers:** a task container shows "Swarm task of <service>" and **Open service** instead of Stop, Restart and Update — Swarm would start a stopped task again at once.

### Fixed
- **A "server not reachable" or "reachable again" alert that could not be sent was lost.** When a channel is set up and the rule is on but no channel took the message (network error, Telegram or the mail server not answering), DockGate now tries again every minute for 15 minutes and marks it as sent late. Swarm alerts use the same retry.

---

## [2.29.0] - 2026-11-11

### Added
- **Swarm, phase 5: secrets, configs and networks.**
  - **Swarm → Secrets & configs:** every secret and config with the services that use it and the file path in the container, when it was made and where from (DockGate, a stack, outside). **New secret…** (the value goes to Swarm only — DockGate does not store, log or show it again; in a task it is /run/secrets/<name>) and **New config…** (file content; **View** shows it).
  - **Rotate… (secret) / Edit… (config)**, as a job: Swarm can not change a secret or config, so DockGate creates `<name>_v2` (then _v3 …), moves every service that uses it to the new one with a rolling update — the file path in the container stays the same — and removes the old one when all updates finished. If an update fails or rolls back the job stops and the old one stays. A secret of a stack says to change the compose file too.
  - **Remove…** only when no service uses it.
  - **Swarm → Networks:** overlay networks with subnet, options (encrypted, attachable, internal) and the services that use them. **New overlay network…**: encrypted (IPsec), attachable (plain containers may join), internal (no internet), subnet from the pool or your own. Creating an encrypted network allows ESP between the cluster servers DockGate manages (and says where it could not). **Remove…** only when unused. **Change subnet…** recreates the ingress network with another subnet, only when no service publishes a port through it (for an ingress subnet that overlaps a cloud private network).
  - The overlay encryption chosen in Set up Swarm / Add servers is now kept and used for stack networks.
  - **Migrate** points out environment variables that look like passwords (…_PASSWORD, …_TOKEN, …_SECRET, …_API_KEY) and how they can become secrets through *_FILE variables — DockGate does not change them by itself.

---

## [2.28.0] - 2026-11-11

### Added
- **Swarm, phase 4: Stacks and moving compose projects.** The compose files are never changed.
  - **Swarm → Migrate** lists the compose projects on the server in use (also ones started by hand: their compose file is found from the container labels). Each is **Ready**, **Attention** (it can move; something is shown — a build image is used, a database stays at 1 replica, depends_on conditions are not waited for, settings Swarm ignores) or **Not possible** (privileged, devices, network_mode host, no compose file, a file secret on a remote server), with what changes per service.
  - **Review…**: per service the replicas (databases always 1), the port mode (ingress: every server answers; host: the app sees the real client IP) and the update order (services with data are always stop-first, so two copies never share a volume). The **plan** shows each service as it will run on Swarm, the changes, the volumes that stay the same and the overlay network.
  - **Move** runs one job, one project at a time: the files are read again (a project whose files changed since the plan is not touched) → `docker compose down` (volumes stay) → `docker stack deploy` under the same name → every service must run and stay up for 30 s (`SWARM_MOVE_WATCH_MS`). If not, the project is put back: the stack is removed, DockGate waits until its network is gone and runs `docker compose up -d`. The report says which projects moved, which were put back and why, and how long each was down.
  - **How the files are adapted in memory:** `docker compose config` (fills in .env, merges several files) → container_name, build, restart and settings Swarm ignores are removed; restart becomes the restart policy; depends_on conditions become a list; ports become numbers (a host address is dropped); networks become attachable overlays (encrypted when chosen at setup); volume names stay; DockGate's Swarm settings are added (safe update and roll back defaults). On several servers a service with data is kept on the server where its data is. Deployed with `docker stack deploy --prune --with-registry-auth`, so private images use the logins from Deploy → Registries.
  - **Swarm → Stacks**: each stack with its origin, services, running tasks and last deploy. **Redeploy** reads the compose files again; **Swarm settings…** changes replicas, port mode and update order (kept in DockGate) and redeploys; **History** lists every deploy, move and move back with the files' hash, the result and the downtime, and can deploy an earlier one again; **Move back to Compose…** removes the stack, waits for its network and runs `docker compose up -d` — the data stays; **Remove…** keeps volumes, secrets and configs.
  - **Deploy → Compose stacks:** a moved project shows **Runs on Swarm** with **Open stack**; Compose Up, Restart, Build, Rebuild, Redeploy, Git sync and image updates are refused for it, so it never runs twice on the same ports and volumes. Each project's menu has **Move to Swarm…**.
  - The Overview's "compose projects outside Swarm" notice has **Migrate…**.

### Not in this version
- Moving part of a project (a privileged service stays in Compose, the rest moves) — such projects are "Not possible" for now.

---

## [2.27.0] - 2026-11-10

### Added
- **Swarm, phase 3: Services.** A new **Swarm → Services** tab.
  - **The list:** each service with its image, mode, running/wanted tasks and a square per task (green running, amber starting, red failed — hover for the server and the error), its ports, the last update (updated, rolling back, rolled back, paused) and, when a task does not run, why: "no suitable node (scheduling constraints not satisfied …)", "exit code 137", a network error. Refreshes every 5 seconds.
  - **Scale…**, **Update image…** (change the tag or pull the same tag again; Swarm replaces tasks by the service's update settings and goes back by itself when a new task fails), **Roll back to previous**, **Restart** (every task, one at a time), **Logs** (docker service logs of every task in the log viewer, the source is task @ server, up to 10,000 lines), **Tasks** (where each task ran, when and why it stopped, exit code 137 explained), **Traffic** (how requests reach the tasks: the virtual IP, ingress routing mesh or host ports and what the app sees as the client IP), **Remove…** (volumes stay).
  - After Update, Roll back, Restart, Save and New service a window follows the update: Swarm's state and message, and the tasks with server, image and state.
  - **Settings…** and **New service…** — the full form in 10 sections: General (mode replicated / global / job, replicas, image, entrypoint, command, user, working directory, hostname), Resources (CPU and memory limits and reservations, PID limit, generic resources such as GPUs), Placement (constraints, spread by a node label, at most per server), Updates & rollback (order, tasks at a time, delay, watch time, failure action, failure ratio), Restart (condition, delay, max attempts, window), Health check (image's, custom or off), Env & secrets (environment, secrets, configs, service and container labels), Ports & network (ports with ingress or host mode, VIP or DNS round robin, overlay networks with aliases, DNS servers, extra hosts), Mounts (volume, bind, tmpfs, volume driver) and Advanced (capabilities, sysctls, ulimits, read-only, init, stop grace and signal, log driver). Settings the form does not show are kept as they are; an image digest stays pinned when the image is not changed.
  - **New services get safe defaults:** one task at a time, the new task first (start-first), back to the previous version when a new task fails within 15 s, restart on any exit after 5 s, json-file logs 10 MB × 3. With host-mode ports the update order is stop-first (two tasks can not hold one host port).
  - **Guards:** a database image (postgres, mysql, mariadb, mongo, redis …) with more than one replica asks first — those are separate databases, not copies; the mode of a service can not be changed; constraints, mounts, ports, durations and sizes are checked with a clear message. A service of a stack says that the next stack deploy writes over changes made here. privileged and devices are not offered: Swarm does not support them.

---

## [2.26.0] - 2026-11-10

### Added
- **Swarm, phase 2: several servers and nodes.**
  - **Set up Swarm… → Several servers:** the server in use is the first manager; choose other DockGate servers as managers or workers (the wizard says how many losses the managers tolerate and warns at 2). Checks run on every server over SSH: Docker version against the manager's, not already in a swarm, live-restore, duplicate host names, CPU architecture, clock and NTP, whether it reaches the manager on 2377/7946, and its firewall. **Network** picks the address each server uses (a private address on the same network is suggested; addresses already in the cluster are left out), offers overlay encryption (recommended when an address is public) and shows the firewall plan.
  - **Add servers…** (Overview or Nodes) joins more DockGate servers to the running swarm the same way.
  - **One job does it all:** the Swarm ports (2377/tcp, 7946/tcp+udp, the data port/udp, ESP when encrypted) are allowed on each server's UFW or firewalld **only from the other cluster servers**, existing members get rules for the new addresses, then the servers join one at a time with a token that never leaves DockGate, and each is checked Ready. If a step fails, the servers that joined leave again, their nodes are removed, the firewall rules are deleted (and with "Several servers" the swarm is removed).
  - **Swarm listens on the chosen address** instead of every interface when that address belongs to the server, so with a private network 2377 is not on the public IP.
  - **Nodes tab:** each node with its DockGate server, address, role, state, labels, running tasks, Docker version and CPU. Actions: **Pause**, **Drain…** (says which services move, which have nowhere to run — pinned or global — and warns that a data volume stays behind), **Activate**, **Promote / Demote** (shows the manager count after it), **Labels…** (validated, shows which services use them), **Remove…** (job: demote, drain, leave on the server, remove from the list, delete its firewall rules) and **Add to DockGate…** for a node joined elsewhere (opens Add server with its address).
  - **Rebalance…** restarts the tasks of services that can move, one service at a time; pinned, global and data-volume services are left alone.
  - **Overview** shows which DockGate server each node is, warns about nodes not in DockGate and about tasks not spread evenly (with Rebalance), and has **Add servers…**.

### Changed
- Guards: no Drain when no other server is active; the last manager is not demoted; the node DockGate manages through is not demoted or removed; the leader is not removed; Turn Swarm off asks to remove the other nodes first.

---

## [2.25.0] - 2026-11-10

### Added
- **Swarm, phase 1: one server.** A new **Docker → Swarm** section for the server in use.
  - **Set up Swarm…** is a five step wizard (Mode, Server, Checks, Options, Create). Nothing changes on the server before the last step.
  - **Checks:** Docker version, whether the server is already in a swarm, `live-restore` (Swarm does not run with it; the fix is shown), the node name, the address to advertise (read over SSH; a private address is suggested), whether the overlay address pool overlaps a network the server already uses (a cloud private network such as 10.0.0.0/16, a Docker network) — then a free pool is suggested — the firewall note, and the compose projects that keep running.
  - **Options:** the address, and under Advanced the address pool and mask, data port, node certificate lifetime, task history and autolock.
  - **Create** runs as a job with a live log (can be closed and reopened): `docker swarm init`, then a check that the node is Ready; if the check fails, the server leaves the swarm again. With autolock the unlock key is shown once and kept by DockGate (encrypted). When Docker can not choose between several addresses, the wizard asks which one to use.
  - **Overview** (refreshes every 5 seconds): one sentence, warnings (tasks not running, manager count, compose projects outside Swarm), four numbers (ready servers, managers and how many losses they tolerate, services, running tasks), "Where tasks run" with a card per node and its tasks (green running, amber starting, red failed with the error), and the Swarm events of the last 24 hours.
  - **Locked swarm** (autolock after a Docker restart): the Overview says so and **Unlock…** uses the stored key or one you enter.
  - **Cluster settings:** cluster ID, creation date, address pool, data port, certificate lifetime, task history, autolock with **Show unlock key…** (audited), and **Turn Swarm off…**.
  - Compose projects are not stopped or changed by any of this. Services, stacks, nodes and moving compose projects to Swarm come in the next versions.

---

## [2.24.1] - 2026-11-10

### Added
- **Compose stacks show image updates.** A stack row lists its services that have a newer image ("app: 15.8 → 15.19", or "newer image pulled" when the tag is already on the server) and its last image update ("app updated 2h ago · 15.8 → 15.19", or that it failed). An image update or roll back of a compose service is also a row in the stack's **Deploy history** with the service and versions. A newer build of the same version reads "newer build of 15.19".

### Fixed
- **"Update failed: compose exited with code 1" said nothing about why.** The compose output was only in the job log, which the old Update did not show. The error now ends with the line from compose that says why (for example "pull access denied …", "env file … not found", "no such service …", "toomanyrequests …"), in the notice, the update history and the stack's deploy history. Failed deploy errors there are no longer cut at 80 characters.
- **Edge agent: false "High Error Spike" alerts.** A structured log line that names its own level is now taken at its word. Caddy writes `{"level":"warn", … "msg":"aborting with incomplete response", … "error":"reading: context canceled"}` when a visitor closes or leaves a page before the response finished; the word "error" in it made each line count as an error, so busy sites got spike alerts for normal traffic. The same rule now applies in DockGate's log viewer. Agent version 1.1.1 — update the agents from Servers → Edge agent.

---

## [2.24.0] - 2026-11-10

### Added
- **Image update history.** Every image update and roll back started from DockGate is stored: when, from where, which image, the version and digest before and after, the result and the full log.
  - It is kept by server and container name (and compose project/service), so it stays after the container is recreated. The last 50 per container are kept.
  - **Containers → Update history** lists them for the server in use; **Log** opens the stored log.
  - The audit log gets `image_update` / `image_rollback` entries with "1.0 → 1.1" and the result.
- **Versions instead of digests.** The newer-image check reads the version from the image config (a `<NAME>_VERSION` variable such as `PG_VERSION`, or the OCI version label) for the local image and for the registry's newer one, so the list says "newer image · 15.8 → 15.19" and the dialog shows the build date. When an image does not say, the digests are shown as before.
- **Roll back.** Before an update DockGate tags the current image `dockgate-rollback/<container>:previous`, so it stays on the server. **Roll back** points the tag at that image again and recreates the container. For a compose service the compose file is not changed: the tag on the server is moved, then `docker compose up -d --no-deps <service>` runs. The next Update pulls the newest image again.
- **Container page: updates.** The Overview shows whether a newer image exists ("15.8 → 15.19", when it was checked) with **Update…**, **Roll back…** after an update, and a failed last update with its reason. The header has **Update…** when there is a newer image. A new **Updates** tab lists this container's updates with **Log** and **Roll back**.
- **Alerts:** "Image update failed or rolled back" (on by default) and "Image updated" (off by default).

### Changed
- **Update checks the new container and puts the old image back when it fails.** After the recreate DockGate watches the new container for 10 seconds (`IMAGE_UPDATE_WATCH_MS`); one with a healthcheck must turn healthy (up to 90 seconds, `IMAGE_UPDATE_HEALTH_MS`). If it stops, keeps restarting or turns unhealthy, the previous image runs again and the update is marked "Failed · previous image restored" with the last log lines. The update runs as a job: the window shows the steps and the log, can be closed and reopened.
- **A standalone container is not removed before its replacement runs.** Update and Recreate rename and stop the old container, start the new one, and remove the old one only then; if the new one can not be created or started, the old one is put back.
- **Container History tab** finds entries by the container name and every ID it had, so the history no longer disappears after an update or recreate. Container actions are now audited with the container name instead of the short ID.
- **A container that runs an older image than its tag** (another container using the same tag was updated, or the image was pulled by hand) shows "newer image pulled · not recreated" with **Update…**. The check compares the image the tag points at, not the first container's image.

### Fixed
- **Update and Recreate copied the old image's settings onto the new image.** `docker inspect` mixes the image's environment, command, labels and ports into the container's settings; copying them pinned old values such as `PG_VERSION=15.8` or an old start command onto the new image. Only settings that differ from the old image are copied now.
- **With Docker's containerd image store** (the default on new Docker installs) the previous image is removed as soon as its tag moves to the newer one. DockGate now tags it before the pull, so a roll back is possible.

---

## [2.23.1] - 2026-11-10

### Added
- **Edge agent jobs reopen.** Closing a job window only closes the window; the job keeps running on DockGate.
  - **Servers → Edge agent → Agent jobs** lists the recent jobs (install, update, apply settings) with their result, and **Open log** brings the window back with the whole log so far.
  - A running job also shows as a banner on that page with **Open log**.
  - While a job runs, the sidebar shows "▶ 1" on Servers and Edge agent, as Deploy does for compose deploys.
  - A job reopened after it ended shows its result without a new notice.

### Fixed
- **An agent job cut off by a DockGate restart** (for example while DockGate itself was updated) stayed "running" for good. DockGate now closes such jobs when it starts, marked as failed with the reason in the log.

---

## [2.23.0] - 2026-11-10

### Added
- **Ready Edge agent images for amd64 and arm64.** CI publishes the agent as one multi-arch image, `ghcr.io/ali7zeynalli/dockgate-agent:<version>-<build>`. On Install or Update the server pulls it, and Docker takes the variant for that server's CPU, so nothing is built or copied. The tag comes from `agent/build-info.js`, which DockGate and CI both use. For servers to pull it without a login, the `dockgate-agent` package on GitHub must be public, as `dockgate` is. When the pull is not possible (no internet, a private package, or CI not finished yet), DockGate falls back to building the agent, as below.

### Fixed
- **Edge agent on a server with another CPU died with "exec format error".** DockGate built the agent for its own CPU (usually x86_64) and copied that image to every server, so on an ARM64 server (Hetzner CAX, Oracle Ampere, AWS Graviton) it could not start. Now, when the published image cannot be pulled:
  - a server with a different CPU builds the agent itself (it needs internet for node:22-alpine and npm);
  - a server with the same CPU still gets a copy from DockGate;
  - a wrong-CPU image left by 2.22.0 or 2.22.1 is removed and replaced on the next Install or Update;
  - the image is always checked against the server's CPU before the agent is started.
- **A new agent that dies right after starting** fails the job with its last log line. The previous agent is put back. Before, the job said "Completed" while the agent was restarting in a loop.

---

## [2.22.1] - 2026-11-10

### Changed
- **Edge agent image** is built through the Docker Engine API, the same way Builds works, instead of the `docker build` command. The build no longer depends on the docker CLI or its buildx plugin inside DockGate's container. A failed build now shows Docker's own error in the job log.

---

## [2.22.0] - 2026-11-10

### Added
- **Edge agent updates reach the servers.**
  - The agent image tag follows the agent's code (`dockgate-agent:<version>-<build>`), so a new DockGate brings a new agent build.
  - DockGate builds the image itself and copies it to each server over SSH. Nothing is pulled from Docker Hub.
  - **Servers → Edge agent** shows each server's agent version and build, marked "Update available" or "Up to date".
  - When servers run an older agent, a banner offers **Update all servers**. After sign-in, a notice says so once per browser session and opens that page.
  - Updating is safe. The new image is on the server before the old agent stops. The old agent is kept until the new one runs, and comes back if the new one does not start. Old agent images are removed afterwards.
  - Changing notification settings still recreates the agents, but keeps the version they run. Only Install and Update change the agent's code.
- **Edge agent 1.1.0** (install it with Update all servers).

### Fixed
- **DockGate never read the Edge agent on remote servers.** The reply over SSH was read the wrong way, so every query failed. Monitoring → Live, All containers, Log Doctor and the summary used Docker directly instead. This works with already installed 1.0.0 agents as well.
- **Agent alerts could be lost:** when Docker sent several events at once (two containers stopping together), all of them were dropped.
- **The agent's "high error spike" Telegram alert never fired.**
- **Container network in the agent** showed the total bytes since the container started, not bytes per second.
- **Container memory in the agent** counted the file cache as used memory on cgroup v2 hosts (Ubuntu 22.04+, Debian 12+). It now matches `docker stats`.
- **Host log lines (auth, syslog, nginx)** keep the time they were written, not the time the agent read them.
- **Kernel (dmesg) errors** are added once. Before, the same 20 lines were added again every 10 seconds.
- **Agent log levels:**
  - a status code counts only where a status stands: a 512-byte response is not an error, and a 404 is a warning;
  - stderr alone is a warning, not an error, because postgres and nginx write normal lines there.
- **The agent restarting a container's log stream** no longer adds the last 30 seconds twice.
- **The agent's query port** listens on 127.0.0.1 only. Other containers on the same Docker network could read its logs.
- **One log line** keeps at most 8 KB, so 10,000 lines stay inside the agent's 96 MB limit.
- **Agent disk usage** is the server's disk, not the agent container's own layer.
- **Servers → Edge agent** stayed on "Loading servers…" when no notification channel was set up.
- **Log Doctor without the agent** split the log text into single characters.

---

## [2.21.0] - 2026-11-09

### Added
- **One log viewer everywhere.** Every log in DockGate now has the same view and tools:
  - search that highlights matches, with regex and match case, and Enter / Shift+Enter to jump between matches;
  - Error / Warn / Info / Debug chips with counts;
  - source and time-range filters;
  - a per-minute bar chart (errors in red) that shows one minute when clicked;
  - a details panel for a line (JSON is pretty-printed);
  - Live / Pause, Wrap, Copy and Download.
- **How many lines to load:** Last 1,000 / 2,000 / 5,000 / 8,000 / 10,000, remembered per place. Only the visible lines are drawn, so 10,000 lines scroll smoothly.
- Each log says how long it is kept, for example "DockGate keeps the newest 10,000 entries" or "The server keeps these logs".
- The viewer is used in:
  - Observe → Logs: Container, All containers, Host logs;
  - Observe → Events, Audit log and Notifications sent;
  - Server Console → Logs;
  - the container page → Logs;
  - Builds → Logs, with build steps as sources;
  - the Setup run log;
  - Fail2ban → Ban history;
  - Services → Recent log;
  - the Edge agent job log.
- **Fail2ban → Ban history** shows fail2ban's own log, with the jail as source and a "Bans only" button.
- **Services → Recent log** reads the service's journal at the chosen length, and only when the section is opened.

### Changed
- **Notification log moved to Observe → Notifications sent.** Old `#/settings?tab=log` links open it. Settings → Notifications has a "See what was sent" button.
- **Host logs** have one implementation: Observe → Logs → Host logs is the same view as Server Console → Logs.
- Limits raised to 10,000:
  - host logs, from 2,000 lines and a 200,000-character cut (now cut by lines, so a long line never hides the newest ones);
  - container logs (live tail);
  - the audit log (kept and listed, from 1,000);
  - the notification log (from 500);
  - Edge agent log queries (from 1,000; an installed agent returns at most 1,000 until it is updated).
- **Settings → Log timestamps** now shows or hides the time column. Time filters work either way.

### Fixed
- **Pages in Resources, Deploy, Observe and Tools were cleaned up right after opening when they loaded instantly.** For example, Events lost its live stream at once. The section wrapper no longer bumps the navigation id that Router had just set.
- **Events:** when Docker sent several events in one chunk (a replayed time range), all of them were dropped. Each line is now read separately.
- **All containers without the Edge agent** read every running container (not only 8) with Docker's real timestamps. Before, it made up times counting back from now, and split the log text into single characters.

---

## [2.20.1] - 2026-11-09

### Changed
- **Dashboard → Host Metrics** follows Monitoring → Live. Its trend starts empty and keeps a rolling 15 minutes of live samples. Before, it mixed up to 120 stored one-minute samples with 5-second live ones on one time axis.
- **Monitoring → server table:** the small CPU and memory graphs say what they show ("last 40 min").

---

## [2.20.0] - 2026-11-09

### Changed
- **Monitoring: Live and Last 48 hours** replace the 1h / 6h / 24h / 7d buttons, on the Monitoring page and in Server Console → Monitoring. Those buttons looked like they worked, but without the Edge agent every one showed the same last 300 stored samples: about 5 hours on a server, about 75 minutes on this machine.
  - **Live** (the default) refreshes every few seconds and shows a rolling 15-minute window. It comes from the Edge agent when one runs, otherwise from DockGate reading the server. Nothing is stored.
  - **Last 48 hours** comes from DockGate's own database: one sample a minute per server, drawn as 5-minute averages, with a thin line for the peak inside each 5 minutes. It works the same with or without the agent and survives reboots. While less than 48 hours is stored, the page says since when.
- **Stored history is kept by time (48 hours), not by row count (2000).** It used to be about 33 hours for a server and about 8 hours for this machine.
- This machine is now sampled once a minute instead of every 15 seconds; Live reads it directly.
- **Servers are sampled every minute even when every server-health alert is off.** Before, no history was collected in that case.
- Opening a server's live view no longer adds a stored sample every few seconds.

### Fixed
- **Server Console → Monitoring → Alerts** showed a nonsense date for an unreachable server (for example "no answer since 11/22/58827"). A time in milliseconds was read as seconds.
- **The Monitoring page's container graph** could not read the Edge agent's format. Without the agent, the container graph now also fills while the page is open.

---

## [2.19.0] - 2026-11-09

### Added
- **Fail2ban → Configuration: apply everything at once.** Changes are drafts until you apply them:
  - **Edit all** opens every card for editing; one card still has its own Edit.
  - Changed rows turn amber and show the old value ("was ~~24h~~"); each card header counts its changes. A new allowlist IP shows as an amber chip; a removed one is struck through and can be kept again.
  - A bar at the bottom collects every pending change: **N fail2ban changes not applied yet · Discard · Review & apply all**. Review lists the changes and shows the change to both files. One job then writes, tests (`fail2ban-client -t`) and reloads once, and puts both files back if anything fails. Current bans are kept.
  - **Save this card** applies only that card; the other cards stay pending.
  - A value that cannot work (for example `maxretry = 0`) turns the field red with the allowed range, marks the card "fix the red field", and disables applying until it is fixed.
  - Pending changes survive leaving the tab or the page and coming back, until applied or discarded. They are stored as "what you changed", so a value changed elsewhere meanwhile is not reverted. Closing the browser tab with pending changes asks first.

---

## [2.18.1] - 2026-11-09

### Changed
- **Fail2ban → Banned IPs** is a collapsible card, like the rest of the tab. The header shows how many IPs are banned and holds **Ban an IP**. The card opens by default when something is banned, and the open/closed choice is remembered in the browser. The list shows 25 IPs per page, and the search (IP or jail) covers every banned IP, not just the visible page. Unban and Unban & allow work on every page.
- **Ban history** also shows 25 events per page, newest first.
- New `UI.pager` (shared pager: "26–50 of 340 · ‹ Prev · Page 2 of 14 · Next ›").
- A fail2ban warning still pointed to the old Jails table; it now points to Configuration → Settings.

---

## [2.18.0] - 2026-11-09

### Changed
- **Fail2ban → Configuration** replaces the Jails table, the Allowlist table, "View files" and the "Advanced: edit jail.local" box. The Advanced box showed an empty editor when `jail.local` did not exist, which is the usual case: DockGate keeps its settings in `jail.d/dockgate.conf`. The new section has two tabs:
  - **Settings:** cards in a fixed order (Allowlist → SSH jail → Repeat offenders → History & log → Other options). Each card has a one-line summary, for example "3 failures within 1d · bans 1d → 4d → 8d → 16d → 30d · aggressive mode · port 22". Opened, every setting shows DockGate's value, **what fail2ban really runs** (in red when different) and **which file sets it** (DockGate, `jail.local`, a distro file or the default). Each card edits in place with a live "what one IP gets" preview, and Save shows the lines that change before it applies.
  - **Files:** every fail2ban file under `jail.d` and `fail2ban.d`, plus `jail.local` and `fail2ban.local`, each with what it is. It has an editor with line numbers. DockGate's files and yours can be edited; files shipped with fail2ban are read-only. Save shows the change, then backup → `fail2ban-client -t` → reload, and the file is put back if the test fails.
- **Other options:** fail2ban options DockGate has no field for (`bantime.rndtime`, `usedns`, `ignorecommand` …) are kept exactly as written. Add or remove them in the Other options card, or by hand in Files. Until now, saving the form rewrote DockGate's file and dropped them. **Move to DockGate** carries such options over instead of removing them.
- DockGate's own file accepts `[DEFAULT]`, `[sshd]` and `[recidive]` only. Other jails belong in `jail.local`, and the editor says so. Its values are checked like the form's. `logtarget` must stay `/var/log/fail2ban.log`, because recidive reads that file.

Checked against a real fail2ban 1.0.2:
- the file list and roles;
- refused saves: a foreign section, an invalid value, a distro file, a path outside `/etc/fail2ban`;
- a broken `jail.local`: rejected by `fail2ban-client -t` and put back;
- Move to DockGate carrying `bantime.rndtime` over;
- a hand edit of DockGate's file read back into the form;
- a later form save keeping the hand-written options.

---

## [2.17.0] - 2026-11-09

### Added
- **Fail2ban → Move to DockGate.** When `jail.local` (or `jail.d/*.local`, a later `jail.d/*.conf`, `fail2ban.local`) overrides what DockGate manages, one button moves those settings into DockGate's files:
  - values DockGate manages are carried over: sshd failures, window, ban, increment, mode; recidive; allowlist IPs; history kept;
  - a recidive that could never trigger is corrected (for example 5 bans within 1d → 3 within 30d), with the reason;
  - DockGate's own address is added to the allowlist;
  - lines DockGate writes itself (port, backend, logpath, filter, banaction) are removed with a note;
  - other jails and other `[DEFAULT]` options stay as they are.
  The dialog shows every list and every file before → after. One job backs up each file (`*.dockgate-backup`), rewrites it, tests with `fail2ban-client -t`, reloads, and puts everything back if the test or the reload fails. Current bans are kept.
- **Fail2ban: longer recidive bans for repeat offenders** (recidive → Edit, off by default): factor and longest ban, with the resulting sequence (for example 7d → 28d → 56d → 90d). DockGate's file now always writes recidive's `bantime.increment`, so a `bantime.*` line under `[DEFAULT]` elsewhere cannot change recidive.
- **Setup puts DockGate's own address in the fail2ban allowlist**, so fail2ban never bans the connection that manages the server.

### Fixed
- **Fail2ban checks use the values fail2ban runs with**, not only DockGate's file. "recidive can never trigger" is now also found when the values come from `jail.local`.
- **Allowlist not in effect**: a `[DEFAULT] ignoreip` in `jail.local` replaces DockGate's allowlist, so IPs added in DockGate could still be banned. This is now reported with the file that causes it.
- **DockGate's address missing from the allowlist** is reported, with an **Add DockGate's IP** button.
- **`fail2ban.local` overriding History kept or the log target** (recidive needs `/var/log/fail2ban.log`) is reported.

Checked against a real fail2ban 1.0.2 with the jail.local sent in chat. Before: 4 problems, each with its cause. After Move to DockGate: no problems, the allowlist in effect, recidive 3 bans / 30d, and recidive banned an IP after three sshd bans. The rest of jail.local was left in place and the backup matches the original.

---

## [2.16.1] - 2026-11-09

### Fixed
- **Fail2ban: "recidive is not reading /var/log/fail2ban.log" now names the real cause.** The warning always said "Save the settings to fix it", but Save cannot help when another file wins. DockGate now reads which files set `[sshd]` / `[recidive]` options and says which of three cases it is:
  - a file read after DockGate's (`jail.local`, `jail.d/*.local`, or a later `jail.d/*.conf`) sets `backend` or `logpath`. The warning names the file and the line, and offers **Edit jail.local** instead of Fix now;
  - DockGate's file does not set `backend = auto` and `logpath = /var/log/fail2ban.log` yet. Fix now writes them, tests and reloads;
  - DockGate's file is right but fail2ban was not reloaded. Fix now reloads it.
  On Ubuntu and Debian, `jail.d/defaults-debian.conf` sets `backend = systemd` for every jail, so a recidive jail without its own `backend` line reads the journal. fail2ban never writes its ban lines there.
- **Fail2ban: recidive on in DockGate's settings but not running** is reported, with the file that switches it off or breaks it, or the reload it needs.
- **Fail2ban: running values that differ from DockGate's file** (maxretry, findtime, bantime of sshd and recidive) are reported with the file that sets them. Until now the Jails table could show DockGate's values while fail2ban ran others.
- The "jail.local also sets options" note names every file that does.

Checked against a real fail2ban 1.0.2 (the Ubuntu 24.04 version): the overriding `jail.local`, the missing lines, the missing reload and the jail that cannot start each give the matching message. After Fix now, recidive reads `/var/log/fail2ban.log` and banned an IP after three sshd bans.

---

## [2.16.0] - 2026-11-09

### Changed
- **Server Console → Setup**: the components table says what each run does. A new **This run** column shows *Will install*, *Will retry*, *Will run*, *Skip · installed* or *Not selected*, and the line under the presets names the components that will run. The ticks stay clickable with a preset chosen: changing one turns the preset into your own list (Custom). Text in the table wraps instead of being cut off.
- **Setup rows open** to show what the component does to the server: the packages it installs, the files it writes, the values it sets (for example `MaxAuthTries 3` for SSH hardening) and the page where it is changed later.
- **Fail2ban → Jails → Edit** shows the file Save will write: **What changes** (the changed lines against the file on the server, updated as you type), **Full file** (with the jail's lines marked) and **On the server now**. The preview is built by the same code that writes the file. Saving still tests the configuration and puts the previous files back if the test fails.
- **Fail2ban → View files**: a read-only view of DockGate's `jail.d/dockgate.conf` and `fail2ban.d/dockgate.conf` as they are on the server.

---

## [2.15.2] - 2026-11-09

### Changed
- **Dashboard**: the server cards show 🔒 next to a server that has an access password, the same as the header picker and Servers.

---

## [2.15.1] - 2026-11-08

### Removed
- **DockGate backup** (Settings → System → Backup, nightly copies, restore) from 2.14.0 is taken out until a better design is chosen: it copied only some files of the data folder (database, master key, SSH keys and, optionally, compose folders without `.git`), so a restore could miss Git deploy keys, `.git` folders or stack metadata. Copies already written to `data/backups/` are left in place; nothing else in the data folder is changed.
- Volume backups (Resources → Volumes and the volume backup task in Tools → Schedules) are not affected.

---

## [2.15.0] - 2026-11-08

### Schedules
- **Tools → Schedules**: tasks DockGate runs by itself on a chosen server — **prune** (build cache, unused images, stopped containers, unused networks; never volumes), **volume backup** (tar.gz into a folder on that server, default `/var/backups/dockgate`, newest N kept) and **Git sync** (DockGate-managed Git stacks are redeployed only when the branch has a new commit, checked with `git ls-remote`).
- Every day, every week or every hour, in the timezone from Settings → General (correct across daylight-saving changes). Each row shows the last result and the next run; an On switch saves at once; **Run now**; Edit and Delete in ⋯.
- New alert rule **Scheduled task failed** (on by default).

### Files on the local machine
- Tools → Files now works on **Local** for folders you share with DockGate under `/host` (for example `- /srv:/host/srv` under the DockGate service's volumes; `FILES_ROOT` changes the root). Every path is resolved with realpath and must stay inside, so `..` and symlinks cannot lead out; the shared folders themselves cannot be deleted. With nothing shared, the page shows how to share a folder. DockGate never opens the whole machine because it runs as root in its container.

### Logs, Events, Dashboard
- **Logs**: a time range next to Tail — last 15 min, 1 hour, 24 hours, 7 days, or from–to. With an end time the logs are shown without following.
- **Events**: keep 100 / 500 / 2000 on the page and **Export CSV** (respects the type filter).
- **Dashboard** shows the host metrics block for the local machine too (it was remote-only).

---

## [2.14.0] - 2026-11-08

### DockGate backup
- **Settings → System → Backup**: download everything DockGate knows (servers and logins, SSH keys, registry logins, notification channels and rules, IP lists, firewall descriptions, audit log, settings and, optionally, the compose folders it manages) as one file encrypted with your password (AES-256-GCM, key from scrypt).
- **Nightly copies** around 03:00 in the data folder; the newest 7 are kept and can be downloaded (encrypted) or restored.
- **Restore** (danger zone): the file is checked first (password, contents), then staged and applied when DockGate starts, before the database opens. The current data is moved to `backups/pre-restore-…` so it can be put back by hand. DockGate restarts by itself when Docker restarts it; otherwise restart the container to finish.

### Newer images
- Each container's tag is compared with its registry (by digest, HEAD requests — Docker Hub does not count them) once a day and with **Check for updates** on Resources → Containers. Containers with a newer image show it and get **Update…**: pull and recreate with the same settings, or only that service in a stack. Stored registry logins are used for private images.
- New opt-in rule **Newer image available** (off by default), announced once per new digest.

### Deploy history
- Every deploy of a stack (folder, Git, sync, Up, Rebuild, editor, image update) keeps the compose files and `.env` it used; the last 20 per stack and server. **Deploy history…** in a stack's ⋯ menu shows them, **Changes** compares a deploy with the one before, **Redeploy this…** puts its files back and runs `up -d` (volumes untouched). If that fails, the files in use before are put back.

### Webhook channel
- A third channel next to email and Telegram: one URL, body shaped for **Slack, Discord, Microsoft Teams, ntfy** or **JSON** (`event, server, title, text, time`). The URL is stored encrypted; every alert of every enabled rule goes there too; Send test and the notification log include it.

---

## [2.13.0] - 2026-11-08

### Server health alerts
- **Server not reachable** after a server has not answered for 3 minutes (once per outage), and **Server is reachable again** with how long it was down.
- **Disk almost full** (any disk above 85%), **Memory high** (above 90% for 5 min) and **CPU high** (above 90% for 10 min, off by default).
- DockGate checks every server once a minute over its existing SSH login (the local machine directly). Remote samples are stored, so Monitoring history keeps filling while nobody has the page open.
- **Per-server limits**: Server Console → Monitoring → Alerts — keep the shared limit, set this server's own, or turn the rule off here.
- Telegram and email messages say what happened, since when, and what the server looked like last; times follow the timezone in Settings.

### Notification rules
- Rules are split into **Server** and **Docker**; a switch saves at once, limits and the quiet period are edited in a dialog (the "Save Rules" button is gone).
- "Disk usage exceeds threshold" is now **Docker uses a lot of disk space**: it always measured Docker's own disk use in GB, not how full the disk is. Its limit (was a fixed 50 GB) can be changed and is passed to the edge agent.

### Search
- **Ctrl/Cmd+K** (or the search box in the header, an icon on phones) opens one search window for containers, images, volumes, networks and stacks on the server in use, every server, every page and common actions (Run container, Deploy stack, Pull image, Prune, Add server, quick terminal).

### Fixed
- **Default shell** now preselects the shell in Tools → Terminal and the quick terminal.
- **Container list** (Table / Cards) now sets how Resources → Containers opens.
- **Log timestamps** now also applies to Observe → Logs.
- Settings load before the first page draws, so these apply right after a refresh too.
- Removed six setting keys nothing used (log tail lines, auto-scroll, wrap lines, terminal font size, date format, confirm destructive); the API now rejects them.

---

## [2.12.1] - 2026-11-08

### Fixed
- **Open** in Servers (and every other way into a server console: Dashboard cards, Monitoring, links) now makes that server the active one, so the server picker in the header always names the server on screen. A server with an access password asks for it first; cancelling keeps the console closed. Before, the console opened while the header still showed the previous server, and a server's access password could be skipped by opening its console.
- Switching servers in the header while a console is open now opens the new server's console on the same tab (or the Servers list for the local machine). Before, the page stayed on the old server.

---

## [2.12.0] - 2026-11-08

The rest of DockGate now follows the same layout as the server pages: a breadcrumb in the top bar, one header per page with its main action, standard tables with a ⋯ menu for rare and destructive actions, and settings that save as you change them. No function was removed; old links still work.

### Navigation
- **Activity is split**: **Observe** (Logs, Events, Audit log) and **Tools** (Terminal, Files).
- **Moved**: Cleanup → **Resources → Prune**, Registries → **Deploy → Registries**, Edge agent → **Servers → Edge agent** (Notifications links to it).
- The top bar shows where you are (`Resources / Containers`). Section pages are picked in the sidebar only, so the second tab bar on the page is gone.
- Old links and bookmarks (`#/activity?tab=logs`, `#/infra?tab=registries`, `#/containers`, `#/cleanup` …) open the new place.

### Docker pages
- **Containers**: filter chips with counts (adds **Unhealthy**), bulk start / stop / restart / remove, Logs or Start on the row and the rest in ⋯ (details, terminal, restart, stop, remove).
- **Images**: **Used by** column (container names), In use / Unused / Dangling chips, **Remove unused** with the space it frees.
- **Volumes** and **Networks**: **Used by** columns, an Unused filter for volumes, Docker's own networks marked.
- **Builds**: History · Cache · Builders as one switch in the header instead of a second tab bar.
- **Prune**: one table — what each kind of unused data is, what exactly would be removed and how much space it frees; pick rows and prune them together. Volumes are never pre-selected. Full system prune is in a danger zone.
- **Compose stacks**: source (git, folder, adopted, external) and state per stack; **Deploy stack** asks where the stack comes from (compose file, Git, folder, existing on the server, template) and opens that flow. Up / Restart / Sync on the row, everything else in ⋯.
- **App templates**: the whole card opens the details (ports, environment, volumes) with Deploy there; the most common categories as chips.
- **Logs**: one switch for Container · All containers · Host logs · Log Doctor.
- **Events**: filter by type (containers, images, networks, volumes); errors shown above the table.
- **Audit log**: click a row for its details; **Clear** moved into ⋯ and still asks to confirm.
- Registries, Terminal and Files use the same header.

### Settings and Monitoring
- **Settings → General**: each option saves when you change it and confirms with a toast; the page-wide **Save Settings** button is gone. "Auto-Start Service" is now **Start with Docker**, with what it does.
- **Settings → Security**: change the password in a dialog; **Sign out everywhere** in a danger zone.
- **Monitoring** starts with **every server** in one table (state, CPU and memory sparklines, disk), then the live metrics of the server in use. `GET /api/servers/overview?history=N` returns the samples for it and now includes this machine.
- **Dashboard** shows a card per server (state, CPU · memory · disk, setup) when there is more than one.

---

## [2.11.0] - 2026-11-07

Every server page now follows the layout cloud panels use (Hetzner, DigitalOcean, GCP, AWS, Cockpit): a header with one line and the main action, standard tables with row actions, settings rows with their own Edit, and one dialog style. All earlier functions are kept.

### Firewall
- **Inbound and Outbound rule tables** (Hetzner / GCP): Description · Sources/Destinations · Protocol · Port · Action, each rule edited on its own. Sources show as **Any IPv4 / Any IPv6**, IP lists and addresses; one rule is all its UFW entries (v4 and v6) together.
- **Outbound rules** (UFW): allow or deny traffic leaving the server, optionally also for Docker containers (needs Docker port isolation). Outbound route rules are marked so they are never mistaken for container port rules.
- **Port ranges** (`8000-8100`), **any port**, **TCP / UDP / any**, and a **description** per rule (stored by DockGate).
- **Default policies** shown as the last row of each table (as in Azure NSGs) and changeable; blocking incoming traffic is refused unless a rule keeps SSH reachable for DockGate.
- Rule changes run only the difference; changes touching the SSH port run as a lifeline job with rollback. Entries that do not fit the table (app profiles, interface or source-port rules, firewalld services) are listed under **Advanced** with the reason and can be deleted there.
- IP lists shown as a table (like AWS prefix lists).

### Servers
- **Servers list** like DigitalOcean / Hetzner: name, in use, address, login (root / password flagged), setup state, CPU · RAM · disk.
- **Add server** is a 4-step wizard: connection → login → **verify** (shows the server's host key fingerprint to compare) → details. The confirmed host key is pinned when the server is added.
- **Server Console → Settings**: name, description, connection, login (tested before saving), connection test, Docker access, host key (re-trust), access password, alerts, and a **Danger zone** to remove the server. Replaces the old Edit-server modal.
- **Server Console → Monitoring**: CPU, memory, disk and network graphs with a time range, the live view (processes, disks, open ports) and the alerts that apply to this server (mute per server).

### Server Console
- **Overview**: setup and Docker summary, then **Security recommendations** sorted by importance, each linking to the fix.
- **Setup**: a components table (installed / missing / failed with the error / not available, last run), presets, a run plan before anything starts, step-by-step progress, and **run history** with each run's log.
- **Access & SSH**: one settings row per option (root login, password login, port, attempts, login time, dead/idle timeouts, X11, host key), each with its own dialog.
- **Users & keys**: users table plus an **SSH keys** table across all users (download keys DockGate generated, remove with confirmation, add a key for any user).
- **Fail2ban**: Banned IPs, Allowlist and Jails tables (each jail edited in its own dialog with the ban-length preview); history folded away.
- **Services**: one table (state, start at boot, start/stop/restart) — select a service for its settings, config file and log.
- **Logs**: level filter (warnings / errors) and search.

### Other
- **SSH keys** page: table with the Git projects each key is used by; deleting names them.
- **Edge agent**: fleet table.

### Fixed
- The servers list never sent `notifications_enabled`, so muted servers showed as unmuted and the edit dialog always showed alerts on.
- Removed an unused copy of the old server management code from the Settings page.
- Kept from the old screens after a line-by-line check: Start for services whose state cannot be read (no systemd), the 30-second refresh of Docker counts on the Overview, and the agent status pill in "Install on servers…" (it would have stopped that dialog from opening).
- The sidebar lists the new console tabs (Monitoring, Users & keys, Settings).
- **Phones and narrow windows**: the sidebar was always open (260 px) and left about 70 px for the page. Below 900 px it is now a drawer opened with ☰ that closes after navigating, on Esc or when the page behind it is tapped; the header is compact.
- **Errors explained**: 14 places showed only "Error · connect ENOENT /var/run/docker.sock". They now say what happened in plain words (Docker not reachable, login refused, server not answering, host key changed), why, and offer the next step (Retry, Switch server, Open Setup, Open server Settings), with the technical message under Details.
- **Release notes** in Settings → Software Update showed `**bold**` markers literally; bold, code, italics and links are now rendered (escaped first).
- The Files page pointed to "Settings → Servers", which no longer exists; it now points to Servers.
- "Servers" no longer appears three times on the Servers page; the header says "Monitoring" instead of a title that wrapped onto two lines.

### Not tested on a live server
- Outbound rules, default-policy changes and the new rule editing were checked with route tests and `ufw --dry-run` against UFW 0.36 only.

---

## [2.10.0] - 2026-11-07

### Added
- **Who can reach each port.** The Firewall tab's port table now shows the sources of every port in one row: *Anyone (internet)*, IP lists, single addresses and ranges, IPv4 and IPv6 together, with an *IPv4 + IPv6 / IPv4 only / IPv6 only* label. UFW's separate "(v6)" rules are merged into that one row.
- **Edit sources.** *Edit* (or *Allow…*) opens one dialog: choose *Anyone* or *Only these sources*, paste many addresses at once (one per line, spaces or commas; IPv4 and IPv6 mixed), add lists with one click. Before anything runs it shows the exact change: rules added, removed, unchanged, and the commands. Only the difference is applied: new sources are added first, removed ones deleted after, so a source that stays is never interrupted. Addresses are normalised (`10.0.0.5/24` → `10.0.0.0/24`, compact IPv6).
- **Add port rule** for a port nothing listens on yet.
- **IP lists:** Cloudflare (15 IPv4 + 7 IPv6), GitHub webhooks and UptimeRobot as official lists, plus your own named lists (*Office*, *VPN*…). Official lists are fetched only when you press *Check for updates*; the difference is shown and saved only after you confirm. Ports that still hold the older version show *an older version is applied here* with an *update* link. Pasting exactly a list's ranges offers to use the list instead.
- **DockGate's IP** as a source (the address the server sees DockGate connect from).
- UFW rules carry a comment naming their list (`dockgate:cloudflare`, `dockgate:manual`).
- Works with firewalld too: one rich rule per source, a plain port for *Anyone*.

### Safety
- The SSH port can be restricted only if DockGate's own IP (or a range containing it) stays allowed. The change runs as a lifeline job: rules backed up, rollback armed, a new SSH login tested, restored automatically on failure.
- When UFW has IPv6 switched off (`IPV6=no`), IPv6 sources are refused with an explanation instead of half-applying a list.
- Ports opened by a range, an app profile or a firewalld service are not edited as sources; the dialog explains which rule to delete first.

### Changed
- The full rule list moved under *All UFW rules (n)* (collapsed when long). Specific IPv6 rules can be deleted there individually.

### Not tested on a live server
- Fetching the official lists could not be tried from the development environment (outbound access blocked); it is covered by tests with a stubbed download. The UptimeRobot address list URL is the one UptimeRobot documents; if it moves, *Check for updates* shows the error and nothing changes.

---

## [2.9.0] - 2026-11-07

### Added
- **Firewall tab works with firewalld** (RHEL family). The listening-ports table, *Open to internet*, *Allow one IP…*, *Close*, *Add rule* (allow/deny, from any or one IP/range) and *Delete* now manage firewalld's default zone: plain ports, services (resolved to their ports) and rich rules. Changes are written permanently and applied with `firewall-cmd --reload`. The rule that keeps SSH reachable cannot be deleted. Container ports published by Docker skip firewalld and are shown as such; Docker port isolation stays UFW-only.
- **Auto updates on RHEL family:** a form for dnf-automatic — on/off (timer + `apply_updates`), all updates or security only, reboot when needed. The previous config is backed up and restored if a step fails.
- **Docker port isolation covers IPv6.** When UFW manages IPv6 (`/etc/ufw/after6.rules` exists), the same DOCKER-USER rules are written for ip6tables; both files are backed up and restored together by the automatic rollback.

### Fixed
- **Services on hosts without systemd** (some containers, WSL, sysvinit) showed every service as *inactive*. The state now comes from a process check (sshd, chronyd, dockerd, fail2ban, UFW/firewalld status); start/stop/restart use `service`; boot enable/disable is shown as not available; a service with no way to check shows *state unknown*. Saving a config no longer rolls back just because the state cannot be checked.
- A port opened by a range (`9000:9010/tcp`) is now shown as open; *Close* on such a port explains which rule to delete instead of silently doing nothing.
- **SSH keys follow `DATA_DIR`.** They were always stored under `<app>/data/ssh-keys` even when `DATA_DIR` pointed elsewhere. Keys stored there by older versions are still found.

### Changed
- Compose routes split into `compose.js`, `compose-shared.js` and `compose-files.js`; the Firewall tab moved to `firewall-panel.js`. No behaviour change.
- New route integration tests (firewall UFW + firewalld, confirm gates, auto updates, compose Files API). 144 tests.

### Not tested on a live server
- firewalld changes, IPv6 isolation and the dnf-automatic form were tested with unit/route tests and command checks only (the config edits were run against sample files); please try them on a test server first.

---

## [2.8.0] - 2026-11-07

### Security
- **Dependencies:** all 10 known vulnerabilities fixed (`npm audit`: 0) — express 4.22.3, body-parser, qs, socket.io / engine.io / ws, proxy-addr, and **nodemailer 10.3.1** (major upgrade; the mail API DockGate uses is unchanged).
- **Client IP can no longer be spoofed.** `trust proxy` was on for every hop, so any client could send `X-Forwarded-For` to dodge the login rate limit and fake the audit IP (the WebSocket audit read the header unconditionally too). Now nobody is trusted by default; set `TRUST_PROXY` (e.g. `loopback`) when DockGate sits behind a reverse proxy. HTTP and WebSocket use the same rule.
- **First-run setup is protected.** Until an admin password exists, setting it from outside the local network needs a one-time setup token that DockGate prints in its log (`docker logs …`). From the same machine or a private network nothing changes. `DG_SETUP_TOKEN` sets your own token and makes it always required.
- **Sessions can be revoked.** Changing the password signs out every other browser/device (this one stays logged in). New **Settings → Security → Sign out everywhere** ends all sessions.
- **Node.js 22 LTS** in the image and CI (Node 18 no longer receives security fixes). `engines` now `>=20` (nodemailer 10 needs it).

### Upgrade notes
- Behind a reverse proxy, add `TRUST_PROXY=loopback` (proxy on the same host) or the proxy's address — otherwise audit entries show the proxy's IP and all clients share one login rate-limit bucket.

---

## [2.7.0] - 2026-11-07

### Added
- **Overview → Security status** shows fail2ban: not installed, installed but stopped, settings that cannot work, or running with the number of banned IPs — with a link to the place that fixes it.
- **Services → Time sync:** choose chrony's NTP sources (pool or server; host names and IPs validated) or go back to the distro's own. The distro's lines are kept (commented) and restored exactly; the change is validated with `chronyd -p` and restored if chrony fails to restart.
- **Firewall → Turn the firewall on/off.** Switching UFW on allows the SSH port(s) — and 80/443 if kept — first, arms a server-side rollback, tests a new SSH login, and switches UFW off again by itself on failure. Refused on firewalld servers.
- **Deploy user offer:** adding a server that DockGate reaches as root or with a password offers the deploy-user wizard straight away.
- **Setup → Deploy user name** can be chosen (default `deploy`).

### Changed
- Every risky action (reboot, lock/unlock user, open/close port, delete rule, reload/switch off the firewall, ban, unban + whitelist, Docker settings, NTP defaults, raw config save, stopping a service) now uses the same confirm dialog: what changes · what protects you · how to undo.

### Fixed
- In Server Console, confirm dialogs named the header's active server (often "Local") instead of the server being changed. They now name the console's server.

---

## [2.6.0] - 2026-11-07

### Added
- **Fail2ban tab** (Server Console): banned IPs with ban and expiry times, unban, unban + whitelist, manual ban; whitelist (`ignoreip`) with a one-click "DockGate's IP"; settings form (failures, counting window, first ban, longer bans for repeat offenders, growth factor, longest ban, history kept, detection mode, recidive) with a live preview of the ban lengths fail2ban really uses (`bantime × 2^n × factor`, capped); ban history from `/var/log/fail2ban.log`; `jail.local` as an advanced editor.
- **Fail2ban problem detection:** a recidive jail that can never trigger (its window shorter than the time N sshd bans take), recidive reading the journal instead of fail2ban's log file, the sshd jail watching another port than SSH, a ban memory shorter than a week (`dbpurgeage`), DockGate's own IP being banned, `jail.local` overriding DockGate's values. Problems that settings can fix have a *Fix now* button.
- **Services sub-pages:** Docker (log size limit, files kept, live-restore; engine details and disk usage), Time sync (sync state, offset, NTP sources), Auto updates (on/off, automatic reboot and its time, pending updates, next/last run). Each with service state and actions, a guarded raw-config editor and the recent log.
- **Firewall:** UFW service state and *Reload rules*; after every firewall change DockGate compares fail2ban's bans and the running containers before and after, and warns if a change dropped either.
- **Access & SSH:** login grace time, a real **idle session timeout** (`ChannelTimeout` / `UnusedConnectionTimeout`, OpenSSH 9.2+), sshd service state, and the drop-in as an advanced editor.

### Changed
- Settings written by DockGate for fail2ban: the admin's values are kept as defaults (3 failures in 1 day → 24 h ban, ×2 growth up to 30 days); **recidive now works** (reads `/var/log/fail2ban.log`, 3 bans in 30 days → blocked on all ports for 1 week); ban history kept 30 days (`dbpurgeage`, in `fail2ban.d/dockgate.conf`); the sshd jail always targets the port SSH really listens on. Setup → Fail2ban writes the same configuration.
- Fail2ban changes **reload** instead of restart, so current bans are kept.
- An SSH port change now also moves fail2ban's sshd jail to the new port.
- All SSH settings live in **one** file, `/etc/ssh/sshd_config.d/10-dockgate-access.conf`. The old `99-dockgate.conf` (Setup → SSH hardening) is merged into it and removed; Setup now adds only values that are not set yet.
- UFW, SSH hardening and fail2ban moved out of Services into their own tabs (no more two places editing the same thing).

### Fixed
- Access & SSH "Idle timeout" was really `ClientAliveInterval`, which drops dead connections but never logs out an idle session. It is now labelled *Dead connection timeout*; the real idle limit is a separate field.
- Generated ed25519 keys: ssh2's generator occasionally (~1 in 200) emits a truncated public key that can never log in. DockGate now verifies each generated pair and rejects truncated public keys anywhere.
- Fail2ban refused to start when recidive was enabled and its log file did not exist — the file is now created first.

### Removed
- `public/js/service-manager.js` (replaced by the Access & SSH, Firewall, Fail2ban and Services pages).

---

## [2.5.1] - 2026-11-07

### Added
- **Automatic GitHub Releases:** when a push to `main` changes the version in `package.json`, the publish workflow now also creates the matching GitHub Release (`v<version>` tag on that commit), with that version's CHANGELOG section as the notes and the Docker image tag. Nothing happens if the release already exists.
- **Manual release workflow** (*Actions → Create GitHub Release (manual) → Run workflow*): creates the release for an older version from its CHANGELOG section at a chosen commit — for versions published before the automatic step existed.

---

## [2.5.0] - 2026-11-07

### Added
- **Deploy user** (Server Console → Overview → *Create deploy user*, and the *Deploy user* item in Setup): creates a non-root user with passwordless sudo (`/etc/sudoers.d/90-dockgate-<user>`, checked with `visudo`) and Docker group membership, generates an ed25519 key pair (optionally also installs your own public key), proves the key login works with a **new** SSH connection, and only then switches DockGate's connection to that user. Password login is not touched here.
- **Access & SSH** tab: root SSH login (allowed / key only / blocked), password login, SSH port and hardening (MaxAuthTries, idle timeout, X11), written to DockGate's own `/etc/ssh/sshd_config.d/10-dockgate-access.conf` (loaded before cloud/distro drop-ins, so its values win). Each change runs as a **lifeline job**: `sshd -t` → automatic 120 s rollback armed on the server (systemd-run, or a detached loop without systemd) → reload → a NEW SSH login is tested → keep, or restore immediately. A port change opens the new port in UFW / firewalld (and SELinux) first and closes the old one only after the test. Restricting root or password login is refused until DockGate connects as a non-root user with a key.
- **Users** tab: list human accounts with sudo / docker / keys / password-login / locked state; add, lock / unlock (account expiry, blocks key logins too), delete (optionally with home), change sudo and docker membership, add / remove SSH keys (paste or generate) and download a DockGate-generated private key after re-entering the admin password. Server-side guards: DockGate's own user and key cannot be locked, deleted or removed; the last sudo user keeps sudo; the last key cannot be removed while password login is off.
- **Firewall** tab: every listening port with where it is reachable from (public / one IP / internal only / this server only / bypasses UFW); **Docker port isolation** (DOCKER-USER rules in `/etc/ufw/after.rules`) so published container ports stop bypassing UFW, asking which ports stay public (80/443 pre-selected); open a port to everyone or one IP, close it, add / delete UFW rules (with their IPv6 twin). The SSH port can never be closed or denied here.
- **Security status** card on the Server Console Overview (deploy user, password login, root login, firewall, Docker ports, host key) with links to the fix, plus a **Reboot required** notice and a Reboot button.
- **SSH host key pinning** (trust on first use) for every connection to a managed server — panel, pooled SFTP, terminal, Docker client, event monitor, all forked workers, and the Docker CLI (`known_hosts` + `StrictHostKeyChecking=yes`). A different key is refused with a clear message; *Re-trust* in Access & SSH after a rebuild. Changing a server's host clears its pin.
- **Docker log limits** provisioning item: json-file logs capped at 10 MB × 3 and `live-restore` (skipped in swarm mode), merged into an existing `daemon.json` (backup kept).
- Provisioning **Cancel** (stops before the next item) and **reboot-required** detection.

### Fixed
- **Security:** `GET /api/meta/settings` returned the session signing secret and the admin password hash + salt to the browser. They are now never returned.
- Provisioning on a root login without `sudo` installed (minimal Debian images) failed every step — commands now drop `sudo` as root and use `sudo -n` otherwise, with a clear pre-flight error when passwordless sudo is missing.
- Provisioning on a fresh cloud VPS failed on the dpkg lock held by cloud-init / unattended-upgrades — the run now waits for cloud-init and apt waits up to 5 minutes for the lock.
- `apt-get upgrade` could stop at the "keep or replace this config file?" prompt — locally modified files are kept (`--force-confdef --force-confold`).
- Two provisioning runs on the same server could start in parallel — a second run is refused (409).
- RHEL / firewalld only opened the `ssh` service (port 22) before enabling the firewall — a server on another SSH port was locked out. The current SSH port is opened first.
- Fail2ban overwrote `/etc/fail2ban/jail.local`; it now writes `/etc/fail2ban/jail.d/dockgate.conf` and counts as installed only when the service is active.
- Fail2ban on RHEL (EPEL via the upstream RPM when `epel-release` is unavailable) and Docker on Amazon Linux (distro package + compose plugin).
- Swap: sized to RAM (2 GB under 2 GB RAM, otherwise RAM up to 4 GB), refuses when the disk lacks room, and removes a leftover `/swapfile` first.
- Services tab commands on a root login without `sudo` installed.
- `package-lock.json` root package version was stale (2.3.1).

---

## [2.4.5] - 2026-08-28

### Added
- **Global Quick Terminal (Floating & Minimizable Modal)**:
  - Added a global Terminal launcher button (`>_ Terminal [Ctrl+\`]`) directly in the header navigation bar.
  - Global hotkeys: press `Ctrl+\`` (or `Alt+T`) anywhere in the application to toggle the Quick Terminal without leaving your active workflow.
  - **Side-by-Side Split View (Dual Terminals)**:
    - Added `[ ◫ Split ]` button in the terminal titlebar to open a second independent terminal pane side-by-side.
    - Run any combination concurrently: Container 1 on Left + Container 2 on Right, or Container + Host SSH shell, or dual Host shells.
    - Slot-aware backend streaming (`terminal:*` and `hostterm:*` channels) prevents stream collisions across split panes.
  - **Window Controls (Minimize / Maximize / Restore / Close)**:
    - **Minimize (`_`)**: Collapses the terminal into a sleek, floating status pill at the bottom-right of the screen.
    - **Cross-Page Session Continuity**: Terminal sessions remain connected and active in the background even when navigating between different sections (Dashboard, Containers, Compose, Files, Settings, etc.).
    - **Restore / Maximize (`□` / `⤢`)**: Click the floating pill or use the header button to restore or maximize the window to full size.
  - **Dual Mode Support**:
    - 🐳 **Container Exec**: Live dropdown of running containers with instant shell execution (`/bin/sh`, `/bin/bash`, `/bin/zsh`), buffer clearing, and reconnect.
    - 💻 **System (Host) Shell**: Direct interactive SSH shell into the active server (local container or remote host).

---

## [2.4.3] - 2026-08-28

### Added
- **Bulk Delete Compose Projects**: Added the ability to select multiple compose projects using checkboxes in the UI and delete them all at once. The bulk delete modal safely confirms the action by requiring the user to type `DELETE` and displays live progress for each project being removed.

---

## [2.4.2] - 2026-08-28

### Changed
- **Pull All UI Enhancement**: "Pull All" now displays a detailed summary modal for each project, showing the number of changed files and up to 50 commits, identical to the single-project git pull output.

### Fixed
- **SSH Key Path Quoting**: Fixed an issue where `git pull` from the terminal would fail if the absolute path to the deploy key contained spaces. The path is now strictly quoted in `.git/config` (`core.sshCommand`), and Windows backslashes are converted to forward slashes to ensure Git parses it safely on all environments.

---

## [2.4.0] - 2026-08-28

### Fixed — Persistent SSH Key Config for Git Pull (v2.4.0)
- **Root Cause**: Git repos cloned via SSH deploy key had no permanent link between the repo and the key. DockGate used a temporary `GIT_SSH_COMMAND` env var that was discarded after each operation, so subsequent `git pull` (both from UI and from server terminal) failed with `Permission denied (publickey)`.
- **SSH Key Persistence (`ssh-keys.js`)**:
  - Added `persistDeployKey(id)` — writes the deploy key to a permanent file (`data/git-deploy-keys/dg_key_<id>`) on local servers, so it survives across operations.
- **Remote Server Key Binding (`remote-compose.js`)**:
  - Added `persistGitSshConfig(server, repoRoot, keyId)` — uploads the key to `~/.dockgate/keys/` on the remote server and writes `core.sshCommand` into the repo's `.git/config` with the resolved absolute key path.
- **Automatic Config on Clone & Pull (`compose.js`)**:
  - After every `git clone` (both local and remote deploy), the SSH config is now automatically persisted into the repo.
  - Before every `git pull` and `gitRedeploy`, the SSH config is refreshed/ensured.
  - **Result**: `git pull` now works reliably from DockGate UI, AND from a manual terminal session on the server — no extra setup needed.

---

## [2.3.3] - 2026-08-28

### Changed — Native Git Pull Behavior (v2.3.3)
- **Git Operations (`server/routes/compose.js`)**:
  - The standard **"Pull"** action (without force) now uses a traditional, native `git pull` command under the hood, instead of forcing `git fetch` and `git merge --ff-only` with explicit origin branches.
  - This respects the repository's existing upstream branch tracking configuration ("onsuzda yaddasinda qalib") natively on the server.
  - If a standard pull fails due to conflicts, it safely stops and prompts the user to resolve them or use **"Force Pull"** (which retains the `git fetch` + `git reset --hard` behavior to discard local changes).

---

## [2.3.2] - 2026-08-27

### Fixed — Agent Metrics-Only UI Install Logic (v2.3.2)
- **Frontend UI (`public/js/edge-agent-panel.js`)**:
  - Fixed a UI bug where the Agent deployment table and "Install on servers" button were hidden if no SMTP or Telegram channel was configured.
  - The UI now always renders the agent management table, allowing users to successfully deploy the agent in **metrics-only mode** (for telemetry and log aggregation) without requiring notification channels.
  - Added a clear UI warning badge (`⚠ No notification channel configured...`) when operating in this mode.

---

## [2.3.1] - 2026-08-27

### Changed — Global rename to DockGate Agent (v2.3.1)
- **Agent Rebranding (`agent/`)**:
  - Renamed the edge component from `notifier-agent` to **`dockgate-agent`** to better reflect its expanded capabilities (metrics collection, log aggregation, observability).
  - The agent deployment now runs under the image `dockgate/agent:1.0.0` and container name `dockgate-agent`.
- **UI & Settings Updates (`public/js/edge-agent-panel.js`)**:
  - Renamed the UI panel and all visual labels from "Edge Notifier" to **"Edge Agent (observability)"**.
  - The Agent deployment section in Settings is now **always visible**, making it intuitive to deploy the agent in metrics-only mode even before setting up notification channels.

---

## [2.3.0] - 2026-08-27

### Fixed & Enhanced — Monitoring Metrics Accuracy & Agent Metrics-Only Install (v2.3.0)
- **Fixed DB Column Name Mismatch in Monitoring (`server/routes/monitoring.js`)**:
  - Corrected `host_metrics` column mappings: `created_at` → `ts`, `cpu_pct` → `cpu`, `net_rx_bytes_sec` → `net_rx`, `net_tx_bytes_sec` → `net_tx`. Previously all CPU and Network values read as `undefined` and displayed as 0%.
- **Fixed Hardcoded Zero Container Resource Metrics (`server/routes/monitoring.js`)**:
  - `GET /api/monitoring/:serverId/summary` now fetches real container stats via `dockerService.getContainerStats()` using `Promise.all` instead of returning hardcoded `cpuPercent: 0, memUsageBytes: 0, memPercent: 0`.
  - Container Resource Matrix table and Container CPU Distribution chart now display accurate live data.
- **Added Live Container Stats to `/metrics` Endpoint**:
  - Both `db-fallback` and `live-fallback` sources now collect and return per-container CPU/Memory data in the `containers` and `latestContainers` response fields, populating the Container CPU Distribution chart.
- **Fixed Network I/O Missing from Stat Cards**:
  - Added `netRxBytesSec` and `netTxBytesSec` to `host.latest` in all fallback responses so Network I/O stat cards display real bandwidth values.
- **Added Background Local Host Metrics Sampler (`server/index.js`)**:
  - New 15-second background interval collects local daemon CPU, Memory, Disk, Network, and Load metrics, persisting them to `host_metrics` table. The local server now has full historical time-series charts instead of single-point live polling.
- **Enabled DB-Fallback for Local Server**:
  - Removed the `serverId !== 'local'` guard so the local daemon also benefits from stored historical metrics in the monitoring dashboard.
- **Agent Install Without Notification Channels (`server/agent/deployer.js`)**:
  - Removed the hard `envHasChannel` requirement that blocked agent installation when no Telegram or SMTP channel was configured. The agent now installs in **metrics-only mode** with a warning log, and notification channels can be added later via reconfigure.

---

## [2.2.9] - 2026-08-25

### Fixed & Enhanced — Standalone In-Place Git Pull Across All Modals & Deploy-Free Repo Staging (v2.2.9)
- **Standalone In-Place Git Pull in Project Details Modal (`public/js/pages/compose.js`)**:
  - Eliminated legacy ephemeral staging calls from the Project Details Modal (`#cd-pull`, `#cd-redeploy`, `#xg-pull`, `#xg-redeploy`).
  - Pulling from the modal now routes directly to `POST /api/compose/:project/git-pull`, updating repository files directly on the server filesystem while leaving running containers completely untouched.
  - Displays newly pulled commit logs and changed files with a clean message confirming containers are unaffected, giving DevOps/Admins full autonomy over how and when to deploy.
- **Deploy-Free Git Repository Cloning & Staging (`server/routes/compose.js`, `public/js/pages/compose.js`)**:
  - `📦 Clone only (Stage)` now allows cloning and registering Git repositories on the server even before any `docker-compose.yml` file exists.
  - Initializes basic stack registration so developers can pull repository code, edit files with DockGate's Web Editor, open interactive Web Terminals, and deploy when ready.
- **Direct 1-Click Sync/Redeploy Integration**:
  - Synchronized redeploy action in details modal directly to the live streaming deployment pipeline (`POST /api/compose/:project/git-sync`).

---

## [2.2.8] - 2026-08-25

### Fixed & Enhanced — Unified Git Context Engine, Files-Only Git Pull, Subdirectory & SSH Auth Resolution (v2.2.8)
- **Unified Git Context Engine & Root Directory Resolver (`server/routes/compose.js`)**:
  - **Decoupled Repo Root from Stack Directory**: Resolved path mismatch issues in monorepos and subdirectories (e.g. `services/api/` or `deploy/docker-compose.yml`). Git commands (`fetch`, `pull`, `reset`, `diff`) now always operate in the true Git root (`repoRoot`), while Docker Compose commands target the specific stack directory.
  - **Unlocked Adopted Git Projects**: Eliminated the exclusionary check that blocked on-server adopted folders (`source: 'adopt'`) from performing Git operations. Adopted Git projects now enjoy full 1-click Git Pull, Git Sync, commit logs, and update badges.
  - **Offline & Staged Project Discovery**: Global Git Pull and Global Git Sync now discover all registered Git projects (both running containers and stopped/staged stacks in `COMPOSE_DIR`).
- **Strictly Isolated "Files-Only" Git Pull (`server/routes/compose.js`, `public/js/pages/compose.js`)**:
  - `POST /api/compose/:project/git-pull` and `POST /api/compose/git-pull-all` strictly pull source code updates and calculate diffs without restarting or recreating containers.
  - UI modal displays the list of newly pulled commits, changed files, and offers an optional `⚡ Deploy now` button to rebuild when ready.
- **SSH Key Store Integration & Auth Fallbacks (`server/routes/compose.js`, `server/remote-compose.js`)**:
  - Properly propagates DockGate's encrypted SSH Key Store (`keyId`) and `GIT_SSH_COMMAND` throughout all Git fetch/merge/reset operations across local daemon and remote SSH hosts.
- **Custom Path Git Modal Flexibility (`public/js/pages/compose.js`)**:
  - Added a toggleable **"Deploy containers after pull"** checkbox in the custom server path Git modal, allowing users to choose between pure files-only pull or pull + automatic `docker compose up -d --build`.

---

## [2.2.7] - 2026-08-25

### Added & Enhanced — Global Git Pull & Sync Hub, Header Actions, Directory In-Place Deploy & Auto-Detection (v2.2.7)
- **Top Header Global Git Pull / Sync Menu (`public/js/pages/compose.js`)**:
  - **Prominent Header Action**: Positioned right next to the `+ Deploy ▾` button, a unified **`⤓ Git Pull / Sync ▾`** dropdown provides one-stop access to all Git operations across the server with an active Git project counter.
  - **`⚡ Sync & Deploy All Git Projects`**: Single-click bulk redeploy that iterates all Git-connected projects across their respective directories on the server, fetches newest code, and runs `docker compose up -d --build --force-recreate` with live streaming deploy console.
  - **`⤓ Pull All (Files only)`**: Fast-forwards all Git repositories on the server to their latest commits without touching containers, and displays a comprehensive multi-repo results matrix with a 1-click `⚡ Deploy All Now` button.
  - **`📋 Manage & View All Git Repos…`**: Centralized Git repository hub modal listing all Git projects, branches, and exact host directory paths with individual and batch Pull/Sync/Force controls.
  - **`📁 Pull & Deploy Specific Server Path…`**: Point directly to any directory on the host or remote server; DockGate auto-detects the Git repository in that folder, pulls the latest commits in-place, and executes `docker compose up -d --build`.
- **Direct 1-Click Git Actions in Compose Table (`public/js/pages/compose.js`)**:
  - **Dynamic Git Visibility**: If a Compose project is connected to Git (DockGate-managed or external checkout), Git actions and branch indicators are prominently displayed in the main table. If not connected to Git, all Git affordances remain cleanly hidden.
  - **`⤓ Pull`**: Pulls the latest commits directly from Git without restarting containers; presents a modal diff with pulled commit log and changed files, plus a 1-click `⚡ Deploy now` button.
  - **`⚡ Sync`**: 1-click instantaneous Git pull + `docker compose up -d --build --force-recreate` execution with real-time streaming deploy console.
  - **`⚠️ Force Pull & Rebuild`**: Discards uncommitted or diverged local server changes (`git reset --hard origin/<branch>`) and performs a clean build & restart.
  - **Interactive `UPDATE ↻` Badge**: Renders an actionable badge next to project names when newer remote commits are detected via `git ls-remote`, enabling 1-click sync directly from the project row.
- **Unified Backend Git Engine & In-Place Deployments (`server/routes/compose.js`)**:
  - Added `POST /api/compose/git-pull-all`, `POST /api/compose/git-sync-all`, and `POST /api/compose/git-pull-path` supporting both local host and remote SSH targets.
  - Fixed an issue in local deployment engine where containers were created without `--build --force-recreate`, ensuring all newly pulled source code and Dockerfile changes are immediately rebuilt into running containers.
  - Added smart sync prompts in `Deploy from Git` modal when deploying an already registered project name instead of failing with a 409 error.

---

## [2.2.5] - 2026-08-25

### Fixed & Revamped — High-Performance 4-in-1 Logs Explorer, Zero-Lag Streaming & Linux Host Discovery (v2.2.5)
- **High-Performance 4-in-1 Logs & Diagnostics Explorer (`public/js/pages/logs.js`)**:
  - **Zero Browser Freezing & Low RAM Usage**: Eliminated DOM reflow thrashing and memory spikes by replacing periodic 5s whole-DOM replacements with a strict **circular DOM ring buffer (`maxLines: 1000`)** and **`requestAnimationFrame` micro-batching (60 FPS smoothness)**.
  - **🐳 Real-Time Container WebSocket Streaming**: Restored continuous Socket.IO streaming (`logs:subscribe`) with live container picker, Connect/Disconnect toggle, Pause/Resume, Tail lines selector (100, 200, 500, 1000, 2000), Timestamps toggle, Auto-scroll, Search filtering, and **`.log` Export Download**.
  - **🐧 Linux Host & System Logs Explorer**: Discovers and live-streams real host logs (`journalctl`, `kernel/dmesg`, `auth.log`, `syslog`, `/var/log/*`, and systemd service units) on both **Local Daemon** and **Remote SSH Servers** with auto-refresh and customizable line counts.
  - **🩺 Log Doctor & Autonomous Diagnostics**: Comprehensive Health Score (0–100) card with automatic detection of Kernel OOM kills, Nginx 502/504 Bad Gateways, SSH brute-force attacks, and port collisions with 1-click action buttons.
  - **🌐 Cross-Container Search**: Instant multi-container error/warn aggregator and search across all container buffers simultaneously.
- **Native Local Execution for Host Logs (`server/host-logs.js`, `server/routes/servers.js`, `server/routes/monitoring.js`)**:
  - `hostLogs.runWorkerCmd()` now directly executes local diagnostic commands via `child_process.exec` when `serverId === 'local'`, enabling full systemd discovery and journald reading without SSH overhead.
  - Added direct fallback for Linux host log sources (`system`, `auth`, `kernel`, `nginx`) in `/api/monitoring/:serverId/logs`.
- **Tests**:
  - Added unit test in `test/unit/host-logs.test.js` validating local daemon host log reading. All 64 unit tests pass cleanly in ~800ms.

---

## [2.2.4] - 2026-08-25

### Test Update — Live In-App Update Verification (v2.2.4)
- **Live Update Pipeline & Badge Verification**:
  - Verification of the new Software Update Center live version detection, GitHub raw cache-busting (`?_t=timestamp`), and sidebar update badges.
  - Validates that the orange `v2.2.4 UPDATE` badge renders on the main Settings menu item and `● NEW` renders in the Software Update tab.
  - Validates 1-click update deployment, zero-downtime auto-reconnect heartbeat, and post-update celebration toast (`🎉 DockGate updated to v2.2.4!`).

---

## [2.2.3] - 2026-08-25

### Fixed & Enhanced — Out-of-the-Box Observability, Log Doctor Harvester & Sidebar Update Badges (v2.2.3)
- **Sidebar Software Update Badges & Navigation Fix (`public/js/app.js`, `public/js/pages/settings.js`)**:
  - Fixed an issue where update notification badges were missing from the DOM when `Settings` was restructured into a collapsible `nav-parent` section.
  - Added parent `badge-settings` (`v2.2.3 UPDATE`) indicator on the sidebar main item as well as `● NEW` indicator on the `Software Update` sub-tab.
  - Fixed an `item is not defined` reference error in `initMacSidebar` that prevented the app shell from initializing.
  - Automatically updates and displays live update badges without requiring the user to navigate to the Settings page first.
- **Instant Out-of-the-Box Observability & Monitoring (`server/routes/monitoring.js`, `server/host-stats.js`, `public/js/pages/monitoring.js`)**:
  - Implemented direct Host & Docker fallbacks for `GET /api/monitoring/:serverId/metrics` and `GET /api/monitoring/:serverId/summary`.
  - Even when the separate edge agent is not installed on `local` or remote hosts, the **Monitoring** page immediately displays live CPU, RAM, Disk, and Network RX/TX graphs alongside the active container matrix.
  - Added `hostStats.collectLocalStats()` for local direct snapshot gathering without SSH overhead.
  - Added smooth client-side time-series buffer accumulation so canvas graphs render live curves in polling fallback mode.
- **Centralized Log Explorer & Log Doctor Harvester (`server/routes/monitoring.js`, `public/js/pages/logs.js`)**:
  - Added direct multi-container log aggregation fallback for `GET /api/monitoring/:serverId/logs` when agent is absent.
  - Slices, multiplexes, and chronologically sorts recent logs across all running Docker containers and Linux OS logs in under 50ms.
  - Fixed property mapping (`c.name`, `c.id`, `c.shortId`) in Docker service queries to prevent `TypeError: undefined replace`.
- **Edge Notifier & Observability Agent Hardening (`notifier-agent/src/health.js`, `notifier-agent/src/storage.js`)**:
  - Added `source` multi-layer filtering (`container`, `nginx`, `system`, `auth`, `kernel`) directly into `storage.getLogs()` and `/logs` query server.
  - Enhanced `queryAgent()` to support lightning-fast internal `docker exec` queries for local agents without requiring exposed host ports.
  - Verified ring buffers, downsampling buckets (10s, 1m, 15m), and FIFO caps to maintain strict memory efficiency (~25-35 MB RAM).
- **Tests**:
  - All 63 unit tests pass cleanly in ~600ms across diagnostics, metrics downsampling, and agent log storage.

---

## [2.2.2] - 2026-08-25

### Test Update — Software Update Verification (v2.2.2)
- **Live Update Pipeline Verification**:
  - Verification of the new **Software Update Center**, live GitHub raw fetch with cache busting (`?_t=timestamp`), and automatic post-update reload notifications.
  - Validated that release notes, version comparison (`v2.2.1 → v2.2.2`), and 1-click update buttons render smoothly.

---

## [2.2.1] - 2026-08-25

### Added & Fixed — Autonomous Log Doctor Diagnostics & Revamped Software Update Center (v2.2.1)
- **Log Doctor Autonomous Diagnostic Engine (`server/diagnostics/log-doctor.js`)**:
  - Automatically analyzes multi-layer server and container logs, outputs an overall **Server Health Score (0–100)**, and flags critical issues.
  - **Kernel OOM Killer:** Detects Linux kernel memory terminations and suggests adjusting container memory limits.
  - **Nginx 502/504 Bad Gateway:** Detects upstream connection refusals (`111: Connection refused`) and offers 1-click backend restart.
  - **Port Collisions & Storage Exhaustion:** Flags `EADDRINUSE` conflicts and `No space left on device` with direct 1-click Docker prune.
  - **SSH Brute-Force Detection:** Tracks repeated attacker IPs from `auth.log` and suggests firewall & SSH hardening.
- **3-Layer Full-Stack Log Harvester (`notifier-agent/src/host-log-harvester.js`)**:
  - Live delta-harvesting across Linux Host OS (`syslog`, `auth.log`, `dmesg`), Web Proxies (`/var/log/nginx/error.log`, `caddy`), and Docker container logs.
- **Revamped Software Update Center (`public/js/pages/settings.js`)**:
  - **Bypassed GitHub Raw CDN 5-minute Cache:** Added dynamic timestamp cache-busters (`?_t=Date.now()`) to ensure instant live version detection.
  - **Live In-App Release Notes Dashboard:** Displays the latest changelog and what's new directly in the UI for both new updates and current version.
  - **Force Re-Pull Support:** Added `⚡ Re-pull Latest Image` button to re-deploy the latest container anytime even if version tags match.
  - **Zero-Downtime Heartbeat Auto-Reconnect:** Automatically detects container recreation via `/api/auth/status` and refreshes the browser with a celebratory toast (`🎉 DockGate updated to v2.2.1!`).
- **Tests**:
  - Added comprehensive diagnostic unit tests in `test/unit/log-doctor.test.js`. All 63 unit tests passing.

---

## [2.2.0] - 2026-08-25

### Added — Unified Observability Engine: Native Metrics & Centralized Log Explorer (v2.2.0)
- **All-in-One Observability Agent (~40 MB RAM)**:
  - Replaced the need for heavy external stacks (Prometheus + Grafana + Loki / ELK consuming 1.5–4 GB RAM) with a native, single-container Edge Observability Engine.
  - **Metrics Engine**: Samples host (CPU%, RAM, Disk I/O, Network RX/TX, Load) and per-container metrics every 10 seconds.
  - **Auto-Downsampling Ring Buffer**: Capped at <50 MB disk/RAM (10s raw samples for 1h, 1-minute averages for 24h, 15-minute averages for 7d).
  - **Centralized Log Explorer (Loki-Style)**: Unified multi-container log aggregator with live multiplexing, log level classification (`🔴 Error`, `🟡 Warn`, `🟢 Info`), keyword filtering, and automatic error spike anomaly alerts (>30 errors/min).
  - **Grafana-Style Native Monitoring Dashboard**: Interactive Canvas/SVG time-series charts with smooth bezier curves, hover tooltips, live refresh toggles (5s/10s/30s), and per-container resource breakdown table.
- **REST Endpoints (`/api/monitoring/*`)**:
  - `GET /api/monitoring/servers` — Server fleet agent status and health.
  - `GET /api/monitoring/:serverId/metrics?range=1h|6h|24h|7d` — Downsampled time-series datasets.
  - `GET /api/monitoring/:serverId/logs?container=&level=&search=&limit=` — Centralized log querying.
  - `GET /api/monitoring/:serverId/summary` — Real-time host & container resource matrix.
- **Tests**:
  - Added unit test suites for metrics storage/downsampling (`test/unit/agent-metrics.test.js`) and log classification/search (`test/unit/agent-logs.test.js`). All 58 unit tests passing.

---

## [2.1.49] - 2026-08-24

### Fixed — Servers: Destructure `notifications_enabled` in POST /api/servers
- **Remote Server Registration Fix**:
  - Resolved `ReferenceError: notifications_enabled is not defined` when registering a new remote SSH server.
  - Properly destructure `notifications_enabled` from `req.body` in `server/routes/servers.js` so server creation succeeds without 500 errors.

---

## [2.1.48] - 2026-08-24

### Enhanced — Notifications: Edge Notifier Agent Auto-Sync on Host Mute
- **Edge Notifier Power Synchronization**:
  - Toggling a server's notification mute in **Settings ▸ Notifications** now automatically synchronizes any on-host **`notifier-agent`** container (`dockgate-notifier`).
  - When a host is muted, its Edge Notifier agent is automatically stopped; when unmuted, it is automatically resumed.
  - Ensures 100% silencing of outbound alerts across both central and distributed notification engines.

---

## [2.1.47] - 2026-08-24

### Added — Notifications: Host-Level Notification Muting (Local Daemon & Remote Servers)
- **Per-Host Notification Muting (`EventMonitor.isNotificationEnabled`)**:
  - You can now mute or unmute alert notifications individually for any remote SSH server and for the Local Daemon.
  - Muting a host suppresses all its outgoing incident alerts (container die, restart, OOM, disk threshold, unhealthy) via Email/Telegram, while all containers, deployments, builds, and monitoring continue running completely normally.
- **Settings ▸ Notifications UI ("Monitored Hosts & Server Muting")**:
  - Added a dedicated section in **Settings ▸ Notifications** with live toggles for the Local Daemon and every registered remote host.
- **Servers Page Integration**:
  - Servers table displays a `🔕 Muted` status badge when a server's notifications are disabled.
  - Server Add and Edit modals now include a `🔔 Send alert notifications for this server` checkbox.
- **Unit Tests**:
  - Added test suite in `test/unit/host-notifications.test.js` validating muting behavior for local and remote monitors.

---

## [2.1.46] - 2026-08-24

### Added — Compose: Server-Native Git Deploy & Multi-Server Redeploy Routing (100% SFTP-Free)
- **Native Remote Git Operations (`remoteCompose.runGitOnRemote`)**:
  - `POST /compose/deploy-git-prepare` now executes `git clone`, `git fetch`, `git reset`, `git diff`, and `git rev-parse` directly on the target remote server instead of cloning to master and slowly uploading via SFTP.
  - Remote compose files are scanned directly on the target host using `remoteScanComposeFiles`.
  - Deployment completes in ~1–2 seconds utilizing the remote server's high-speed network.
- **Secure Remote Deploy Key Provisioning (`remoteCompose.ensureRemoteKey` & `removeRemoteKey`)**:
  - Automatically provisions decrypted SSH deploy keys to `$HOME/.dockgate/keys/dg_key_<keyId>` with strict `0600` permissions on demand.
  - Keys remain securely centralized in Dockgate's encrypted database (AES-256-GCM) and are removed from target servers when deleted from **Servers → SSH Keys**.
- **Multi-Server Project Routing (`serverId` tracking)**:
  - Both `.dockgate-git.json` and `.dockgate-deploy.json` now record the project's target `serverId`.
  - `gitRedeployJob` and `webhook/:project` automatically route redeploys and Git pulls to the project's specific host without relying on the browser's active UI header session.
- **Custom Remote Folder Support**:
  - Custom target folders selected in the UI are preserved across redeploys, webhook triggers, and Git diff comparisons.
- **UI Enhancements — Dedicated "Clone only" vs "Clone & Deploy"**:
  - Added **`📦 Clone only (Stage)`** action: clones the repository and registers the project without starting containers (ideal for configuring `.env` or manual inspection).
  - Added **`🚀 Clone & Deploy…`** action: clones and immediately brings up the containers via `docker compose up -d`.

### Security & Reliability
- Added `secrets.decryptStrict()` to fail fast on corrupted or mismatched master key secrets instead of passing unauthenticated ciphertexts.
- Added comprehensive unit tests in `test/unit/remote-compose.test.js` and updated `test/unit/auth.test.js` (51 unit tests passing).

---

## [2.1.45] - 2026-08-05

### Added — Containers: read-only **Topology** view (visualize the running stack)
- New third view on the **Containers** page (next to Table/Card): a **📐 Topology** button that draws a **read-only graph of the running containers** — so you can see how a stack is wired without opening a single compose file. Nodes are grouped by **Compose project**; each card shows the service/name, image, live state dot, and its custom networks.
- **Edges are derived, not guessed at deploy-time.** Connections come from the Compose `depends_on` label (directed, data-flow arrows); when a stack has none, it falls back to linking app→datastore containers that share a custom network. Containers with a **published host port** are flagged **public** (green `🌐 :port` marker + left accent). Columns read left→right as **edge · app · data**.
- **Nothing new is fetched or changed.** It reuses the container list the page already loads (`GET /api/containers`, which carries ports/networks/labels/compose metadata) — no backend change, no container is touched. Clicking any node opens that container's existing **detail** page. Theme-aware (light/dark) via the design tokens.

---

## [2.1.44] - 2026-07-31

### Added — Compose: "Adopt from server" — register existing on-server compose folders in place (multi-select)
- New **Adopt from server (existing folder)** entry in Compose ▸ **+ Deploy** (shown when a remote SSH server is active). Browse the server's filesystem, **Scan** a folder, and DockGate finds every existing `docker-compose` file under it (name-agnostic, subfolders included). **Multi-select** the ones you want and add them all as managed projects at once.
- **In place, not copied.** Each adopted stack is registered with a pointer at its OWN folder (`source: 'adopt'`); `docker compose` runs there over SSH, so bind-mounts and relative `.env` resolve exactly as a manual `docker compose up` in that folder would — no upload, no duplicate data, no drift from a git checkout. Reuses the same scan/pick picker, SSH connection pool, and live deploy-log as folder/git deploy.
- Two finish actions: **Add (track only)** — the default — registers without touching containers (ideal when the folder is already running), and **Add & Deploy** runs `up -d`. The scan reuses a project already running in a folder as its exact `-p` name (so Up/Down hit the same containers) and auto-suffixes name collisions. Adopted projects then support Up/Down/Rebuild/Edit-YAML/Files like any other, and external networks a stack declares are offered for pre-creation.

### Security
- **Adopted folders are never deleted.** Because an adopted pointer targets the user's OWN folder, Delete is forced to keep the files (`down` + untrack only), and the "Update from folder" clean-replace path refuses adopted projects — closing every code path that could `rm -rf` a user-owned folder. All browsed paths and compose-file paths are `isSafeHostPath`-validated and shell-quoted; the folder scan is one bounded remote command (depth/count-limited, `timeout`).

---

## [2.1.43] - 2026-07-30

### Fixed — Dashboard: Host Metrics no longer fully re-renders (skeleton flash) on the 30s refresh
- The dashboard auto-refreshes every 30s by rebuilding its whole `innerHTML`, which **destroyed and re-mounted** the embedded Host Metrics section every time — so the live section flashed back to skeletons / "connecting…", rebuilt its trend chart, and lost scroll position every 30s, even though it already updates itself in place every 5s.
- The Host Metrics node is now **mounted once and preserved across refreshes**: the dashboard reattaches the still-polling node instead of tearing it down, and only mounts a fresh monitor when there is none yet or the **active server changed**. The 5s in-place metric updates continue uninterrupted; no more full re-render.

---

## [2.1.42] - 2026-07-30

### Docs — README: document the File Manager Explorer and fix the alert-rule count
- The README described the file feature only as an "SFTP file manager" and never mentioned the **Explorer** built across v2.1.31–2.1.41. The Files entry now documents the opt-in **⇆ Explorer** mode: two-pane FileZilla-style transfer between your computer and the server (any Windows/macOS/Linux browser), whole-folder upload, parallel transfers (7 concurrent), pre-upload conflict detection (Overwrite/Keep-both/Skip), a live transfer panel (`active · done · failed · cancelled / total`) with Retry-failed, and cancel of in-flight uploads/downloads.
- Fixed the **"Alert rules (9)"** miscount — eight rule types are listed (`container_die` surfaces as Stopped/Crashed/OOM), so the heading now reads **(8)**.

---

## [2.1.41] - 2026-07-04

### Added — File Manager Explorer: FileZilla-style transfer summary + Retry failed
- The Transfers panel header now shows a **live breakdown** — `N active · ✓ done · →browser handed · ✗ N failed · ✕ cancelled / total` — instead of a single "in progress / finished" line.
- A **↻ Retry failed** button appears whenever a transfer failed; it re-runs the failed uploads/downloads with bounded concurrency (re-ensuring remote directories first). Each transfer now remembers its operation (`op`) so it can be replayed without re-picking the files.

---

## [2.1.40] - 2026-07-04

### Changed — SSH connection pooling (the FileZilla model): connect once, reuse for many operations
- The File Manager opened a **fresh SSH connection for every operation** — each list/mkdir/upload/download paid a full TCP + key-exchange + auth handshake, then closed it. Now a per-server **connection pool** (`server/ssh-pool.js`) keeps a bounded set of warm connections and reuses them, exactly how FileZilla / WinSCP / OpenSSH work.
- Pool: up to `POOL_MAX` (8) live connections per server, keyed by server id + auth material; SSH keepalive (15 s) detects dead links; idle connections evicted after 60 s; a borrow that finds a dead connection reconnects; metadata ops retry once on a transport error; streaming upload/download **release** the connection on a clean end and **destroy** it on error/abort (a half-streamed channel is never returned to the pool).
- `withSftp` keeps its signature so every metadata caller is unchanged; `uploadFrom`/`downloadTo` borrow pooled leases; `archiveDirTo` keeps its own exec connection. Pooled connections are **invalidated on server edit/delete** (changed credentials take effect; a removed server keeps no live session) and **drained on shutdown** (no zombie sessions).
- Verified against a throwaway sshd: 10 sequential ops ran over **one** reused connection (~4 ms/op), and the server accepted only **8** connections for ~21 operations (vs 21 without pooling).

---

## [2.1.39] - 2026-07-04

### Changed — Explorer uploads now run in parallel (7 concurrent), not one file at a time
- The upload loop was strictly sequential (upload one file, wait, next), so a folder of many files was slow. It now runs a **bounded pool of 7 concurrent workers** pulling from the queue — roughly proportional wall-clock savings for many files.
- Supporting changes: Cancel / close now aborts **all** in-flight upload XHRs (a Set, not a single slot); `ensureRemoteDir` caches the `mkdir` as a **promise per directory**, so concurrent workers dedupe it and parent-before-child ordering holds (safe on top of the v2.1.38 idempotent mkdir).
- Concurrency is one tunable constant (`UPLOAD_CONCURRENCY = 7`). Note: without SSH connection pooling each worker opens its own connection, so keep it clear of a typical sshd's `MaxStartups` (~10); lower it if a server refuses connections under load. A connection pool (reuse one connection for many ops) is the larger, separate follow-up.

---

## [2.1.38] - 2026-07-04

### Fixed — Folder upload no longer 500-spams mkdir for directories that already exist
- Re-uploading a folder printed dozens of `POST /api/files/mkdir 500` errors: the upload blindly created every ancestor directory, and `sftp.mkdir` on an existing directory fails (SFTP v3 returns a generic `FAILURE`, indistinguishable by code), so each existing directory became a 500. The frontend swallowed them so the upload still worked, but the console filled with red errors.
- `mkdir` is now **idempotent for the upload path**, matching how FileZilla / OpenSSH / WinSCP / lftp / ssh2-sftp-client all work: when the folder-upload flow passes `ensure: true`, a failed `mkdir` is confirmed with `stat()` — an existing **directory** is treated as success (HTTP 200), an existing **file** of the same name returns a clear **409**, and a genuine failure returns the real error. The manual **+ Folder** button stays strict (creating an already-existing folder still errors), and the audit log no longer records a mkdir for a directory that already existed.

---

## [2.1.37] - 2026-07-04

### Changed — Explorer "Checking…" (pre-upload conflict check) now runs in parallel
- The conflict check walked the destination directories **serially**, and the backend opens a **fresh SSH connection per `/api/files` request**, so each listing paid a full SSH handshake and they stacked up — "Checking…" could take several seconds. Listings are now cached as promises and the per-directory walks run in **parallel** (`Promise.all`): a shared ancestor is fetched once and independent directories list concurrently. Combined with v2.1.36 (only existing directories are listed), the check is typically **one round-trip** for a new folder.
- Note: the underlying per-request SSH handshake (no connection pooling) still makes general remote browsing slower than needed — a backend SSH connection pool is the larger, separate win.

---

## [2.1.36] - 2026-07-04

### Fixed — Explorer upload conflict check no longer spams 500s for a new folder
- Uploading a brand-new folder made the pre-upload conflict check `GET /api/files` for every destination sub-directory — none of which exist yet — so each returned a 500 (`listDir` throws on a missing path), flooding the console and adding latency, even though a new folder can't have conflicts.
- `detectConflicts` now lists **only directories that actually exist**: it walks top-down from the current remote folder and descends into a sub-directory only when the parent listing already contains it. A new folder is never listed (zero 500s, faster), while a merge into an existing tree still detects real conflicts. The folders themselves are still created on upload via `mkdir`.

---

## [2.1.35] - 2026-07-04

### Fixed — Explorer transfer hardening (static code-review findings)
- **Ghost upload / double-submit eliminated.** The upload pre-flight (conflict check + prompt) now takes a synchronous `preparing` lock (counts as "active", disables the button) and bails after each `await` if the modal was closed — so closing mid-prompt no longer resumes a hidden upload against a detached overlay, and a second click can't fork a parallel pipeline over a shared XHR.
- **"Keep both" no longer overwrites a batch sibling.** The rename reservation now also reserves every job's own basename in its destination, so a generated `name-1.ext` can't silently collide with an unchanged sibling (was data loss).
- **Child dialogs tear down with the Explorer.** The z-1300 conflict / close-confirm dialogs are removed — and a pending conflict prompt is resolved as "cancel" — on close, instead of being orphaned on screen.
- **Downloads track all in-flight controllers** (a Set), so Cancel/close aborts every one; per-row and batch downloads no longer clobber a single slot.
- **`beforeunload` now arms for a per-row download too** (gated on any active transfer, not just the batch flags).
- **The Explorer tears down on route navigation** (via a returned cleanup) instead of leaking a fixed overlay + document listeners onto the next page.
- Repeated Esc no longer **stacks** close-confirm dialogs; browser-handed downloads are **counted/worded honestly** ("N handed to browser"); a finished batch download now **clears the remote selection**.

---

## [2.1.34] - 2026-07-04

### Fixed — Explorer close-confirmation dialog was hidden behind the overlay
- The "abort transfer & close?" confirm added in v2.1.32 used the app's `showConfirm` modal (z-index 1000), which sits **below** the Explorer overlay (z-index 1200) — so it was invisible and the user got stuck when closing mid-transfer. Replaced it with a dedicated confirm at z-index 1300 (matching the upload-conflict dialog).

---

## [2.1.33] - 2026-07-04

### Added — File Manager Explorer: upload conflict prompt (Overwrite / Keep both / Skip)
- Uploading a file whose name already exists on the remote no longer **silently overwrites** it. Before the upload the Explorer lists each destination directory and, if any names collide, asks: **Overwrite** (replace), **Keep both** (upload as an auto-suffixed `name-1.ext`), **Skip** (keep the existing ones, upload the rest), or **Cancel** the whole upload. Applies across the batch, including files nested in sub-folders. Frontend-only — reuses the existing listing + upload endpoints.

---

## [2.1.32] - 2026-07-04

### Fixed — File Manager Explorer: transfer safety & completion accuracy
- **Accidental close no longer loses a transfer.** While an upload/download runs, closing the Explorer (✕ / Esc / backdrop) asks to confirm and aborts cleanly; the backdrop now needs a real click and is disabled mid-transfer; a `beforeunload` prompt guards a tab close/reload; and re-opening focuses the running instance instead of forking a second (duplicate-upload) pipeline.
- **Folder / unknown-size downloads no longer buffer into memory.** They carry no `Content-Length`, so they bypassed the 512 MB guard and could OOM the tab — they now go straight to the browser downloader.
- **Browser-handed downloads are reported honestly** as "→ browser" (check your Downloads) instead of a false green ✓.
- **Session expiry (401/403) mid-transfer is detected**: uploads/downloads stop immediately with a "session expired" prompt instead of flooding doomed requests or silently saving the login page as your file.
- A cancelled/failed upload now **warns that the remote file may be partially written** (an atomic temp-file-then-rename upload is a planned backend follow-up).

---

## [2.1.31] - 2026-07-04

### Added — File Manager Explorer: live transfer panel with per-file progress
- The Explorer gains a **Transfers** panel at the bottom listing every upload/download with a **live per-file progress bar**, byte count, and status (active / ✓ done / ✗ failed / ✕ cancelled), plus a **Clear finished** button.
- **Uploads** now report real progress via `XMLHttpRequest.upload.onprogress`. **Downloads** stream with progress (`ReadableStream`) before saving; payloads over 512 MB are handed to the browser's own downloader (never buffered in memory).
- Cancel acts on the live transfer (upload XHR aborts; download fetch aborts). No backend change; the default single-pane File Manager is untouched.

---

## [2.1.30] - 2026-07-03

### Added — Cancel an in-progress transfer in the File Manager Explorer
- Both the Explorer **upload** and the batch **download** can now be **cancelled mid-flight**: the `Upload →` / `← Download` button turns into **✕ Cancel** while a transfer runs.
- **Upload** cancel truly aborts — the in-flight file's request is `AbortController`-aborted and the remaining queue stops; the toast reports how many completed.
- **Download** cancel stops starting further files; downloads the browser has already begun keep going (a browser cannot recall them) — stated honestly in the toast.

---

## [2.1.29] - 2026-07-03

### Changed — File Manager Explorer: full FileZilla-style browsable local tree + swapped panes
- The **YOUR COMPUTER** pane is now a **browsable folder tree** (FileZilla-style), not a flat list: pick or drop a folder and navigate into it (breadcrumb + up) with per-item checkboxes. Panes are **swapped** — your computer on the **LEFT**, the remote server on the **RIGHT**.
- **Upload is structure-preserving** ("what you see uploads here"): ticked files/folders upload into the remote current dir keeping their sub-tree; if nothing is ticked, the whole current folder uploads. The remote pane gains **checkboxes + a batch "← Download"** (to your browser's Downloads; folders as `.tar.gz`) alongside the per-row download.
- Still cross-platform (Windows/macOS/Linux · Chrome/Edge/Firefox/Safari), POSIX remote paths, **no backend change**, and the default single-pane File Manager is untouched. The tree is derived from the picked items — a browser can only show what you pick, not the whole disk (File System Access API deferred: Chromium + secure-context only).

---

## [2.1.28] - 2026-07-03

### Added — File Manager "Explorer" mode: two-pane transfer between your computer and the server
- The File Manager gains an opt-in **⇆ Explorer** button. The default single-pane view is unchanged; clicking Explorer opens a **two-pane** overlay: **LEFT** = the remote server (browse folders, **download** files/folders to your computer), **RIGHT** = **your computer** (drag-drop or pick **files and whole folders** → **upload** into the remote folder shown on the left, with per-item progress).
- **Cross-platform by design** — the "your computer" side uses only browser file APIs (identical on **Windows / macOS / Linux**), and every remote path is POSIX (`/`); a Windows client's back-slashes are normalized so they never reach the Linux host. Dropped folders keep their structure (each sub-directory is `mkdir`-ed on the remote before its files upload).
- Reuses the existing file endpoints (`/files/upload`, `/files/download`, `/files/download-folder`, `/files/mkdir`) — no backend change. Closes on Esc / background click / ✕.

---

## [2.1.27] - 2026-06-27

### Changed — Rebuild picker shows the full compose-file path
- The Rebuild "scan & pick" dialog now shows **where each compose file actually lives** — the full absolute path (e.g. `📁 /root/prod/docker-compose.yml`) under each file, and the **scan root** in the header (`…under /root/prod`) — so on a remote host you can see exactly which file in which directory will be rebuilt, not just its bare name.

---

## [2.1.26] - 2026-06-27

### Fixed — Compose actions now pass `-f` (non-standard / subdir / multi compose files) + Rebuild "scan & pick"
- **The bug:** every per-project Compose action (Rebuild, Up, Build, Pull, Down, Restart) ran `docker compose -p <project> <action>` in the working dir **without `-f`**, so docker only auto-found the 4 standard filenames. A project whose compose file has a non-standard name (`docker-compose.greennec.yaml`) or lives in a subdir (`deploy/…`) failed with **`no configuration file provided: not found`**.
- **The fix:** a single `resolveComposeFiles()` resolver now drives every action — precedence: deploy metadata → git metadata → docker `config_files` label (CSV → multiple `-f`; validated, since labels are untrusted) → filesystem discovery → fail-closed. Each action is run with the resolved `-f <file>` (cwd normalized to the file's own dir so relative build contexts / bind-mounts resolve as at deploy time). Fixes Rebuild/Up/Build/Pull/Down/Restart + Delete for non-standard, sub-folder, and **multi-file (override)** projects, local and remote.
- **Rebuild is now "scan & pick":** clicking **Rebuild** scans the project's tree (git repo root, or the working dir) for **all** compose files — *any* `*.yml`/`*.yaml` with a `services:` block, regardless of name or location — and shows a picker listing each file (sorted, the running one badged **current**) with its services, plus a **live command preview** (`docker compose -p … -f … up -d --build …`). You choose **which services in which file** to rebuild, with optional **force-recreate** and **no-cache** (clean build). If nothing can be resolved it blocks with a clear message instead of the cryptic docker error.
- Works on the active server, **local or remote SSH** (remote scan uses a portable `find`-based probe that runs on busybox/Alpine too). Verified e2e against a repo with three compose files in different locations/names (`deploy/docker-compose.greennec.yaml`, `stacks/monitoring.yml`, `prod.yaml`): scan found all three with their services + the current badge; the picker preview and multi-file selection worked; plan-rebuild and the default (`-f`-injected) Rebuild/Build both succeeded where the old code failed.

---

## [2.1.25] - 2026-06-27

### Added — Adopt EXTERNAL git projects: Pull / Redeploy a checkout DockGate didn't deploy
- Until now the git badge + **⤓ Pull** / **↻ Redeploy** only appeared for projects deployed *through* DockGate. If you'd SSH'd into your server, `git clone`d a repo yourself, and run `docker compose up` by hand, DockGate listed the project but offered no git actions. Now it **detects** that case: when you open a project's detail and its working directory is a git checkout DockGate doesn't manage, a **"Git (detected)"** card appears with **⤓ Pull** and **↻ Redeploy**.
- **Strictly non-destructive.** Pull runs **plain `git` in your own checkout** (your already-configured remote + credentials — DockGate injects no token, overrides no SSH key) and is **fast-forward only** (`fetch` + `merge --ff-only`). It **never** runs `reset --hard` or `clean`, so it can't overwrite your files. If the working tree has uncommitted changes, is on a detached HEAD, has no upstream, or isn't a clean fast-forward, it **refuses and changes nothing**, telling you why. Redeploy then runs `docker compose -p <project> -f <configFile> up -d --build` in the working dir (one-shot/stateful services are **not** force-recreated).
- Works for the **active server** — local Docker **or** a remote SSH host (git + compose run over the same SSH channel). Detection is **lazy** (only when the detail modal opens, 90s-cached) so the project list does zero git/SSH work. DockGate-managed projects are excluded (no double-handling).
- **Security:** Docker `working_dir`/`config_files` labels are treated as untrusted — every path is validated (absolute, no `..`, no newline/NUL, strict charset) and shq-quoted before reaching a shell; git runs via `git -C <dir>` resolved through `rev-parse --show-toplevel`.
- Verified e2e (local) against a real external checkout with an upstream: detect → fast-forward pull (files updated in place) → redeploy (`up -d --build`, container recreated) → **dirty tree refused (409, files untouched)** → non-git and DockGate-managed projects correctly offer nothing. Remote SSH path's command construction + injection-rejection verified separately.

---

## [2.1.24] - 2026-06-27

### Added — Project Terminal: resizable (Normal / Large / Full screen)
- The per-project **Terminal** modal (Compose → 🖥) now has a **Size** control with three presets — **Normal**, **Large**, and **⛶ Full screen** — so you can give an interactive shell as much room as you need. Switching size resizes both the terminal area and the modal, then re-fits xterm so the shell's columns/rows track the new size. The choice is remembered per browser.
- Verified e2e: Normal (52vh / 520px modal) → Large (72vh / 1000px) → Full screen (82vh / 97vw), with the active size highlighted and the terminal reflowing on each change.

---

## [2.1.23] - 2026-06-25

### Fixed — Git/folder Compose deploys: Pull/Redeploy now show, and Delete actually removes the folder
A cluster of bugs meant a **locally** git-deployed project lost its Git affordances and left files behind. All were the same three gaps; fixed together:
- **⤓ Pull / ↻ Redeploy / git-badge were missing on local deploys.** The project list never tagged a *running, local* project with its deploy source — the annotation loop was remote-only and the "down project" merge skipped anything already running. A running local git/folder project now gets its `deploySource` from the saved deploy-pointer, so the git badge, **⤓ Pull**, **↻ Redeploy**, and folder **Update** appear as they already did for remote deploys.
- **Local git deploys didn't record a deploy-pointer at all.** `.dockgate-deploy.json` was written only on the *remote* branch of the git-deploy worker (and the single-file local finish), so a local git project was never recognized as Git-managed. Both local paths now write the pointer (`mode:local, source:git`).
- **Delete project left the folder on disk.** The folder was removed only when a *standard-named* compose file sat directly in the managed dir — so a repo whose compose file is in a subfolder or has a non-standard name (e.g. `deploy/docker-compose.greennec.yaml`) kept its folder forever. The managed dir is always under DockGate's compose dir, so it's now removed whenever you ask to delete files, regardless of the compose file's name or location. `down` also resolves its working dir from the deploy-pointer so stopped projects tear down cleanly.
- **Git deploys with non-standard / nested compose files now work.** The simple git-deploy path only matched the 4 standard compose names at the repo root; it now falls back to any `*.yml`/`*.yaml` declaring `services:` (the same name-agnostic scan the picker uses) and passes the resolved file with `-f` so it actually starts.
- Verified e2e against a real (gartenmeister-shaped) repo whose compose file is `deploy/docker-compose.greennec.yaml`: clone → scan finds the nested file → deploy writes `source:git` → the running project shows `deploySource:git` (badge + Pull) → **Delete removes both the container and the folder**.

---

## [2.1.22] - 2026-06-25

### Changed — Compose folder deploy: upload limit raised from 50 MB to 1 GB
- The **Deploy from folder** upload was capped at **~50 MB**; a project folder is now accepted up to **~1 GB** (uploaded file-by-file with live progress). Raised everywhere the old limit lived so it's consistent: the per-file/total server checks (`UPLOAD_MAX_BYTES` + the single-shot guard), the Express body-parser for the `deploy-folder*` routes (`100 MB → 600 MB`), the 413 message, and the frontend's own pre-upload guard + the two help texts.
- **Single-file ceiling ~384 MB:** files travel as base64 inside a JSON body, which `JSON.parse`/V8 caps near ~384 MB per file (a base64 string can't exceed V8's ~512 MB max). The total project can still reach 1 GB because the UI uploads one file at a time. The picker now catches an oversized single file up front with a clear message ("over ~380 MB — use a pre-built image or git deploy") instead of letting it fail with a cryptic server error.
- Verified e2e in a container: a **60 MB** file (previously rejected at the 50 MB cap) and a **~120 MB** two-file total both upload successfully.
- **Note:** if you run DockGate behind your own reverse proxy (nginx/Caddy/Traefik), that proxy has its own body-size cap — e.g. nginx defaults `client_max_body_size` to 1 MB — so raise it there too for large uploads to reach DockGate.

---

## [2.1.21] - 2026-06-25

### Added — GitHub-style "type to confirm" on every delete
- Every destructive action now requires you to **type a confirmation phrase** before the red button activates — the same safety pattern GitHub uses for deleting a repo. A misclick can no longer delete the wrong thing: the **Delete** button stays disabled until what you type matches.
- **For a single named resource** (a container, image, volume, network, server, SSH key, registry, file, or compose project) you retype that resource's **own name/id** — so you literally confirm *which* one you're deleting. **For bulk / prune / clear-all** actions (no single name) you type the word **`delete`**.
- New shared `showDeleteConfirm()` helper in the UI; all confirmation dialogs were swept to use it. Coverage: Remove Container (single + bulk), Remove/Force-Remove Image, Remove Volume(s), Remove Network(s), Delete Server (Servers list + Settings), Delete SSH key, Delete registry, Delete file(s), Compose **Down** and **Delete project** (the project-delete modal keeps its volumes/files options and the server banner, now gated on the project name), Build-record deletes / Clear-all / Prune build cache, Cleanup **Prune** and **Full System Prune**, Clear audit log, and the notifier-agent **Remove** (was a bare browser `confirm()` — now the typed gate, keyed on the server id). The notification-settings **Clear SMTP / Clear Telegram / Clear notification-log** buttons — which previously deleted saved config with *no* confirmation at all — are now gated too.
- The existing **server-context banner** (🖥 Local / 🔐 remote host) still shows at the top of each dialog, so you also see *where* the delete will land. Non-destructive actions (Start/Stop/Restart, Grant Docker, Update, Save config, Hide-from-history) are intentionally left as one-click confirms.
- Built and audited by a parallel sweep across all 14 page files plus a completeness pass; verified e2e in a container — the keystone gate (disabled → stays disabled on a wrong phrase → enables on exact match → fires → closes) and a real wired delete (Delete Server, keyed on the server id, actually removes the server) both pass.

---

## [2.1.20] - 2026-06-25

### Added — Per-server access password (a 2nd gate to switch servers)
- A server can now carry an **access password** — a second factor *on top of* the DockGate login. Even when you're already signed in, switching the active server to a protected one prompts for that server's password first. Useful when several people share one DockGate but only some should reach a given production host.
- **Settable when adding** an SSH server (new optional field) **and later in Edit**. In Edit you can **set**, **change**, or **remove (unlock)** the gate — but **changing or removing requires entering the current access password**, so nobody can simply edit the server to strip its protection.
- A **🔒 badge** marks protected servers in the header server-switcher and in the Servers list.
- **Enforced server-side**, not just in the UI: `POST /servers/active` rejects a switch to a gated server unless the correct password is supplied, returning **403** (deliberately *not* 401 — a 401 would be mistaken for session-expiry and bounce you to the login screen). The password is stored **hashed** (scrypt `salt:hash`, the same primitive as the login password) — it is a gate, never recoverable plaintext — and the hash is never sent to the browser (the list only exposes a `hasAccessPassword` boolean).
- Verified e2e against a fresh container: add-with-password stores it (hash not leaked); switching with **no** / **wrong** password is refused (403, no logout) and the UI shows the unlock prompt; the **correct** password connects; Edit **change**/**remove** is refused without the current password and succeeds with it; the old password stops working after a change.

---

## [2.1.19] - 2026-06-24

### Added — File Manager: extract uploaded archives (📦) safely
- Upload a `.zip` / `.tar` / `.tar.gz` (`.tgz`) / `.tar.bz2` / `.tar.xz` / `.gz` and **extract it in place** with a new **📦** action on archive rows. The Extract dialog shows the **server-context banner** (which remote host it writes to), the **detected format**, and a destination choice — **into a new subfolder** named after the archive (default, safest) or **here** — plus optional *overwrite* and *delete-archive-after* toggles. On success the listing auto-refreshes to reveal the extracted files.
- Extraction runs **on the server** over SSH (no bytes streamed through the panel), reusing the existing `execRemote`+`shq` pattern. New `fm.extract()` + `POST /api/files/extract`.
- **Security (verified against a real busybox/Alpine remote):** extracts into a confined target dir; **tar's built-in `..`-rejection** stops path-traversal (a crafted `../escapee.txt` did not escape the parent); a **post-extract symlink-containment scan** blocks (and cleans up) any archive that drops a symlink pointing outside the target; format is checked by extension with a `file --mime-type` magic-byte fallback; a **10-minute `timeout`** wraps the extractor; zip uses only sanitizing extractors (`unzip` → `python3 -m zipfile` → `bsdtar`, never an unguarded 7z/jar) with a clear "install unzip / upload a .tar.gz" message when none exist; non-empty target subfolders are refused unless overwrite is chosen.
- Verified e2e: 📦 appears on archive rows, the modal shows the remote banner + subfolder default, and extracting a `.tar.gz`/`.zip` produces the new folder; traversal and out-of-tree-symlink archives are blocked. (Remote-only — local-host File Manager is still the open gap. A symmetric "Compress" action is a possible follow-up.)

---

## [2.1.18] - 2026-06-24

### Fixed — Compose "Delete project" now shows the server context too
- The server-context banner from v2.1.17 covered every `showConfirm` dialog, but Compose **"Delete project"** uses its own custom modal, so it had no banner. The banner logic is now a reusable global `serverContextBanner()` helper, and the Delete-project modal shows it — so deleting a whole stack (containers + files + optionally volumes) clearly states **🖥 On Local Docker** or **🔐 On remote server: `<name>` · `<host>`** (amber) first. Verified the helper is global and renders both states.

---

## [2.1.17] - 2026-06-24

### Added — Every confirm/delete dialog now shows WHICH server it targets
- It was possible to think you were on Local but actually be on a remote host and delete the wrong thing. Now **every confirmation dialog** (`showConfirm` — used by ~35 delete/destructive actions across containers, images, volumes, networks, compose, servers, registries, …) shows a server-context banner at the top: **🖥 On Local Docker** (neutral) or **🔐 On remote server: `<name>` · `<host>`** in **amber** so a remote target stands out. One shared change covers them all.
- Verified e2e: the banner reads "On Local Docker" (grey) for the local socket and "On remote server: Production · 10.0.0.5" (amber) for a remote server, using the server's display name.

---

## [2.1.16] - 2026-06-24

### Fixed — Compose Pull "first pull — baseline recorded" was a no-op (stuck forever)
- For a Git project deployed **before** commit-tracking existed (no `deployedCommit` on record), every `⤓ Pull` showed *"First pull — baseline recorded"* and **nothing else — forever**, because `redeploy-prepare` never actually saved a baseline. So pulls could never show what changed. Now the first pull **persists the current commit as the baseline** (writes `deployedCommit` to the project's `.dockgate-git.json`, the same file the next pull reads), so the **next** pull correctly diffs against it and shows the new commits & changed files.
- The first-pull message is clearer about why nothing shows yet (there was no earlier commit to compare against) and notes you can `↻ Redeploy` to sync if the server might be on an older commit.
- Verified: `gitMetaPath` (write) and `readGitMeta` (read) resolve to the same `.dockgate-git.json`, and the write preserves the existing meta fields while setting `deployedCommit`. (Full live two-pull cycle needs a deployed git project + a push; the persist logic and the diff/log logic were each verified independently.)

---

## [2.1.15] - 2026-06-23

### Improved — Compose "⤓ Pull" now shows what & how it pulled (commits), and errors clearly
- The Git **⤓ Pull** in a Compose project's detail modal used to only list the changed *files*. It now shows the **actual commits pulled** — `<short-sha>  <date>  <subject>  — <author>` for each commit between your last-deployed commit and the latest — plus the explicit **`from → to`** SHAs, then the changed files. So you can see *what* came in and *how far* it moved, not just which files differ.
- Backend `redeploy-prepare` now returns a `commits` array (best-effort `git log fromSHA..toSHA`, after deepening the shallow clone so the range is walkable; wrapped in try/catch so it never breaks the pull).
- **Pull failures are now shown in a modal** with the reason (e.g. clone/auth/network failure) instead of a brief toast that's easy to miss.
- Verified: the `git log` format + parsing produce the right commit list on a real repo, and the result modal renders the commits, the from→to SHAs and the changed files.

---

## [2.1.14] - 2026-06-23

### Added — Servers can have an editable display name (the ID stays permanent)
- A server's **ID** is its permanent internal key (it names the SSH-key file and is referenced by the active-server setting, provisioning history, audit log and per-server monitors — so it can't be renamed). Previously that meant there was **no way to rename a server** at all. Now servers have an optional **display name** you can set when adding and **change any time** in Edit — the list shows the name (with the ID as a small secondary label), and the header SRV dropdown uses it too. Clearing the name falls back to showing the ID.
- Schema migrates additively (`servers.name`); add/edit/list all carry it. Verified e2e: add with a name → list shows it; rename via Edit → updates while the ID/host stay intact; clear → falls back to the ID.

---

## [2.1.13] - 2026-06-23

### Fixed — Row action buttons no longer overflow off-screen (Servers + Registries)
- The **Servers** table's action cell (Use · Test · Manage · Grant Docker · Edit · 🗑) was a plain `<td>` with no wrapping, so on a wide table its 6 buttons pushed the Actions column off the right edge (you had to scroll horizontally to reach them). The buttons now sit in a `flex-wrap` group (capped width) so they **wrap to multiple rows** and the column stays compact — verified: at desktop width the table no longer overflows; at laptop width the 6 buttons wrap to ~4 rows in a ~120px column.
- Audited every other table for the same problem. **Registries** had the identical anti-pattern (a `white-space:nowrap` action cell with Test · Edit · Delete) and got the same wrap fix (table overflow at 1024px dropped 241→153px). Every other table (Images, Containers, Volumes, Networks, Compose, Files) already uses the shared `.td-actions` class, which has `flex-wrap` — so their actions already wrap; single-button cells can't overflow.
- Note: very wide tables can still scroll horizontally at narrow laptop widths (intended `overflow-x:auto`), but that is now driven by the info columns, not the action buttons.

---

## [2.1.12] - 2026-06-23

### Fixed — Server Setup now NAMES the missing component (not just a count)
- The server console's **Overview** said "⚠ Needs setup · 7 installed · 1 missing" but never told you **which** item was missing, and the component that was missing rendered in muted gray (○) — easy to miss among the green ✓ installed rows. Now the readiness banner adds a **"Missing: \<names\>"** line (e.g. *Missing: Fail2ban*) and the missing items render in **amber** (● in the Overview component list, amber pill in the Setup panel) so they stand out at a glance.
- Verified e2e (mocked scan: 8 installed / fail2ban missing): the banner shows "Missing: Fail2ban" in amber, and the Fail2ban component row's icon is amber — both `#f59e0b`.

---

## [2.1.11] - 2026-06-23

### Fixed — "Test Connection" now tests SSH first (not Docker), with clear messages
- **Test Connection used to fail on a fresh server even when SSH worked.** It called the Docker API (`version()`/`info()`) over SSH, so a host where you could log in fine but hadn't installed Docker yet returned a cryptic **"socket hang up"** (that was the *Docker* socket, not SSH). `testServerConnection` now does it in two steps: **(1)** a real SSH connect + auth check on its own (raw ssh2, no Docker), then **(2)** a separate, non-fatal Docker probe. A fresh server now reports **"✓ SSH connection OK — Docker not installed/running yet. Add it, then install Docker from Setup"** (success, addable) instead of failing — fixing the chicken-and-egg where you couldn't add a server to *then* provision it.
- **Friendlier connection errors** everywhere (Test buttons on the add form, edit modal, and per-row): raw ssh2/net errors are translated — `socket hang up` → "connection reset (wrong port/firewall, or IP temporarily blocked after failed logins)", `ECONNREFUSED` → "nothing listening on that port", `ETIMEDOUT` → "host unreachable", auth failures → "check the username and password/SSH key", and the first-login "password change required / no TTY" case → "log in once over SSH to set a password, or use an SSH key".
- Verified e2e against a real SSH-only container (no Docker): SSH-OK/no-Docker → amber "SSH OK, Docker not installed"; bad host → "Host unreachable"; wrong password → "Authentication failed"; local → "✓ Docker <version>".

---

## [2.1.10] - 2026-06-21

### Added — Registries: richer table + Browse/Inventory + Dashboard card (Registries plan, Phase C+D+E)
- **Phase C — richer Registries table.** Each registry now shows a **Type** badge (GitHub / GitLab / Docker Hub / Quay / Custom), a **Status** pill (Connected / Auth failed / Untested — cached from "Test login", persisted in `last_test_status`), and a **repo count** button. Password column dropped (it was always masked).
- **Phase D — Browse / Inventory ("how many images").** A per-registry **Browse** modal lists the repositories tracked under it and, per repo, lists **tags** via the registry's v2 API with a generic **token-dance** auth client (`server/registry-browse.js`) that works on ghcr.io, registry.gitlab.com, quay.io and self-hosted `registry:2`; digest + size are fetched lazily per tag. Repos are populated **automatically on push** (`tracked_repos` table) — the portable path that works even where `/v2/_catalog` is unavailable (Docker Hub, GHCR) — and can be pinned/untracked manually. New endpoints: `GET/POST/DELETE /api/registries/:id/repos`, `GET /api/registries/:id/tags`, `GET /api/registries/:id/manifest`.
- **Phase E — Dashboard card.** A "Registries" summary card shows the count (and "N connected") and links to Servers → Registries.
- **Security hardening (from an adversarial review of the new code):** the browse client only sends the stored password/PAT to a token-auth realm that is **HTTPS and on the same domain** as the configured registry (so a malicious/compromised registry can't redirect the credential elsewhere, least of all over cleartext); and the global `escapeHtml()` now also escapes `"`/`'` so remote-registry tag names can't break out of quoted HTML attributes. Browse calls have 12s timeouts and capped pagination.
- Verified e2e: enriched table (badges/status/count), Browse modal lists auto-tracked repos, the tag token-dance executes against real ghcr.io (and surfaces auth errors cleanly), track/untrack + test-status persistence via the API, and the Dashboard card. Schema migrates additively (`tracked_repos`, `last_test_status`, `last_test_at`).

---

## [2.1.9] - 2026-06-21

### Added — Push: which-registry hint + post-push result card (Registries plan, Phase A+B)
- The **Push image to registry** modal now shows, live as you type the target reference, **which stored credential will be used**: "✓ Will authenticate as `<name>` (`<host>`)" when a registry matches the host, or "⚠ No stored credential for `<host>` — push is anonymous" otherwise (Docker Hub aliases handled). No more guessing which registry a push lands in.
- After a successful push, a **result card** shows the pushed **tag**, the **digest** (`sha256:…` with a Copy button), the **compressed size**, the **registry**, and a **"View in registry"** deep-link to the provider's web UI (GHCR → `github.com/<owner>/<repo>/pkgs/container/…`, Docker Hub → `hub.docker.com/r/…`, GitLab → `…/container_registry`, Quay → `quay.io/repository/…`).
- Backend: `image:push:done` now carries the daemon's final `aux` (Tag/Digest/Size); the UI also parses the `…: digest: sha256:… size: …` status line as a fallback for daemons that don't emit `aux`.
- Verified e2e against a real registry: pushing `ghcr.io/…/dockgate:latest` streamed the push and rendered the card with the real digest, `2.2 KB` compressed size, and a working GHCR link; the host hint resolved `ghcr.io` vs `docker.io` correctly.
- This is **Phase A+B** of the [Registries full-plan](docs/) — next up (not yet built): richer Registries table (type/status/counts), per-registry **Browse** (tracked repos + auto-track-on-push), Dashboard registries card.

---

## [2.1.8] - 2026-06-21

### Added — Push images to a registry from the UI (live console)
- **Images** (Resources → Images) now has a **⤴ Push** action on every tagged image, and **Builds** has the same on each built image in history. It opens a "Push image to registry" modal: confirm/edit the **target reference** (to push a local image, change it to a full registry path — DockGate re-tags it for you first), then watch a **live progress console** stream the push layer-by-layer.
- The backend already supported push; this wires it to a **streaming Socket.io channel** (`image:push` → `pushImageStream` → `image:push:progress/done/error`) so progress is live, like builds. The credential is still **auto-matched by registry host** (no picker) — add it under **Servers → Registries** with write/push access. Every push is audit-logged.
- Verified e2e in a real browser: the Push button appears on tagged images, the modal pre-fills the image's ref, and clicking Push streams `Pushing… → The push refers to repository […] → digest: sha256:… → ✔ Pushed` into the console, with the button flipping to "Push again".

---

## [2.1.7] - 2026-06-21

### Added — Server Console shows its sub-tabs in the sidebar
- **Server Console** is now a collapsible sidebar section like the others: when you open a remote server's console, the sidebar shows its tabs as sub-items — **Overview · Setup · Manage · Logs** — and the active one is highlighted (two-way synced with the in-page tab bar). Clicking a sub-item jumps straight to that tab on the active server.
- Because the console needs a server, each sidebar item injects the **active remote server's id** automatically. With no remote server active yet, clicking Server Console (header or a sub-item) shows the hint "Add a remote server first — a console needs one" and takes you to **Servers**.
- Verified e2e: 4 sub-items render; with no active server → hint + redirect to Servers; with an active server → `server-console?id=…&tab=…`, section auto-expands and highlights the right sub-item; header click opens Overview.

---

## [2.1.6] - 2026-06-21

### Changed — Nav reshuffle: one "Servers" hub (Servers + SSH Keys + Registries); Cleanup → Activity
- **Infrastructure is now "Servers"** and hosts everything for connecting to hosts & registries in one place: **Servers · SSH Keys · Registries**. SSH Keys and Registries both moved out of Settings to sit next to Servers (they're all set-once connection/credential setup). This supersedes v2.1.5's "Registries → Settings".
- **SSH Keys** rendering was extracted from `settings.js` into a global `renderSshKeysInto()` (new `public/js/pages/ssh-keys.js`) so it can be embedded in the Servers section. All of its behavior is unchanged — generate (ed25519/RSA), import, copy public key, delete, the "How SSH keys work" explainer, encrypted-at-rest private keys.
- **Cleanup moved to the Activity section** (Logs · Terminal · Events · Files · Audit Log · **Cleanup**), out of Infrastructure. The Dashboard / host-monitor "Cleanup" links + the `#/cleanup` deep-link now point there.
- **Settings is app-config only** again: General · Notifications · Notification Log · Software Update · System · Security.
- Backward-compatible deep-links: `#/registries` → Servers ▸ Registries, `#/cleanup` → Activity ▸ Cleanup. Help text that said "Settings → SSH Keys" now says "Servers → SSH Keys".
- Verified e2e: sidebar groups (Servers = servers/sshkeys/registries; Activity = …/cleanup; Settings = 6 app tabs), SSH Keys Generate modal + list load in the new home, Registries + Cleanup render in their new homes, dashboard Cleanup button lands on Activity ▸ Cleanup. No functionality removed.

---

## [2.1.5] - 2026-06-21

### Changed — Registries moved from Infrastructure to Settings (next to SSH Keys)
- The **Registries** credential store now lives in **Settings → Registries** (the 8th tab, right after SSH Keys) instead of **Infrastructure → Registries**. Rationale: both Registries and SSH Keys are *credential vaults* you set once and DockGate uses automatically — grouping them together is more consistent than mixing Registries in with Servers/Cleanup. Infrastructure is now just **Servers + Cleanup**.
- Fully backward-compatible: the old `#/registries` deep-link now redirects to `#/settings?tab=registries`. The Registries page itself (add/edit/delete/Test login, encrypted-at-rest passwords, audit logging) is unchanged — only its location moved.
- Verified e2e: Infrastructure shows only Servers/Cleanup (sidebar + page tabs), Settings shows 8 tabs incl. Registries (sidebar sub-item highlights, table + "Add Registry" render inside Settings), and the legacy `#/registries` redirect lands on Settings.

---

## [2.1.4] - 2026-06-21

### Added — Collapsible sidebar sections (tabs as sub-items) + Server Console always visible
- **Sidebar sections are now collapsible.** Each tabbed section — **Resources** (Containers/Images/Builds/Volumes/Networks), **Deploy** (Compose/App Templates), **Activity** (Logs/Terminal/Events/Files/Audit Log), **Infrastructure** (Servers/Registries/Cleanup) and now **Settings** (General/Notifications/Notification Log/Software Update/System/Security/SSH Keys) — shows its tabs as **sub-items directly in the sidebar**. Clicking a section header opens its default tab and expands it; clicking a sub-item jumps straight to that tab. The active section auto-expands and its active sub-item is highlighted; the others collapse. A small caret (▸ → ▾) marks the expanded one.
- **In-page tab bars stay** — each section's page still has its own tab bar, and clicking an in-page tab now also moves the sidebar highlight (two-way sync via the hash). Bare section deep-links (e.g. `#/settings`) highlight the section's default sub-item to match what the page shows. Back/Forward and refresh stay in sync.
- **Settings is now a section too** — its 7 tabs appear as sidebar sub-items, consistent with the Docker/Server sections (previously Settings was a plain item whose tabs only showed inside the page).
- **Server Console is always visible** in the sidebar (Server group) — it was previously hidden until a remote SSH server was registered. Clicking it opens the active remote server's console; with no remote server yet it shows a hint ("Add a remote server first — a console needs one") and takes you to **Infrastructure → Servers** to add one.
- Verified end-to-end in a real browser: section expand/collapse, header→default-tab, sub-item→tab, in-page-tab→sidebar sync, bare-URL default highlight, Settings 7 sub-items, Server Console visibility + no-remote hint/redirect. No existing functionality removed.

---

## [2.1.3] - 2026-06-21

### Added — "How SSH keys work" explainer in Settings → SSH Keys
- The SSH Keys section now has a collapsible **"ⓘ How SSH keys work — generate / import / export / use"** guide explaining the whole flow: **① create** (Generate ed25519/RSA, or Import an existing private key — public key + fingerprint derived automatically), **② add the public key** to your Git host (one repo → Deploy keys, many repos → a machine-user account), **③ use it** in Deploy-from-Git (Auth = SSH key, SSH URL, Test key↔repo), and **export/security** (only the public key is copyable; the private key is never shown/downloadable — AES-256-GCM at rest, only a temp 0600 file during a deploy, then shredded, never leaves the server). Verified in a real browser

---

## [2.1.2] - 2026-06-21

### Reverted — View modal is plain again (no tabs)
- The "View services" modal dropped the **Overview / Source / Tools / Danger tab bar** — it's back to just showing the project: the **Git card** (repo · ⤓ Pull · ↻ Redeploy · webhook, for git projects) + **Working Directory / Config Files** + the **services table**. The Tools/Danger tabs were redundant now that Edit / Files / Terminal / Delete are visible buttons in the row again. Verified in a real browser: no tabs, services table + working dir/config show, git card's Pull/Redeploy still wired

---

## [2.1.1] - 2026-06-21

### Fixed — project Files browser is fast now (lazy, one folder at a time)
- The per-project **Files** modal was slow because it **recursively walked the whole project tree** over SFTP in one shot (a separate SSH round-trip per subfolder), happily descending into `node_modules`, `.git`, and runtime data-volume dirs (`postgres_data`, …) — thousands of round-trips. The standalone File Manager (Activity → Files) was fast because it lists **one folder at a time** (`listDir`); the project browser used the recursive `listTree`. Now the project Files modal uses the **same lazy, one-folder approach**: it lists only the current folder (a single `readdir`), you click into folders to go deeper, and an **⬆ Up** button + breadcrumb navigate — so it's fast even with a huge `node_modules` or data dir
- New `GET /compose/:project/dir?sub=<relpath>` (jailed to the project folder, traversal-guarded) backs it; Edit / Delete / + New file still work (now scoped to the current folder). DockGate's own `.dockgate-deploy.json` / `.dockgate-git.json` meta files are hidden from the browser. Verified end-to-end: top level lists folders without walking `node_modules` (800 files untouched), clicking `backend/` shows its `Dockerfile`, Up returns to root, and `../../etc` traversal is rejected

---

## [2.1.0] - 2026-06-21

### Versioning — moving to 2.1.x
- Jumped to **v2.1.0** to mark the milestone after the Compose-section redesign (tabbed Project hub, visible row actions, live-deploy banner, "+ Deploy ▾", git **UPDATE** badge) and the **change-aware Git redeploy** (pull → diff → deploy only what changed) + dedicated **⤓ Pull**, plus the **full remote File Manager**, **per-project Terminal**, and the **Slate blue-grey theme** for light & dark
- **New version scheme:** the patch number runs **0 → 99**, then rolls into the next minor — e.g. `2.1.0 → 2.1.1 → … → 2.1.99 → 2.2.0`

---

## [2.0.185] - 2026-06-21

### Reverted — Compose row actions are visible buttons again (the "⋯ More" menu felt more confusing)
- Per feedback, the per-project action buttons are back **visible in the row** (Up · Down · Restart · Rebuild · Update · Edit · Files · Terminal · View · Delete) instead of tucked behind a "⋯ More" dropdown — having to open a menu to reach them was more confusing, not less. All handlers are unchanged. The git-branch / **UPDATE** badges, the tabbed Project hub, the "+ Deploy ▾" dropdown, and the live-deploy banner all stay. Verified in a real browser: all nine row actions render and View still opens the hub

---

## [2.0.184] - 2026-06-21

### Added — "UPDATE" badge on git projects that have newer commits
- A git-managed Compose project now shows a small **UPDATE** badge next to its name in the list when its **repo has commits newer than what you last deployed** — so at a glance you know which projects are out of date and worth a Redeploy/Pull
- Backed by a cheap new `GET /compose/:project/git-status` — a `git ls-remote` (no clone) comparing the branch's remote HEAD to the recorded `deployedCommit`, **cached 5 minutes per project** so the list can poll it without hammering the remote (`?fresh=1` to force). The list checks each git row asynchronously after render. Verified end-to-end against a real repo: with the repo one commit ahead, `git-status` returns `behind:true` and the **UPDATE** badge appears on the row

---

## [2.0.183] - 2026-06-21

### Changed — "+ Deploy ▾" dropdown + collapsible Deploys (Phase 3 — Compose cleanup done)
- The three top buttons (New Project / Deploy from Git / Deploy from folder) are grouped into one **"+ Deploy ▾"** dropdown (New compose project · Deploy from Git · Deploy from folder), with **Refresh** alongside. The handlers are unchanged — same IDs, just tidier
- The bottom **Deploys** console is now **collapsible** (click the header to fold/unfold; state remembered in localStorage), with a count next to the title
- Verified end-to-end in a real browser: the dropdown opens with all three items and launches them (folder modal opens), and the Deploys header collapses/expands. This completes the Compose section cleanup (rows → Up/Down/⋯, tabbed Project hub, live deploy banner + global badge, deploy dropdown + collapsible) — **all without removing any functionality**

---

## [2.0.182] - 2026-06-21

### Added — live deploy process is now front-and-center (Phase 2.5 of the cleanup)
- **Prominent "Deploying…" banner** at the top of the Compose page whenever a deploy is in progress: a spinner, the **current step** ("docker compose up -d (2/3)"), a **live progress bar**, and a **👁 Watch** button that opens the live console. A running deploy is now impossible to miss — and it auto-surfaces deploys started anywhere (e.g. by a webhook), not just ones you click
- **Global "▶ N" indicator** on the **Deploy** nav item (sidebar), so a running deploy is visible **from any page**; clicking it lands on Compose where the banner + console are
- The bottom **Deploys** history table now shows an **inline progress bar** on running rows too
- All additive (polls the existing `/compose/deploy-jobs`); nothing else changed. Verified end-to-end in a real browser (mocked a running job): banner shows the step + progress + Watch, and the nav badge reads "▶ 1"

---

## [2.0.181] - 2026-06-21

### Changed — one tabbed "Project hub" modal instead of scattered modals (Phase 2 of the cleanup)
- Opening a Compose project (View services) now shows **one organized modal with tabs** — **Overview · Source · Tools · Danger** — so it's clear what a project can do, all in one place (no more "which modal has what?"):
  - **Overview:** status + services table + working dir/config files + quick **Up · Down · Restart · Rebuild**
  - **Source** (git projects): the repo line, **⤓ Pull**, **↻ Redeploy…**, and the auto-deploy webhook
  - **Tools:** **Edit YAML · Project files · Terminal** (these launch the existing, unchanged editors/browser/terminal — nothing was rewritten or removed)
  - **Danger:** **Delete project**
- All actions reuse the existing functions/handlers, so **no functionality was lost or changed** — just consolidated. Verified end-to-end in a real browser: all four tabs render, tab-switching works, the Source tab keeps Pull/Redeploy wired, and the Tools buttons launch their tools

---

## [2.0.180] - 2026-06-20

### Changed — Compose list rows decluttered: Up · Down · "⋯ More" menu (Phase 1 of the cleanup)
- Each Compose project row had **~10 buttons** crammed in. Now it's just **▶ Up · ⏹ Down · ⋯** — the rest (Restart, Rebuild, Update-from-folder, Edit YAML, Project files, Terminal, View services, Delete) moved into a tidy **"⋯ More" dropdown**. **Nothing was removed** — every action is still one click away, the row is just clean
- The menu is `position: fixed` so the table's horizontal scroll can't clip it; items keep their `data-*` attributes so **all the existing handlers fire unchanged** (verified: View opens the detail modal, Edit opens the editor, menu closes on item-click and on outside-click). Verified end-to-end in a real browser — no functionality lost

---

## [2.0.179] - 2026-06-20

### Added — "?" help for the build flags in the deploy picker
- Each stack's flag row in the **"Choose what to deploy"** picker now has a **"?" icon** that opens a short explainer for **build / no-cache / pull / no-deps** (what each does + when to tick it — e.g. *no-deps* = touch only the selected service, don't restart its dependencies, protects data). Each flag also got a **hover tooltip**. Verified in a real browser: the "?" renders per stack and opens the "Build flags — what they mean" modal

---

## [2.0.178] - 2026-06-20

### Added — a dedicated "⤓ Pull" button + a git badge in the compose list
- **"⤓ Pull" button** in a Git project's detail modal (next to Redeploy): pulls the latest and **shows exactly what changed** since your last deploy (the changed file list) **without deploying anything** — your running containers stay untouched. If there are changes, a **"↻ Deploy these…"** button takes you straight into the change-aware picker (reusing the same pull, no second clone). Closing the modal drops the staged clone
- **Git badge in the list:** git-managed compose projects now show a small **git-branch icon next to their name** (tooltip "Git-managed"), so you can tell at a glance which projects come from a repo. The "view" (eye) action is unchanged — it's for all projects
- Verified end-to-end against a real repo: the git badge renders next to the git project, **⤓ Pull** opens a modal listing `frontend/app.js` changed with "nothing was deployed — containers untouched" + a "Deploy these…" path

---

## [2.0.177] - 2026-06-20

### Added — change-aware Redeploy: pull → pick → deploy only what changed (no more rebuilding everything)
- **Redeploy no longer auto-rebuilds the whole project.** Clicking **Redeploy** now: pulls the latest → shows **what changed** → opens the **same "Choose what to deploy" picker** as the first deploy, but **pre-selects only the stack(s) whose files changed**. Unchanged stacks (e.g. a backend with its database) start **unticked → "no change · untouched"**, so their containers + data are never recreated. Tick/untick freely; the final call is yours
- **Pull-only is built in:** in that picker, **"Stage (deploy later)"** = pull the new files but **don't run anything** — then `Up` each stack from the list when you're ready. **"Deploy now"** = deploy just the selected stacks (`--no-deps`-friendly)
- Works the **same for Git and Folder** projects (reuses the shared picker + `deploy-folder-finish`); new `POST /:project/redeploy-prepare` clones with the project's stored creds, scans all compose files, and diffs against the last-deployed commit to map changed files → affected stacks
- Verified end-to-end against a real git repo (backend/ + frontend/ each its own compose): a frontend-only change → `redeploy-prepare` returns `affectedStacks: [frontend]` only; the browser picker opens with **frontend ☑ "● changed"** and **backend ☐ "no change · untouched"**. First redeploy after upgrading has no baseline yet → all stacks selected (baseline recorded for next time)

---

## [2.0.176] - 2026-06-20

### Added — git-branch icon on the project detail modal's Git card
- The **Git** line in a compose project's detail modal (opened via the "View Services" eye) now shows a small **git-branch icon** before the `repo @ branch` text, so the Git source is visually clear at a glance

---

## [2.0.175] - 2026-06-20

### Changed — light theme shifted toward soft sky-blue (less grey)
- Pushed the light surfaces from neutral grey-blue toward a clearer **sky-blue tint** (more blue, less grey): page `#e2e8f1 → #e0e9f6`, card/secondary `#e8edf5 → #e8eff9`, hover `#d9e4f4`, elevated/modal `#eff4fc`, sidebar/header glass `rgba(214,222,234,.9) → rgba(206,220,240,.92)`, sidebar var `#ccdcf0`. The blue channel now leads the red by ~22–34, so it reads blue rather than grey. Verified in a real browser: page `#e0e9f6`, sidebar `rgba(206,220,240,.92)`

---

## [2.0.174] - 2026-06-20

### Changed — light theme a touch deeper (calmer)
- Nudged the whole light palette ~3% deeper for a calmer feel: page `#e9eef5 → #e2e8f1`, card/secondary `#eef2f8 → #e8edf5`, hover `#dde4ee`, elevated/modal `#edf1f8`, sidebar/header glass `rgba(223,230,240,.88) → rgba(214,222,234,.9)`. Depth hierarchy kept (sidebar/header darkest → page → cards lightest); text and inputs unchanged. Verified in a real browser: page `#e2e8f1`, sidebar `rgba(214,222,234,.9)`

---

## [2.0.173] - 2026-06-20

### Changed — light theme: soften the still-too-white sidebar, header & cards
- The light **sidebar and header were still near-white** — they use `--glass-bg` (not `--bg-sidebar`), which was `rgba(248,250,252,0.85)`. Toned it to a soft slate `rgba(223,230,240,0.88)` so the sidebar/header read as gentle blue-grey panels, not bright white
- **Card surfaces toned down** too (the stat cards, etc.): `--bg-card`/`--bg-secondary` `#f8fafc → #eef2f8`, hover `#e5ebf3`, elevated/modal `#f2f5fa` (kept a touch lighter to pop above cards). Sidebar var `#dfe6f0`, header `rgba(223,230,240,0.85)`. Inputs stay white for clarity
- Net: nothing in light mode is bright white anymore — a calm, cohesive blue-grey with subtle depth (sidebar/header < page < cards). Verified in a real browser: sidebar/header `rgba(223,230,240,0.88)`, cards `#eef2f8`

---

## [2.0.172] - 2026-06-20

### Changed — light theme is now a soft blue-grey (Slate) too, no harsh white/black
- Reworked the **light theme** to match the new Slate family: **no pure white** anywhere and **no near-black text**, so it's far easier on the eyes. The page is a soft cool off-white (`#e9eef5`), card/modal surfaces are slate-50 (`#f8fafc`) — slightly lighter than the page for gentle depth — the sidebar a touch deeper (`#e3e9f1`), inputs stay white for clarity, text moves to slate tones (`#1e293b` / `#475569` / `#64748b`), and borders/glass pick up a slate tint. The blue accent (`#2563eb`) is unchanged. Light and dark now share one cohesive blue-grey look
- Verified in a real browser (forced `data-theme="light"`): page `#e9eef5`, text slate-800, soft and readable

---

## [2.0.171] - 2026-06-20

### Changed — dark theme is now a softer blue-grey (Slate), easier on the eyes
- Replaced the near-black, neutral dark palette with a balanced **blue-grey (Tailwind Slate)** one — a proper dark mode that isn't pure black, so it strains the eyes less. Main content is **slate-900 `#0f172a`**, the sidebar a touch darker (`#0b1120`) for subtle depth, card/modal/input surfaces **slate-800 `#1e293b`** family, and text shifts to slate tones (`#e2e8f0` / `#94a3b8` / `#64748b`). The blue **accent** (`#3b82f6`) is unchanged — Slate + Blue is a natural pair. Light theme untouched. Tunable lighter/darker/cooler on request

---

## [2.0.170] - 2026-06-20

### Changed — softer main content background (less eye strain)
- The main content area was near-black (`--bg-primary: #09090b`), which is harsh against light text. Lifted it **~3%** to `#101013` (rgb 9,9,11 → 16,16,19) so it's easier on the eyes. The **sidebar stays darker** (its own `--bg-sidebar` is unchanged) for a subtle, pleasant contrast; the light theme and other surfaces are untouched

---

## [2.0.169] - 2026-06-20

### Fixed/Changed — deploy log console: no more black screen on re-open, bigger + readable
- **Fixed the black screen.** Re-opening a *finished* deploy's "view log" used to show the log for a split second then go blank — the poll loop wrote the log, broke, and **immediately disposed the terminal**. Now the terminal is disposed **only when the modal is actually closed** (X / backdrop / Close), so a finished job's log stays on screen
- **Bigger, more readable console.** The modal is now wide (`min(1080px, 95vw)`) with a **58vh** terminal (was a narrow ~600px box with 44vh), slightly larger font, and 50k-line scrollback
- **New toolbar:** **⛶ Fullscreen** toggle (fills the viewport + refits), **⬇ Download** the whole log as `<project>-deploy.log`, and **📋 Copy** the log — so long logs are read/searched/saved instead of squinting
- Verified end-to-end in a real browser: re-opened a finished job → terminal stays alive (`#dl-term .xterm` present), log visible, modal 1080px, all three toolbar buttons present
- Note: logs still live in memory (30-min TTL, cleared on restart). **Persisting deploy logs to SQLite** (survive restart/TTL + a deploys history) is a separate follow-up

---

## [2.0.168] - 2026-06-20

### Added — redeploy now auto-shows what changed (which files were pulled)
- When you **Redeploy** a Git-managed compose project, the live console now **automatically prints what was pulled** — a `📦 Changes pulled (oldSHA → newSHA)` block listing the changed files (`✚ added · ✎ modified · 🗑 deleted`) plus a `N files changed, +X −Y` stat — **before** the deploy steps run. No extra button; it's part of the redeploy.
- How: each Git deploy now records the **deployed commit SHA** in the project's git metadata (`.dockgate-git.json` → `deployedCommit`). On the next redeploy DockGate clones the new HEAD, fetches the previously-deployed commit's tree, and runs `git diff --name-status` / `--shortstat` between them — streamed into the deploy log. Works for local **and** remote deploys (the diff is computed in DockGate's staging clone, independent of the deploy target), over both SSH-key and token auth.
- Graceful: the **first** redeploy after upgrading just records the baseline ("changed files will show from the next redeploy"); already-latest shows "nothing new pulled"; a force-push/rebase that removes the old commit falls back to a clear note. Best-effort — never blocks the deploy. This SHA tracking is also the foundation for a future **Rollback**.

---

## [2.0.167] - 2026-06-19

### Changed — update check runs every 5 minutes (was 24h)
- The sidebar **UPDATE** badge check now runs every **5 minutes** instead of once per 24 hours — both the `setInterval` and the localStorage cache TTL (`dcc_update_last_check`) were 24h, so both moved to 5 min. This makes the badge **self-heal within 5 minutes** after a transient GitHub fetch failure (which previously cached "no update" and hid the badge for a full day), and surfaces a freshly published version much sooner. (The silent-on-fetch-error behaviour still writes a transient "false" but now expires in 5 min, not 24h)

---

## [2.0.166] - 2026-06-19

### Changed — per-project Terminal moved to the row action buttons
- The **🖥 Terminal** (open a shell in the project's folder) is now a button **in the Compose list's action row** (next to Edit YAML / Files / View Services), not buried inside the detail modal — one click from the list. Same behaviour (interactive shell `cd`'d into the project's working dir on the active server); cwd comes from the row's `workingDir`

---

## [2.0.165] - 2026-06-19

### Added — File Manager UI: edit, copy/cut/paste, move, folder download, recursive delete, multi-select
- The **Files** page (Activity → Files) is now a real file manager on the remote SSH server:
  - **Clickable breadcrumb** instead of a bare path box
  - **Open / edit a file in place** — click a file (or ✎) → text editor modal → Save (binary/>2 MB → download instead)
  - **Copy / Cut / Paste** — per-row 📋/✂ or via multi-select; Paste lands in the current folder (copy = `cp -a`, cut = `mv`); pasting into a file's own folder auto-names `-copy`
  - **Move** — Cut a file/folder, navigate, Paste (cross-directory move)
  - **Download a whole folder** as `.tar.gz` (↓ on a folder); files download as before
  - **Recursive delete** — deleting a folder removes it **with all contents** (root-owned Docker data dirs handled via the root-container fallback), with a clear confirm
  - **+ File** to create a new (then editable) file; **multi-select** checkboxes + a bulk bar (Copy / Cut / Delete selected)
- Verified end-to-end against a real SSH server: backend ops (list/read/write/copy/move/recursive-delete/`.tar.gz`/`/`-guard — 8/8) and the browser UI (navigate, breadcrumb, open editor loads file content, copy→paste lands the item). Local-host file browsing is still the remaining gap (separate, needs a path jail)

---

## [2.0.164] - 2026-06-19

### Added — File Manager backend: copy, move, recursive delete (root-aware), edit, folder download
- Toward a **full** file manager, new SFTP/SSH backend operations + routes (`/api/files/*`):
  - **Read / Write** — `GET /read` + `POST /write` expose the existing `readFileText`/`writeFileText` so a file can be **opened and edited in place** (binary/oversized → metadata only, 2 MB cap)
  - **Copy** — `POST /copy` (`cp -a`, recursive + preserves attrs); pasting into a file's own folder auto-suffixes `-copy`
  - **Move** — `POST /move` (`mv -f`, works across directories)
  - **Recursive delete** — `DELETE ?recursive=1` removes non-empty folders; when **root-owned** Docker data dirs block the SSH user it falls back to a throwaway **root container** (`docker run --rm -v <parent>:/t alpine rm -rf`), guarded to ≥3-segment paths so a system/home root can never be wiped
  - **Folder download** — `GET /download-folder` streams a whole directory as a `.tar.gz`
- All shell ops reuse `remote-compose`'s `execRemote` + `shq` (single-quoted, injection-safe — verified). Frontend wiring (edit modal, copy/cut/paste, move, folder download, breadcrumb) lands next

---

## [2.0.163] - 2026-06-19

### Fixed — "Password field is not contained in a form" on Settings → Security
- The **Change Password** fields (current / new / confirm) were rendered loose on the page, so Chrome logged **"Password field is not contained in a form"** three times. They're now wrapped in a real `<form>` with a hidden `username` field (`autocomplete="username"`) so the browser's password manager can associate the change, and submit is handled in JS (`preventDefault`) so it never reloads. The earlier `showModal` form-wrap only covered modal fields; this was the one inline page form left

---

## [2.0.162] - 2026-06-19

### Added — per-project terminal: open an interactive shell right in a project's folder
- **Compose project detail modal now has a "🖥 Terminal (in this folder)" button.** Click it → an interactive shell opens **in that project's working directory** on the active server: remote project → SSH shell `cd`'d into the remote folder; local project → a PTY in the DockGate container `cd`'d into the working dir. So you can run `docker compose`, `ls`, `git`, edit files, etc. right where the project lives, instead of navigating there by hand
- Reuses the existing host-terminal socket channel (`hostterm:*`); `hostterm:start` now accepts an optional `cwd` — local validates it's a real dir (else falls back to home), remote `cd`'s into it on open with the path **single-quoted** so it can't break out of the command (injection-safe). Verified end-to-end through the real browser socket (pty starts in the target folder) + injection-safety of the remote `cd` quoting

---

## [2.0.161] - 2026-06-19

### Fixed — redeploy no longer wipes remote data, root-owned cleanup, DOM autocomplete warning
- **Remote redeploy no longer deletes the project folder first.** It used to `rm -rf` the remote folder for a "fresh" clone — but that folder holds the project's **runtime bind-mount data** (`./docker/volumes/postgres_data`, `caddy_data`, `redis_data`, …) created by containers running as **root**, so the delete (a) would have **destroyed live data** and (b) failed with `Permission denied` because the SSH user doesn't own those root-created files. Redeploy now re-uploads the source over the existing folder → **code changes land, runtime data survives, no permission error**
- **Explicit Delete / "Clean replace" now handle root-owned files.** When the SSH user can't `rm` a root-owned data dir, `removeRemoteDir` falls back to a throwaway **root Docker container** (`docker run --rm -v <parent>:/t alpine rm -rf …`) — the Docker daemon runs as root, so it removes what `sudo` would, without needing sudo
- **DOM warning gone:** every input/textarea/select inside a modal form now gets `autocomplete="off"` (side-effect of the earlier password-in-form fix — Chrome then warned "inputs should have autocomplete attributes" on fields like `#gd-rpath`). One line in `showModal` sets it on all fields lacking it

---

## [2.0.160] - 2026-06-16

### Changed — clearer deploy console (visual stepper) + honest webhook section
- **Deploy console is now a visual stepper:** each stage is a numbered/status circle (① pending → ● running, pulsing → ✓ done → ✗ failed) connected by a line, with the running step highlighted — so the sequence is obvious for both Git (`Clone → Transfer → Ensure network → Deploy stack(s)`) and folder (`Upload → Ensure network → Deploy stack(s)`), with the live terminal below
- **Webhook section is now honest + optional:** collapsed under "Auto-deploy webhook — optional", with a clear note that **manual Redeploy is the alternative**, and a **warning when the URL is localhost/LAN** ("GitHub can't reach it — needs a public URL"). So you know it won't fire on localhost, and that nothing auto-deploys unless you opt in

---

## [2.0.159] - 2026-06-16

### Added — "Stage (deploy later)" — upload/clone now, deploy when YOU click
- The "Choose what to deploy" picker (folder **and** Git) now has two buttons: **Deploy now** and **Stage (deploy later)**. **Stage** places the files (uploads to the server / promotes locally) and creates the networks, but **starts nothing** — each selected stack shows up in the Compose list as **down**, and you start it with **Up** (live console) whenever you're ready
- So nothing deploys "suddenly" — you control when each stack goes up, manually
- Backend: each selected stack is now **tracked even when not run** (per-stack deploy pointer, local or remote), the Compose list **merges down/staged local projects too** (not just remote), and `execComposeAction` resolves a staged local stack's working dir from its pointer. Verified live: staging returns `done`/`staged`, writes the per-stack pointer, runs nothing

---

## [2.0.158] - 2026-06-16

### Added — Git deploy is now the full folder-deploy experience (multi-stack picker)
- **Deploy from Git** no longer guesses a single compose file. It now: **clone → scan → "Choose what to deploy" picker** — exactly like Deploy from folder. You see every compose file in the repo and pick which one(s), which services, build/no-cache/pull/no-deps, reorder, and deploy **several as separate stacks** — all over the shared deploy pipeline (transfer to the chosen server folder + live console)
- Backend: new `POST /deploy-git-prepare` (clone into a staging session + scan) → the existing `POST /deploy-folder-finish` with the plan. `runDeployJob` writes the git metadata (repo + the deployed plan) so **Redeploy / webhook re-clone and re-apply the same multi-stack plan** (`gitRedeployJob`), with a fresh remote folder each time
- Verified live: prepare cloned a real multi-compose repo and scanned all 4 compose files; finish ran the plan through the pipeline with per-step status
- The old single-shot `deploy-git` + `deploy-git-scan` endpoints remain for API/back-compat; the UI now uses the unified flow

---

## [2.0.157] - 2026-06-16

### Added / Fixed — Git deploy target folder, live transfer progress, DOM password warning
- **Git deploy now lets you choose the server folder.** When a remote host is active, Deploy-from-Git shows a **Folder on the server** input + **📁 Browse** (just like Deploy-from-folder) instead of always using `~/.dockgate/projects/<project>` — so it deploys where you pick. `deploy-git` accepts `remotePath`
- **The SFTP transfer step now streams progress** (`uploaded X/N files`) for both Git and folder remote deploys, so a big upload no longer looks frozen / "lost in between"
- **Fixed the `[DOM] Password field is not contained in a form` warning** globally: every modal body is now wrapped in a (layout-neutral) `<form>` with submit suppressed, so password fields (Git token, registry, SSH passphrase, etc.) are in a form without Enter reloading the page

### Note
- Full **multi-stack Git deploy** (after scan, the "Choose what to deploy" picker with per-service/build selection and several stacks — exactly like folder deploy) is the next step; this release adds the target-folder + transfer visibility.

---

## [2.0.156] - 2026-06-16

### Added — Git deploy: scan the repo and pick which folder/compose to deploy
- Deploy-from-Git no longer makes you guess the **Subdir**. A new **🔍 Scan repo for compose files** button does an ephemeral shallow clone and lists **every** compose file in the repo (with its services + whether it builds); pick one and it sets the subdir for you — so monorepos / repos with multiple compose files are obvious instead of blind
- Backend `POST /compose/deploy-git-scan` (clones to a temp dir, scans with the same name-agnostic detector as folder deploy, then cleans up). Verified live: scanned a public repo and found all 4 compose files with their services
- (Full multi-stack git deploy — deploy several of the detected compose files as separate stacks, like folder deploy's "Choose what to deploy" — is a follow-up; this ships single-stack pick first.)

---

## [2.0.155] - 2026-06-16

### Added — live console for compose lifecycle actions (no more silent freeze)
- **Up · Pull · Build · Rebuild** (and **Git Redeploy**) on a compose project used to block on a spinner/toast with no feedback — a rebuild could churn for minutes silently. They now run as **background jobs with the same live console** as deploy: a step that goes `⏳ running → ✓/✗`, the real `docker compose` (and `git fetch`) output **streamed** into an xterm terminal, re-openable from **Deploys**, and survives closing the modal
- **Down / Restart** stay instant (toast) since they're fast
- Runtime-verified: the action endpoints return a job id, the job runs streamed and reports per-step status + errors. (Image pull on the Images page is a separate follow-up.)

---

## [2.0.154] - 2026-06-16

### Changed — "New Compose Project" is now self-explanatory
- The New Compose Project modal was unclear about what it actually does. It now opens with a one-line explainer: it **writes a docker-compose.yml from scratch and runs `docker compose up -d` on the active host** (named), the guided **+ Add a service** form **appends to the YAML**, and **the YAML box is what gets deployed** — with a pointer to use Deploy-from-folder / Git for existing projects
- Small label hints (project = the stack name; the YAML = what gets deployed). Edit/template modes are unchanged

---

## [2.0.153] - 2026-06-16

### Added — Git deploy now has a live console (per-step status + terminal)
- "Deploy from Git" used to just freeze on **"Cloning & deploying…"** with no feedback. Now it runs as a **background job** with the same **live console** as folder deploy: per-step status (**git clone → transfer to server → docker compose up**, each `· → ⏳ → ✓/✗`) and the real-time output in an **xterm.js terminal** — so you see the clone progress, the SFTP transfer, and the compose output as they happen, and can close the modal while it keeps running
- `git clone --progress` is **streamed** live (verified); the deploy survives closing the modal and is re-openable from **Deploys → view log**
- The auto-redeploy **webhook** is still created (copy it from the project ▸ details)

---

## [2.0.152] - 2026-06-16

### Added — "Test key ↔ repo" before deploying
- New **`POST /api/ssh-keys/:id/test`** + a **Test** button in the Git-deploy modal (SSH-key mode): runs `git ls-remote` with the selected key against the repo URL — no clone, no side effects — and tells you **"✓ repo reachable"** or **"key not authorized — add the public key"** so you confirm the key works *before* deploying
- Verified live against real GitHub: an unauthorized key is cleanly classified as auth-failed (and this proves the whole SSH-key transport — materialize → `GIT_SSH_COMMAND` → git-over-SSH — reaches GitHub correctly; an authorized key would clone)

---

## [2.0.151] - 2026-06-16

### Added — Git deploy via a stored SSH key + transfer-to-server (Model A)
- **Deploy from Git** now has an **Auth** selector: **SSH key (from the store)** or access token. Pick a named key (v2.0.149/150) and clone over SSH with `git@host:owner/repo.git` — no PAT pasted, no token in the URL. The key is materialized to a temp 0600 file only for the clone, then shredded; `keyId` (not a token) is stored in the project's git meta and reused for redeploy/webhook
- **Remote git deploy now transfers the files to the server (Model A):** when a remote SSH host is active, DockGate clones in its own container, **SFTPs the tree to the host, and runs `docker compose up` there** — so bind-mounts and build contexts resolve on the remote, fixing the old `DOCKER_HOST=ssh` path where the cloned files stayed on DockGate. Redeploy re-transfers + rebuilds. Local deploys are unchanged
- Backward compatible: token-based and public-repo deploys still work

> **Note:** the SSH-key clone + remote transfer are verified for the key-store mechanics (encrypted-at-rest, 0600, shred), syntax, and the SSH command shape — but the **end-to-end private-repo clone + transfer must be tested live** against a real private repo + remote server.

---

## [2.0.150] - 2026-06-16

### Added — SSH Keys management UI (Settings → SSH Keys)
- New **Settings → SSH Keys** tab to manage the named key store from v2.0.149: **Generate** a keypair (ed25519 / RSA-4096), **Import** an existing private key, **view/copy the public key** (with guidance — add to a machine account for many repos, or a single repo's Deploy Keys), and **delete**
- After generating/importing, the public key is shown immediately with a one-click Copy, so you can paste it into GitHub/GitLab/Gitea right away
- The private key is never shown or downloadable — only the public key + fingerprint
- Next: wire these keys into Git deploy (clone in DockGate → transfer to the server → deploy)

---

## [2.0.149] - 2026-06-16

### Added — named SSH key store (backend, Coolify "Private Keys" model)
- New reusable **SSH key store** so you create named keypairs once and reuse them (git deploy keys / machine-user keys for many repos) instead of pasting a token per project
- New module `server/ssh-keys.js` + `ssh_keys` table + `/api/ssh-keys` routes: **generate** (ed25519 default, rsa-4096 fallback — via `ssh-keygen`, so the key is in the OpenSSH format git/ssh need), **import** an existing private key (derives the public key), list, rename, delete
- **Security:** the private key is **AES-256-GCM encrypted at rest** (reuses `auth/secrets.js`), **never returned by the API** (only public key + fingerprint), and only ever written to a temp **0600** file during use, then **shredded** (overwrite + unlink). Verified end-to-end: ed25519 generates a usable key, stored as `enc:v1:…` (not plaintext), materialized at mode 600, shredded after
- The management UI + git-deploy-via-key (clone in DockGate → transfer to the server) land in the next releases

---

## [2.0.148] - 2026-06-16

### Added — per-service rebuild/update + reorder stacks in the deploy picker
- **Rebuild one service, not the whole project.** The Compose row **Rebuild** button now asks *which* services to rebuild (checkboxes from the project's services, all ticked by default). Picking a subset runs `docker compose up -d --build --force-recreate --no-deps <svc>` — so only that service is rebuilt+recreated and the others are left running, untouched (verified: the chosen service gets a new container, the rest keep the same one)
- **Same for Update-from-folder.** After re-uploading the folder, you choose which services to rebuild — re-upload everything, rebuild only what you picked
- Backend: `POST /compose/:project/rebuild?services=a,b` and the folder-update flow accept a service list (validated, safe charset, `--no-deps`)
- **Reorder stacks in "Choose what to deploy".** Each compose-file card now has ▲/▼ buttons — the deploy order (top → bottom) follows how you arrange them, so the "3 folders, deploy in my order" case is fully controllable

---

## [2.0.147] - 2026-06-16

### Fixed — three issues with remote folder-deployed projects + the action buttons

- **Edit Compose came back empty for remote projects.** `GET/PUT /compose/:project/file` only read DockGate's local managed dir — which for a remote folder-deploy holds just the `.dockgate-deploy.json` pointer, not the compose file (that lives on the server). Now both are **remote-aware**: the compose YAML is read/written **over SFTP on the server**, validated and (re)applied there — matching how the Files browser already worked
- **Files browser failed with "permission denied".** `listTree` aborted the whole listing the moment any subdirectory couldn't be read (a root-owned bind-mount dir, `.ssh`, etc.). It now **skips an unreadable subdirectory and keeps listing the rest** — one restricted folder no longer kills the browser. (If a project was deployed into a home directory like `/home/ubuntu` rather than a dedicated subfolder, re-deploy it to its own folder so the browser isn't walking the whole home dir.)
- **Action buttons overflowed/overlapped the status column.** The Compose row packs 9 actions (Up/Down/Restart/Rebuild/Update/Edit/Files/View/Delete) into `.td-actions`, which was `display:flex` with no wrap — so on narrower widths they spilled over and hid behind neighbouring cells. Added **`flex-wrap: wrap`** so they wrap cleanly instead

---

## [2.0.146] - 2026-06-16

### Added — in-app "?" help for folder deploy
- Clickable **"?" help badges** in the **Deploy from folder** modal and the **Choose what to deploy** picker open a full step-by-step **guide**: how upload works (local vs remote, the ~50 MB limit), what each picker option does (include/exclude, services, build / no-cache / pull / no-deps, stack name, external networks), the multi-stack "3 folders each with its own compose" flow, and tips (unresolved `${VAR}`, re-deploy, secret-handling caveat)
- No need to guess what a toggle does — click the badge and read it

---

## [2.0.145] - 2026-06-16

### Added — folder deploy: "Choose what to deploy" selection UI
- After you upload a folder, DockGate now **scans it and shows a picker** (instead of silently auto-running the first `docker-compose.yml`): every detected compose file is a card you can include/exclude, with **per-service checkboxes** (deploy all or just some), **build / no-cache / pull / no-deps** toggles, and an editable **stack name**
- **Multiple compose files = multiple stacks** — exactly the "I upload 3 folders, each with its own compose" case: each file deploys as its own project from its own directory, top → bottom, with **external networks created first** (collected from the scan, each with a create checkbox)
- The deploy runs through the live **per-step status + terminal** from v2.0.142–144, so you watch each network and each stack go green in order
- Update-from-folder is unchanged (re-uploads the existing remote project); cancelling the picker drops the staged upload

---

## [2.0.144] - 2026-06-16

### Added — folder deploy: scan for ALL compose files + a multi-stack deploy plan (backend)
- New **`POST /compose/deploy-folder-scan`**: after an upload, scans the whole staged tree (recursive, **name-agnostic** — any `*.yml`/`*.yaml` with a `services:` key, so `docker-compose.app.yml`, `infra/stack.yml`, etc. are found, not just the 4 standard names) and returns each compose file's **services, external networks, and whether it builds** (via `docker compose config --format json`). Skips `node_modules`/`.next`/`dist`/`.git`
- **`POST /compose/deploy-folder-finish`** now accepts an optional **`plan`**: `{ createNets[], stacks: [{ name, composeFile, services[], build, noCache, pull, noDeps }] }`. Each stack deploys as its **own compose project** from **its own directory** (so relative paths/build contexts resolve), with the chosen services + build flags, in order — answering "3 folders, each its own compose"
- External networks in `createNets[]` are **ensured (idempotent) before** the stacks come up, so `external: true` networks no longer fail the deploy
- Each plan step (`ensure network …`, `deploy <stack>`) is a tracked **status step** + streams live (builds on v2.0.142/143). Fully backward compatible — no `plan` → the existing single-compose auto-detect path is unchanged
- The selection **UI lands in the next release** (this is the backend)

---

## [2.0.143] - 2026-06-16

### Added — deploy console shows per-step status + a real terminal
- The re-openable **"view log"** (Deploys console) now renders the job's **per-step status** — `clean / upload / deploy`, each with a live `· pending → ⏳ running → ✓ done / ✗ failed` indicator — so you can see exactly **where** a deploy/update is, not just a phase word
- The log itself now renders in a real **xterm.js terminal** (instead of a plain `<pre>`), so docker's `\r` progress bars and ANSI colors display correctly instead of piling up as garbled lines; falls back to a `<pre>` if xterm isn't loaded
- The Deploys console row now shows a compact **step progress** count (e.g. `up (2/3)`)
- Builds on v2.0.142's live streaming — together: live, terminal-accurate output **with** step indicators

---

## [2.0.142] - 2026-06-16

### Fixed — deploy "view log" now streams live instead of freezing then dumping
- A folder deploy/update ran `docker compose up` with a **buffered** call (`execFileAsync` / SSH exec collected-then-returned), so the deploy console showed `Running docker compose up…` and then **nothing for the whole build** (looked frozen), then dumped the entire output at once at the end
- Compose output now **streams line-by-line into the job log as it arrives** (local via `spawn`, remote via the SSH exec `data` handler), so the existing log viewer shows build/pull progress live. The buffered path stays unchanged for every other caller (create/edit/git/up/down/restart)
- Backend also now tracks **per-step status** on each deploy job (`steps[]` = clean / upload / deploy, each `pending → running → done/failed`) and returns it from `GET /compose/deploy-job(s)` — the UI status indicators land in the next release

---

## [2.0.141] - 2026-06-13

### Fixed — cooldown 0 now means "alert on every occurrence" (consecutive events were dropped)
- Each alert rule has a per-event **cooldown** that suppresses repeats of the same event for the same container (anti-spam, so a crash-loop doesn't flood you). But **0 didn't actually disable it** — a chain of `|| 5` / `Math.max(1, …)` / `min="1"` turned 0 back into 5, so doing the same thing several times in a row sent only the first alert and silently dropped the rest
- Now **cooldown = 0 → no throttle, every occurrence is sent.** Fixed end-to-end: the monitor's throttle check (central + agent), the rules API (accepts 0), and the Alert Rules input (`min=0`, with a "0 = every" hint). Non-zero cooldowns still throttle exactly as before (verified)

---

## [2.0.140] - 2026-06-13

### Added — notifications for start / pause / unpause
- The monitor only watched die/restart/unhealthy, so **pause, unpause and start produced no alert**. Added three new rules — **Container Started**, **Container Paused**, **Container Resumed** — visible (and toggleable) under Settings → Notifications → Alert Rules
- **Container Started is debounced** (~3s) and cancelled by a following `restart`, so a `docker restart` is still a single "Restarted" alert — not Started + Restarted. Verified on a real daemon: start → 1, pause+unpause → 2, restart → 1
- Applied to both the central monitor and the agent. Note: *Container Started* fires on every container start (including each `docker run`/deploy), so it can be chatty — disable that one rule if you only want stop/crash/restart
- New rules auto-propagate to installed agents via the existing Save Rules → sync (v2.0.137)

---

## [2.0.139] - 2026-06-13

### Added — change the admin password from the UI
- New **Settings → Security → Change Password** (current + new + confirm). Until now the admin password could only be set once at first-run setup — there was no way to change it short of editing the database
- Backend `POST /api/auth/change-password` verifies the active session and the current password (scrypt), enforces the 8-char minimum, re-issues the session cookie so you stay logged in, and is rate-limited + audit-logged. Single-admin model unchanged (still one password, no usernames yet)

---

## [2.0.138] - 2026-06-13

### Fixed — a container restart is now ONE alert, not "Stopped" then "Restarted"
- `docker restart` emits `die → … → restart` (and an unresponsive container is SIGKILLed = exit 137), so a single restart used to arrive as **two** notifications: *Stopped/OOM* then *Restarted*. The `die` alert is now **debounced ~3s**; if a `restart` event for the same container follows, the die alert is cancelled and only **Restarted** is sent
- A real stop / crash / OOM (no restart follows) still alerts — just ~3s later. Fixed a race where the die handler's log-fetch ran before the debounce was registered (logs are now fetched lazily when the debounce fires, so the cancel is reliable)
- Applied to both the central monitor and the agent; **runtime-verified on a real daemon**: restart (graceful & SIGKILL'd) → 1 alert, plain stop → 1 alert

---

## [2.0.137] - 2026-06-13

### Added — central rule/channel changes now auto-propagate to installed agents
- Agents bake their rules + channel into env at deploy time, so a central edit didn't reach them until you manually re-pushed each one. Now **saving Alert Rules / SMTP / Telegram automatically re-pushes the new settings to every installed agent** (`POST /api/agent/sync` → reconfigures only the hosts that actually have an agent running) with a live progress modal. No per-agent clicks
- Silent when no agents are installed. So e.g. disabling **Container Unhealthy** centrally now takes effect on the agents too, not just the central SSH monitor

---

## [2.0.136] - 2026-06-13

### Fixed — notifier deploy modal now has a Close button + a clear finished state
- The "Notifier agent — deploy" log modal always shows a **Close** button (highlighted when the job ends), and the status line turns a bold **green ✓ Completed** / **red ✗ Failed** / **amber ⚠ Completed with errors** so it's obvious the deploy finished — previously the footer was empty and the status was a muted, easy-to-miss line

---

## [2.0.135] - 2026-06-13

### Fixed — notifier agent now installs with zero manual steps (runtime-tested)
- **DockGate auto-builds the agent image on first install** — if `dockgate/notifier-agent:1.0.0` isn't on a registry or DockGate's local daemon, the deployer builds it from the bundled `notifier-agent/` context, then ships it to the target via save→load over SSH. No more "image does not exist / build it first" — you never run `docker build` by hand
- **Agent runs as root** so it can read the host Docker socket. Runtime testing surfaced `EACCES /var/run/docker.sock` under the previous non-root `USER node` (the `node` user isn't in the host's `docker` group, which varies per host). The socket stays mounted read-only with `no-new-privileges` + memory/cpu caps and no published ports
- **Verified end-to-end on a real daemon:** image builds (251 MB), container starts, connects the Docker event stream (`/healthz` → 200 `streamConnected:true`), and a real container crash is classified and dispatched to the channel (the only failure in the smoke test was the dummy Telegram token, as expected)

---

## [2.0.134] - 2026-06-13

### Added — notifications now include the container's recent logs (the WHY)
- **Crash, OOM and Unhealthy alerts now carry the last ~40 lines of the container's logs** — so you can see *why* it failed without SSHing in. Email gets a dark "Recent container logs" block; Telegram appends a trimmed `<pre>` snippet. Logs are HTML-escaped, size-capped, and only fetched for failures (a clean exit-0 stop adds none)
- Applied to **both** the central monitor (`event-monitor.js`) and the on-host **agent** (`notifier-agent/`), kept byte-in-sync
- Note on "Container Unhealthy · Failing Streak N": this fires when the container's **Docker HEALTHCHECK** command fails N times in a row — the app may still serve traffic while the *healthcheck itself* is misconfigured (wrong port/path, missing curl/wget, too-short start period). The attached logs + the existing health-check output are there to diagnose exactly that

---

## [2.0.133] - 2026-06-13

### Changed — Edge Notifier: "Install on servers…" now lets you pick which servers
- The single **Install on servers…** button opens a server picker (checkbox list, with each server's current agent status + a "Select all"), so you choose exactly which servers to deploy to — instead of an all-or-per-row-only flow. Already-installed servers start unchecked. Installs the selected set via the existing `serverIds` fan-out

---

## [2.0.132] - 2026-06-13

### Added — Edge Notifier agent (outbound-only per-server notifications)
- **New `notifier-agent/` image** — a tiny, **outbound-only** container DockGate deploys onto each managed server. It mounts that host's `/var/run/docker.sock` **read-only**, watches the local Docker events, and sends alerts **directly** to Telegram/SMTP (the same channels you configured in DockGate). It's a faithful DB-free port of DockGate's own notification engine (`event-monitor`/`templates`/`telegram`/`mailer`), config injected as container ENV. **No inbound ports** (only a loopback healthcheck), works **behind NAT**, and keeps alerting even if DockGate is offline
- **Settings → Notifications → Edge Notifier** — a per-server table: **Install / Start-Stop / Update / Remove**, plus **Install on all servers** (fan-out with a live, re-pollable deploy log). Shown only when a channel is configured
- **Per-server channel override** — a different Telegram bot/chat or SMTP per host (or fall back to the global channel). Saving recreates that host's agent to apply the change. Stored encrypted at rest
- **One watcher per host, never two** — installing the agent on a host stops DockGate's central `EventMonitor` for it (no duplicate alerts); removing/stopping it resumes the monitor
- Backend: `/api/agent/*` (status/install/update/reconfigure/install-all/remove/power/job/channel), a per-host deployer (`createSshClient` → pull or airgapped save→load → recreate with the read-only-socket spec), and re-openable jobs (`agent_jobs`)

### Security
- **`smtp_config` secrets are now encrypted at rest** — the Telegram bot token and SMTP password join SSH/registry passwords under AES-256-GCM (`auth/secrets`). Decrypt-on-read, encrypt-on-write; idempotent and plaintext-safe, so existing configs keep working. Per-server channel overrides are encrypted too
- The agent runs non-root with `no-new-privileges`, a read-only Docker socket, memory/CPU caps and **no published ports**

---

## [2.0.131] - 2026-06-13

### Fixed — template logo proxy: fewer 400/502 console errors
- **Backend** (`/api/templates/logo`): the server-side fetch now sends a real browser **`User-Agent`** (and a broader `Accept`). Hosts that `403` a bare server fetch — Twitter/X CDN (`pbs.twimg.com`) and a few app sites — now serve their logo, so those **502s are recovered**
- **Frontend** (App Templates): `logoSrc()` now validates the logo URL with `new URL()` first and returns nothing for a **malformed entry** (e.g. a catalog logo like `https://].io/…`) — so DockGate no longer fires a doomed request that logged a **400**; the card falls back to the generic template icon instead
- Remaining 502s are genuinely unreachable third-party logos (404 / DNS / >8s timeout) and are still hidden cleanly by the `<img onerror>` handler — these are external-host issues, not a DockGate fault

---

## [2.0.130] - 2026-06-13

### Removed — Docker Swarm (entirely)
- **Docker Swarm support is fully removed** — no one was using it and it could not work for the common topology (a local/NAT'd manager that internet VPSes can't reach). Gone: the Deploy → **Swarm** tab and the whole swarm page (Services, Stacks, Nodes, Secrets, Configs, Initialize, Join-a-node), the **New Swarm Service** modal, and the cross-module "Deploy to Swarm" / "Deploy as Stack (Swarm)" handoffs in the Run modal, Images, Compose editor and App Templates
- **Backend:** removed the entire `/api/swarm/*` route module and all 23 swarm/service/node/stack/secret/config functions from `server/docker.js` (plus their exports and the swarm-only `getActiveServerHost` helper). Shared infrastructure (`createSshClient`, `getActiveServerId`, `buildCliEnv`, `invalidateCache`, the docker Proxy) is untouched — Compose, remote SSH hosts, provisioning and every other feature keep working
- **Files deleted:** `server/routes/swarm.js`, `public/js/pages/swarm.js`, `public/js/swarm-service-modal.js`. The overlay-network note on the Networks page was reworded to drop the Swarm framing (the `overlay` driver itself stays)
- Zero swarm remnants remain (`grep -ri swarm` over `server/` + `public/` is clean); all 40 pure-logic unit tests still pass and every edited file is syntax-clean

---

## [2.0.129] - 2026-06-13

### Added — tests for the new log/catalog logic + audit-coverage verified
- New unit tests: host-logs path/unit **validators** (injection + traversal rejection, `/var/log`-only), the **optional**-item flag (swap / docker-group), **alwaysRun** (System update), and that **SSH hardening is safe** (no `PasswordAuthentication`/`PermitRootLogin` disable, sets `MaxAuthTries`/`X11Forwarding`). **40 pure-logic tests** total (was 33)
- Verified that **every mutating server-management action is written to the audit log** — provisioning (start/finish), service start/stop/restart/enable/disable, config write, fail2ban/ufw ops, grant-docker, and server add/edit/delete/switch. No gaps (only the read-only connection test is, correctly, not audited)

---

## [2.0.128] - 2026-06-13

### Fixed — optional steps no longer nag as "missing" (swap, docker-group)
- **Swap** (an OOM safety net — most cloud VPSes ship without it) and **docker-group** (sudo-less `docker` convenience; pointless when you connect as root) are genuinely optional, but were shown perpetually as "missing" with a "Set up N missing →" nag — the same problem System update had
- They're now marked **optional**: rendered as "optional · not installed" (neutral), excluded from the missing count and the Needs-setup banner. Provisioning still installs them when a preset includes them (Full / Custom). If your "missing" item is a *required* one that's wrongly flagged, it's likely a passwordless-sudo detect issue — check the Components list

---

## [2.0.127] - 2026-06-13

### Improved — console Overview: zoned grid layout + auto-refresh (P4.15, P4.20)
- The Overview is now organised into clear **zones** instead of one long stack: a readiness banner on top, a **two-column row (Docker | Components)**, then the live host-metrics dashboard full-width below. Components render as compact rows (status icon + label + state) rather than a wall of cards — much tidier
- The **Docker counts auto-refresh every 30s** (self-terminating when you leave the view; skipped while a modal is open or you're typing); host metrics keep their own 5s tick. The readiness scan stays one-shot (slow + rarely changes)

---

## [2.0.126] - 2026-06-13

### Changed — SSH hardening is now lockout-proof (no password / root-login disable)
- "SSH hardening" no longer disables password authentication or root login — those lock out password-based servers (e.g. a default DigitalOcean root+password VPS) and were the feature's main footgun (a full adversarial review confirmed the lockout vectors). It now applies only **non-lockout** hardenings: `MaxAuthTries 3`, `LoginGraceTime`, `PermitEmptyPasswords no`, `X11Forwarding no`, and an idle timeout (`ClientAliveInterval`/`ClientAliveCountMax`)
- It runs on **key OR password** servers and can never cut your login; brute-force is covered by the fail2ban step. The drop-in **self-cleans** if `sshd -t` rejects it; detect/verify now key off our own directive (`MaxAuthTries 3`) so a partial/external state can't false-report; and RHEL gets the same directives as Debian. No longer `requiresKey`; risk downgraded to **low**. (Daemon start/stop/restart and the raw config editor in the Manage tab stay key-gated.)

---

## [2.0.125] - 2026-06-13

### Added — console Logs: view ANY log on the host (discovered)
- The Logs tab dropdown is no longer a fixed list of four. It now **discovers** and offers every **systemd service unit** (`journalctl -u`, e.g. fail2ban / docker / ssh) and every **file under `/var/log`** (`tail`, e.g. fail2ban.log / ufw.log / nginx), grouped under Services / Files — plus the curated System quick-picks (journald / kernel / auth / syslog / boot)
- `GET /:id/host/log-sources` discovers them; the read endpoint accepts `source` / `unit` / `file`. Unit names are validated to a no-metacharacter charset and file paths to a `/var/log`-only, no-traversal pattern before being used (injection-safe)

---

## [2.0.124] - 2026-06-13

### Improved — clearer selection in Setup (✓ badge instead of a faint checkbox)
- Selected items were marked only by a disabled native checkbox, which renders greyed/faint — you couldn't tell what was selected. Selected items now show an **accent ring + tinted background + a "✓ selected" badge** (under a preset, where selection is read-only); in **Custom** the checkbox is shown with an accent colour and stays interactive. The selection is now unmistakable

---

## [2.0.123] - 2026-06-13

### Improved — Setup presets show which items they install
- Selecting a preset (Just Docker / Secure baseline / Full) now **ticks and rings the exact component cards** that preset will install, so you see the selection before running — not just an opaque preset name. Items are read-only under a preset; switch to **Custom** to choose individually (the current ticks carry over as a starting point). The risky-steps confirmation reflects the ticked high-risk items

---

## [2.0.122] - 2026-06-13

### Fixed — server dropdown unreadable in dark mode
- The header server switcher's open dropdown showed its options on the OS-default (white) background — unreadable in dark mode, made worse by the select being transparent. The options now use the theme's card background + primary text colour, so the server list reads correctly in both dark and light themes

---

## [2.0.121] - 2026-06-13

### Changed — header server count + Infrastructure Servers/Add split into tabs
- The header server switcher now shows a **count badge** (total registered servers, with a remote breakdown in the tooltip) next to a wider, cleaner dropdown
- **Infrastructure → Servers** is now two tabs — **Servers (N)** (the list) and **+ Add SSH server** (the form) — so the add form no longer sits permanently open beneath the table. Both views stay in the DOM (visibility toggle), so the existing handlers keep working

---

## [2.0.120] - 2026-06-13

### Fixed — "System update" no longer shows as "missing"
- The **System update** step always read "missing" in the Setup / Overview scan because it has no detectable installed state — its `detect` is intentionally `false` so it always runs (you cannot idempotently detect a fully-upgraded system, new upgrades appear constantly). It is now marked as an **action** (`alwaysRun`) and shown as **"runs every time"** (neutral info badge), and excluded from the missing count. Provisioning still always runs it

---

## [2.0.119] - 2026-06-13

### Fixed — host metrics refresh in place (no full page rebuild every 5s)
- The live host monitor rebuilt its entire DOM subtree on every 5-second poll, which made the whole section flicker, jumped the scroll position and collapsed any expanded part on each refresh
- It now builds the structure **once** and on each tick only **updates the values in place** — KPI tiles (value + threshold colour), usage bars (width + colour + label), the System grid, network footer and the trend chart. Only the genuinely variable lists (open ports / disks / top processes) re-render, and each in its own isolated container. The page no longer flickers when metrics refresh

---

## [2.0.118] - 2026-06-13

### Changed — dashboard reflects the active server: host metrics + Docker (not just Docker)
- When the **active server** (header SRV dropdown) is a remote SSH host, the Dashboard now leads with that server's **host metrics** — CPU / memory / disk / swap / load / uptime, the trend chart, open ports and top processes — above the existing Docker overview. So the dashboard shows the *whole* active server (host + Docker), matching DockGate's server-management direction
- It shows **only the active server** (switch servers in the header to change it), not a fleet. Local stays Docker-only (host metrics need the `/proc` mount, deferred). Reuses the console's host monitor (its own 5s poll, self-terminating); the subtitle names the active server

---

## [2.0.117] - 2026-06-13

### Changed — nicer tabs everywhere (segmented control)
- The tab component (used by the consolidated sections, the server console, Infrastructure, Settings, Builds, Swarm, container detail, terminal…) was a small, flat underline. Redesigned as a **segmented control**: a rounded track with the active tab raised as a pill (accent text + card background + soft shadow), larger text (13.5px / 600 weight) and a subtle hover background
- `.tabs/.tab` and `.tab-bar/.tab-btn` now share a single definition, so every tab bar in the app looks consistent

---

## [2.0.116] - 2026-06-13

### Changed — sidebar consolidated: 17 entries → 7 (tabbed sections)
- The nine separate Docker sidebar items are now three **tabbed sections**: **Resources** (Containers / Images / Builds / Volumes / Networks), **Deploy** (Compose / App Templates / Swarm), **Activity** (Logs / Terminal / Events / Files / Audit). Sidebar is now **Overview** (Dashboard) · **Docker** (Resources / Deploy / Activity) · **Server** (Infrastructure / Server Console) · **System** (Settings) — keeping server-management visually balanced against Docker instead of buried under a 9-item list
- A generic `renderTabbedSection` wrapper hosts the existing page routes as tabs **without rewriting any page**: it invokes each route's handler into a sub-container, runs that handler's cleanup on tab switch, deep-links the sub-tab (`#/resources?tab=images`), and bumps the nav id on switch so the previous tab's pollers self-stop. Cross-section links and boot/restore remap onto the section + tab

---

## [2.0.115] - 2026-06-13

### Added — Docker resource counts in the console Overview (PHASE 4)
- The server console Overview now shows the remote server's **Docker** counts (Containers / Running / Images / Volumes / Networks) via `GET /api/servers/:id/docker/summary` (a per-server dockerode client — does not change the active server)
- Best-effort: a separate fetch with a 12s timeout that doesn't block the readiness + host-metrics view, and is omitted if the remote Docker isn't reachable

---

## [2.0.114] - 2026-06-13

### Added — monitoring insight bridges (PHASE 4)
- The host monitor now surfaces actionable insight cards from the live readings: **disk ≥ 85%** → click to open Docker Cleanup; **memory ≥ 90% with no swap** → click to open Setup (add a swap file); **CPU ≥ 90%** → points to the Top Processes table. Each turns a high reading into the next step

---

## [2.0.113] - 2026-06-13

### Added — Servers list enrichment + batched overview (PHASE 4)
- New `GET /api/servers/overview` — a **DB-only** batched snapshot (no SSH): each server's provisioning readiness (from the latest matrix) + its most recent stored host metric
- The Servers list (Infrastructure → Servers) now shows, per remote server, a **Readiness** badge (ready / needs setup / not scanned) and a **Health** mini-bar (CPU / MEM / DSK from the last sample) — fetched in one batched call alongside the list, so N servers cost one extra request

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
