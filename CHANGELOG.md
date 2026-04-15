# Changelog

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

---
---

# Dəyişikliklər

---

## [1.7.0] - 2026-04-02

### Yeni Xüsusiyyətlər
- **Təkmilləşdirilmiş Dashboard** — 7 yeni bölmə ilə tamamilə yenidən dizayn edildi
- **Konteyner Resurs Monitoru** — işləyən konteynerlər üçün real-time CPU və RAM istifadə çubuqları
- **Şəbəkə I/O** — hər konteyner üçün yükləmə/göndərmə trafik icmalı
- **Sağlamlıq Statusu** — healthy/unhealthy/no-healthcheck sayları doughnut chart ilə
- **İşləmə Müddəti & Yenidən Başlamalar** — konteyner uptime müddəti və restart sayı izləmə
- **Port Xəritəsi** — konteynerlərə bağlı bütün açıq portlar cədvəl şəklində
- **Ən Böyük Image-lər** — ən böyük Docker image-lərin vizual çubuq diaqramı
- **Sürətli Əməliyyatlar** — Hamısını Başlat / Hamısını Dayandır / Hamısını Yenidən Başlat düymələri
- **Commit əsaslı yeniləmə aşkarlaması** — yalnız versiya deyil, hər push yeniləmə bildirişi tetikləyir

### Texniki Dəyişikliklər
- `server/index.js` — dashboard API indi containerStats, healthStats, containerDetails, portMap, topImages qaytarır
- `public/js/pages/dashboard.js` — yeni bölmələr və Chart.js doughnut ilə tam yenidən yazıldı
- `Dockerfile` — yeniləmə aşkarlaması üçün COMMIT_SHA build arg
- `.github/workflows/docker-publish.yml` — Docker build-ə commit SHA ötürülür, lowercase image adı düzəlişi

---

## [1.6.0] - 2026-04-02

### Yeni Xüsusiyyətlər
- Versiya artıq hər yerdə `package.json`-dan oxunur — tək mənbə
- Sidebar-dakı versiya göstəricisi `/api/meta/version` endpoint-indən dinamik yüklənir
- HTML-də hardcoded versiya yoxdur

### Texniki Dəyişikliklər
- `server/routes/settings.js` — `GET /meta/version` endpoint əlavə edildi
- `public/js/app.js` — başlanğıcda API-dən versiya çəkir, sidebar-ı yeniləyir
- `public/index.html` — versiya placeholder dinamik yükləmə ilə əvəz edildi

---

## [1.5.0] - 2026-04-02

### Yeni Xüsusiyyətlər
- GHCR-dan (GitHub Container Registry) hazır Docker image ilə avto-yeniləmə sistemi
- Bir kliklik yeniləmə: yeni image çəkir və helper konteyner vasitəsilə avtomatik yenidən başladır
- Settings səhifəsində "Software Update" bölməsi: versiya müqayisəsi, dəyişikliklər siyahısı, yeniləmə düyməsi
- Yeni versiya mövcud olduqda sidebar-da "UPDATE" badge-i
- GitHub Actions CI/CD: hər versiya tag-ında Docker image build + push, köhnə untagged image-ləri təmizləyir

### Avto-Yeniləmə Necə İşləyir
- **Yoxlama**: `raw.githubusercontent.com` vasitəsilə yerli versiyanı GitHub `package.json` ilə müqayisə edir (rate limit yoxdur)
- **Tətbiq**: `ghcr.io/ali7zeynalli/dockgate:latest` pull edir → öz konteyner konfiqurasiyasını inspect edir → `docker:cli` helper konteyner yaradır → helper köhnə konteyneri dayandırıb yenisini eyni konfiqurasiya ilə işə salır
- **Əl ilə**: `docker compose pull && docker compose up -d`

### Texniki Dəyişikliklər
- `server/routes/settings.js` — tam yenidən yazıldı: dockerode ilə image pull + helper konteyner restart (köhnə git-based yanaşma əvəz edildi)
- `docker-compose.yml` — yerli build əvəzinə hazır GHCR image istifadə edir
- `.github/workflows/docker-publish.yml` — CI/CD: build, GHCR-a push, köhnə image-ləri təmizlə
- `public/js/pages/settings.js` — yeniləmə UI commit-lər əvəzinə changelog göstərir
- `public/js/app.js` — başlanğıcda + hər 24 saatda `checkForUpdates()`, localStorage cache
- `README.md` — quraşdırma və yeniləmə təlimatları yeniləndi (EN + AZ)

---

## [1.4.0] - 2026-04-02

### Yeni Xüsusiyyətlər
- Docker Image Build Tarixçəsindəki elementlər artıq tək-tək silinə bilər — əsl image-i silmədən siyahıdan gizlədir
- Hər tarixçə kartında təsdiq dialoqu ilə silmə düyməsi

### Texniki Dəyişikliklər
- `server/db.js` — `hidden_docker_builds` cədvəli və əlaqəli prepared statement-lər əlavə edildi
- `server/routes/builds.js` — `/builds/docker-history/hide` POST və `/builds/docker-history/hidden` DELETE endpoint-ləri
- `public/js/pages/builds.js` — hər Docker tarixçə kartına silmə düyməsi əlavə edildi

---

## [1.3.0] - 2026-04-02

### Yeni Xüsusiyyətlər
- Build Tarixçəsi artıq Docker-in öz image build tarixçəsini göstərir — hər image bütün layer-ləri ilə, genişləndirilə bilən Dockerfile addımları
- Build Cache elementləri düz siyahı əvəzinə image adına görə qruplaşdırılır
- Backend `/builds/docker-history` endpoint — Docker API vasitəsilə hər image üçün əsl layer tarixçəsi
- Backend `/builds/cache` qruplaşdırılmış cache datası ilə uyğun image məlumatı qaytarır

### Texniki Dəyişikliklər
- `server/routes/builds.js` — `/builds/docker-history` endpoint əlavə edildi, `/builds/cache` qruplaşdırma ilə yenidən yazıldı
- `public/js/pages/builds.js` — genişləndirilə bilən layer-lərlə Docker image tarixçə kartları

---

## [1.2.0] - 2026-04-02

### Yeni Xüsusiyyətlər
- Builds səhifəsi Docker Desktop stilində yenidən dizayn edildi
- Build Detalı 4 tab ilə: Məlumat, Mənbə/Xəta, Loglar, Tarixçə
- Məlumat tabı — build vaxt statistikası, cache istifadə çubuğu, asılılıqlar, tam konfiqurasiya, zaman xətti
- Mənbə tabı — loglardan Dockerfile addımları; build uğursuz olduqda Xəta tabı
- Loglar tabı — yığıla bilən addımlarla siyahı görünüşü + düz mətn görünüşü, kopyalama düyməsi
- Tarixçə tabı — eyni image tag üçün əvvəlki build-lər
- Builders tabı — aktiv buildx builder nümunələri
- Rəngləşdirilmiş build logları
- Build konfiqurasiyası verilənlər bazasında saxlanılır

### Texniki Dəyişikliklər
- `public/js/pages/builds.js` — Docker Desktop stilində tab-larla tamamilə yenidən yazıldı
- `server/routes/builds.js` — builders, disk-usage, detail route-ları əlavə edildi
- `server/db.js` — context_url, build_args, nocache, pull sütunları əlavə edildi

---

## [1.1.0] - 2026-04-02

### Yeni Xüsusiyyətlər
- WebSocket vasitəsilə real-time log axını ilə Docker Image Build sistemi
- Build tarixçəsi verilənlər bazasında saxlanılır
- Genişləndirilə bilən paketlərlə qruplaşdırılmış build cache görünüşü
- Git repo URL, Dockerfile yolu, nocache və pull seçimləri ilə yeni build modalı
- Build ləğv dəstəyi
- Build Cache API ayrıca endpoint-lərə ayrıldı

### Xəta Düzəlişləri
- Təkrarlanan port göstəricisi düzəldildi — Docker API eyni portu IPv4 və IPv6 üçün qaytarır, artıq deduplikasiya edilir

### Texniki Dəyişikliklər
- `server/docker.js` — stream əsaslı `buildImage()` funksiyası əlavə edildi
- `server/db.js` — `build_history` cədvəli və prepared statement-lər əlavə edildi
- `server/routes/builds.js` — tarixçə və cache endpoint-ləri ilə yenidən yazıldı
- `server/index.js` — build streaming WebSocket hadisələri əlavə edildi
- `public/js/pages/builds.js` — 3 tab ilə yenidən yazıldı: Tarixçə, Cache, Canlı Build
- `public/js/pages/containers.js` — cədvəl və kart görünüşündə port deduplikasiyası
- `public/js/pages/container-detail.js` — Portlar tabında deduplikasiya
- `public/js/router.js` — builds səhifə başlığı əlavə edildi
- `public/css/components.css` — tab-bar, nəbz animasiyası, input stilləri əlavə edildi

---

## [1.0.0] - İlk Buraxılış

### Xüsusiyyətlər
- Dashboard: sistem icmalı, ağıllı təhlillər və favoritlər
- Konteyner idarəetməsi: compose üzrə qruplaşdırma
- Konteyner detalı: loglar, terminal, statistika, portlar, volumlar, şəbəkə, inspect
- Image, Volume, Şəbəkə idarəetməsi
- Compose Layihələr
- WebSocket vasitəsilə real-time log axını və terminal
- Docker hadisə monitorinqi
- Sistem məlumatı və disk istifadəsi
- Təmizləmə alətləri
- Parametrlər, Favoritlər, Qeydlər, Etiketlər, Fəaliyyət jurnalı
