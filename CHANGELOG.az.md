# Dəyişikliklər

---

## [1.5.0] - 2026-04-02

### Yeni Funksionallıqlar
- Avto-yeniləmə sistemi — GitHub-dan yeni commit-ləri yoxlayır, bir klikə git pull + npm install + server restart
- Settings səhifəsində "Software Update" bölməsi — cari versiya, gözləyən commit-lər və yeniləmə düyməsi
- README bütün yeni funksionallıqlar, API endpoint-ləri, WebSocket hadisələri ilə yeniləndi

### Texniki Dəyişikliklər
- `server/routes/settings.js` — `/meta/update/check` və `/meta/update/apply` endpoint-ləri əlavə olundu
- `public/js/pages/settings.js` — Software Update bölməsi əlavə olundu
- `README.md` — versiya badge, Builds/Settings təsvirləri, API reference, WebSocket docs yeniləndi

---

## [1.4.0] - 2026-04-02

### Yeni Funksionallıqlar
- Docker Image Build History-dən elementləri tək-tək silmək olur — siyahıdan gizlədir, əsl image silinmir
- Hər tarixçə kartında təsdiqləmə ilə silmə düyməsi

### Texniki Dəyişikliklər
- `server/db.js` — `hidden_docker_builds` cədvəli və əlaqəli statements əlavə olundu
- `server/routes/builds.js` — `/builds/docker-history/hide` POST və `/builds/docker-history/hidden` DELETE endpoint-ləri, docker-history gizlədilmiş image-ləri filtrləyir
- `public/js/pages/builds.js` — hər Docker history kartına silmə düyməsi əlavə olundu

---

## [1.3.0] - 2026-04-02

### Yeni Funksionallıqlar
- Build History indi Docker-in öz image build tarixçəsini göstərir — hər image bütün layer-ləri ilə siyahılanır, açılanda hər Dockerfile step-i, əmri və ölçüsü görünür
- Build Cache indi düz siyahı əvəzinə image adına görə qruplaşdırılır — description-dan image adı çıxarılır, mövcud image-lərlə uyğunlaşdırılır
- Backend `/builds/docker-history` endpoint-i — Docker API vasitəsilə hər image üçün real layer tarixçəsini alır
- Backend `/builds/cache` qruplaşdırılmış cache datası qaytarır

### Texniki Dəyişikliklər
- `server/routes/builds.js` — `/builds/docker-history` endpoint əlavə olundu, `/builds/cache` image adına görə qruplaşdırma ilə yenidən yazıldı
- `public/js/pages/builds.js` — Build History Docker image tarixçə kartları ilə, Build Cache yeni qruplaşdırılmış API ilə yeniləndi

---

## [1.2.0] - 2026-04-02

### Yeni Funksionallıqlar
- Builds səhifəsi Docker Desktop Builds görünüşünə uyğun yenidən dizayn edildi
- Build Detal 4 tab ilə: Info, Source/Error, Logs, History
- Info tab — build timing, cache istifadə barı, dependencies, tam konfiqurasiya, timeline
- Source tab — loqlardan Dockerfile step-ləri; xəta varsa Error tab
- Logs tab — açılıb-bağlanan step-lərlə List view + Plain-text view, kopyalama
- History tab — eyni image tag üçün keçmiş buildlər arası keçid
- Builders tab — aktiv buildx builder instance-ları
- Rəngləndirilmiş build loqları
- Build konfiqurasiyası DB-də saxlanılır (context_url, build_args, nocache, pull)

### Texniki Dəyişikliklər
- `public/js/pages/builds.js` — Docker Desktop stilində tamamilə yenidən yazıldı
- `server/routes/builds.js` — `/builds/builders`, `/builds/disk-usage` endpoint-ləri, `/builds/detail/:id`
- `server/db.js` — context_url, build_args, nocache, pull sütunları migration ilə əlavə olundu
- `server/index.js` — insertBuild tam konfiqurasiya saxlayır
- `public/css/components.css` — build-card, build-status-icon, build-log stilləri

---

## [1.1.0] - 2026-04-02

### Yeni Funksionallıqlar
- WebSocket ilə real-time build loqları olan Docker Image Build sistemi
- Build tarixçəsi DB-də saxlanılır
- Açılıb-bağlanan paketlərlə qruplaşdırılmış build cache
- Git repo URL, Dockerfile yolu, nocache və pull seçimləri ilə yeni build modal-ı
- Build dayandırma dəstəyi
- Build Cache API ayrı endpoint-lərə köçürüldü

### Düzəlişlər
- Port təkrarlanma problemi həll edildi — Docker API eyni portu IPv4 və IPv6 üçün iki dəfə qaytarırdı

### Texniki Dəyişikliklər
- `server/docker.js` — `buildImage()` stream funksiyası əlavə olundu
- `server/db.js` — `build_history` cədvəli əlavə olundu
- `server/routes/builds.js` — tarixçə və cache endpoint-ləri ilə yenidən yazıldı
- `server/index.js` — build streaming WebSocket hadisələri əlavə olundu
- `public/js/pages/builds.js` — 3 tab ilə yenidən yazıldı: Tarixçə, Cache, Canlı Build
- `public/js/pages/containers.js` — port deduplicate əlavə olundu
- `public/js/pages/container-detail.js` — port deduplicate əlavə olundu
- `public/js/router.js` — builds səhifəsi title əlavə olundu
- `public/css/components.css` — tab-bar, pulse, input stilləri əlavə olundu

---

## [1.0.0] - İlkin Buraxılış

### Funksionallıqlar
- Dashboard — sistem xülasəsi, ağıllı təkliflər və favoritlər
- Konteyner idarəsi — compose üzrə qruplaşdırma ilə
- Konteyner detalı — loqlar, terminal, statistika, portlar, volume-lar, şəbəkə, inspect
- Image, Volume, Şəbəkə idarəsi
- Compose Layihələri
- WebSocket ilə real-time loq və terminal
- Docker hadisə izləmə
- Sistem məlumatları və disk istifadəsi
- Təmizləmə alətləri
- Parametrlər, Favoritlər, Qeydlər, Etiketlər, Əməliyyat tarixçəsi
