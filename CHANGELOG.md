# Changelog

---

## [1.5.0] - 2026-04-02

### New Features
- Auto-update system — checks GitHub for new commits, one-click update with git pull + npm install + server restart
- Settings page now has "Software Update" section showing current version, pending commits, and update button
- README fully updated with all new features, API endpoints, WebSocket events

### Technical Changes
- `server/routes/settings.js` — added `/meta/update/check` and `/meta/update/apply` endpoints
- `public/js/pages/settings.js` — added Software Update section with check/apply UI
- `README.md` — updated version badge, Builds/Settings descriptions, API reference, WebSocket docs

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
