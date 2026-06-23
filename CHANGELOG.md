# Changelog

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
