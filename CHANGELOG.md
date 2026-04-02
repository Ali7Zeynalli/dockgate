# Changelog

---

## [1.1.0] - 2026-04-02

### New Features
- Docker Image Build system with real-time log streaming via WebSocket
- Build history stored in database — view past build logs anytime
- Grouped build cache view — cache items grouped by parent relationship into expandable packages
- New build modal with Git repo URL, Dockerfile path, nocache and pull options
- Build cancel support
- Build Cache API separated to dedicated endpoints

### Bug Fixes
- Fixed duplicate port display in containers list and container detail — Docker API returns same port for both IPv4 and IPv6, now deduplicated

### Technical Changes
- `server/docker.js` — added `buildImage()` stream-based function
- `server/db.js` — added `build_history` table and prepared statements
- `server/routes/builds.js` — fully rewritten with history and cache endpoints
- `server/index.js` — added build streaming WebSocket events and disconnect cleanup
- `public/js/pages/builds.js` — fully rewritten with 3 tabs: History, Cache, Live Build
- `public/js/pages/containers.js` — port deduplication in table and card view
- `public/js/pages/container-detail.js` — port deduplication in Ports tab
- `public/js/router.js` — added builds page title
- `public/css/components.css` — added tab-bar, pulse animation, input styles

---

## [1.0.0] - Initial Release

### Features
- Dashboard with system overview, smart insights and favorites
- Containers management — list, filter, search, group by compose, start/stop/restart/remove
- Container detail — overview, logs, terminal, stats, environment, ports, volumes, network, inspect, history
- Images — list, pull, tag, remove
- Volumes — list, create, remove
- Networks — list, create, remove
- Compose Projects — project listing and service management
- Real-time log streaming via WebSocket
- In-container terminal via WebSocket exec
- Docker event monitoring in real-time
- System info, Docker version, disk usage
- Cleanup — prune stopped containers, unused images, volumes, networks
- Settings — theme, refresh interval, terminal shell, log options
- Favorites, notes and tags for resources
- Activity log for operation history
