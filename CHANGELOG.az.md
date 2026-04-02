# Dəyişikliklər

---

## [1.1.0] - 2026-04-02

### Yeni Funksionallıqlar
- WebSocket vasitəsilə real-time build loqları ilə Docker Image Build sistemi
- Build tarixçəsi verilənlər bazasında saxlanılır — istənilən vaxt keçmiş build loqlarına baxmaq olur
- Qruplaşdırılmış build cache görünüşü — cache elementləri Parent əlaqəsinə görə açılıb-bağlanan paketlər halında göstərilir
- Yeni build modal-ı — Git repo URL, Dockerfile yolu, nocache və pull seçimləri
- Build dayandırma dəstəyi
- Build Cache API ayrı endpoint-lərə köçürüldü

### Düzəlişlər
- Konteyner siyahısında və konteyner detalında portların təkrar göstərilməsi problemi həll edildi — Docker API eyni portu IPv4 və IPv6 üçün iki dəfə qaytarırdı, indi deduplicate olunur

### Texniki Dəyişikliklər
- `server/docker.js` — `buildImage()` stream əsaslı funksiya əlavə olundu
- `server/db.js` — `build_history` cədvəli və prepared statements əlavə olundu
- `server/routes/builds.js` — tarixçə və cache endpoint-ləri ilə tamamilə yenidən yazıldı
- `server/index.js` — build streaming WebSocket hadisələri və disconnect cleanup əlavə olundu
- `public/js/pages/builds.js` — 3 tab ilə tamamilə yenidən yazıldı: Tarixçə, Cache, Canlı Build
- `public/js/pages/containers.js` — cədvəl və kart görünüşündə port deduplicate əlavə olundu
- `public/js/pages/container-detail.js` — Portlar tab-ında port deduplicate əlavə olundu
- `public/js/router.js` — builds səhifəsi üçün title əlavə olundu
- `public/css/components.css` — tab-bar, pulse animasiyası, input stilləri əlavə olundu

---

## [1.0.0] - İlkin Buraxılış

### Funksionallıqlar
- Dashboard — sistem xülasəsi, ağıllı təkliflər və favoritlər
- Konteyner idarəsi — siyahı, filtr, axtarış, compose üzrə qruplaşdırma, start/stop/restart/remove
- Konteyner detalı — icmal, loqlar, terminal, statistika, mühit dəyişənləri, portlar, volume-lar, şəbəkə, inspect, tarixçə
- Image-lər — siyahı, pull, tag, silmə
- Volume-lar — siyahı, yaratma, silmə
- Şəbəkələr — siyahı, yaratma, silmə
- Compose Layihələri — layihə siyahısı və servis idarəsi
- WebSocket vasitəsilə real-time loq izləmə
- WebSocket exec ilə konteyner daxili terminal
- Docker hadisələrinin real-time izlənməsi
- Sistem məlumatları, Docker versiyası, disk istifadəsi
- Təmizləmə — dayandırılmış konteynerlər, istifadə olunmayan image, volume, şəbəkə
- Parametrlər — tema, yeniləmə intervalı, terminal shell, loq seçimləri
- Resurslar üçün favoritlər, qeydlər və etiketlər
- Əməliyyat tarixçəsi
