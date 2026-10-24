# HELIX PHASE 21.3 — DEPLOYED & VERIFIED

گزارش نهایی تولید، ۲۴ اکتبر ۲۰۲۶. نتیجهٔ آزمون مستقل از خارج VPS: [Chromium احراز هویت‌شده](https://github.com/hamidrezab971-stack/helix/actions/runs/40050603850) موفق. بررسی کد، قواعد هشدار و مرورگر ناشناس نیز در [CI زیرساخت](https://github.com/hamidrezab971-stack/helix/actions/runs/40050609050) موفق‌اند. داده‌های این گزارش از اندازه‌گیری تازه استخراج شده‌اند.

۱. سلامت HELIX: دامنهٔ اصلی و `/api/health` سالم‌اند. ورود عادی با CAPTCHA واقعی، نشست مرورگر، WSS، تحویل پیام به مرورگر دوم، بارگذاری و دریافت تصویر، رد تصویر نامعتبر و تاریخچه پس از refresh روی تولید موفق بود. از دو حساب آزمایشی موجود استفاده شد؛ هیچ حساب پیام‌رسان بازایجاد نشد. هش شناسه‌ها و رمزهای کاربران قبلی و SHA-256 هر ۷ فایل upload قبلی تغییر نکرده؛ integrity و foreign-key بررسی SQLite موفق است. تعداد پیام‌ها از ۱۸ به 29 رسید؛ افزایش مربوط به آزمون است و پیامی حذف نشد.

۲. Grafana: [نشانی مرورگر](https://helix.localip.ir/grafana/) از اینترنت و TLS معتبر کار می‌کند. کاربر ناشناس و اعتبارنامهٔ نادرست رد می‌شوند؛ root_url، subpath، JavaScript/CSS، API، refresh و نبود حلقهٔ redirect بررسی شده‌اند. هر سه داشبورد، ۲۶ پنل و ۳۰ عبارت در هر سه حالت مدیر دسکتاپ، Viewer دسکتاپ و Viewer با شبیه‌سازی Android بررسی شدند. queryها پس از refresh دوباره دادهٔ متناهی تولید کردند؛ Active alerts در نبود هشدار می‌تواند تهی باشد.

۳. Prometheus: [نشانی مدیر](https://helix.localip.ir/prometheus/) فقط اعتبارنامهٔ edge مدیر را می‌پذیرد. Viewer حتی با رمز معتبر خودش 401 می‌گیرد. Query browser واقعاً `up` را اجرا کرد و هر سه target مقدار ۱ داشتند؛ صفحهٔ targets و runtime/build status نیز محتوای واقعی نشان دادند. `external-url=https://helix.localip.ir/prometheus/` و `route-prefix=/` هستند. lifecycle/admin API غیرفعال است و درخواست‌های غیر GET/HEAD عمومی رد می‌شوند.

۴. احراز هویت و اختیار: دو رمز مستقل برای Nginx و ورود بومی Grafana استفاده می‌شود؛ این معماری MFA نیست. حساب `helix-stakeholder` نقش Viewer و حساب مدیر نقش Admin دارد. ساخت سازمان، ثبت‌نام و ویرایش توسط Viewer غیرفعال‌اند. حذف داشبورد موقت، تغییر datasource موقت، مدیریت کاربران و نوشتن قواعد هشدار با Viewer، 403 گرفتند. محتوای تأییدشده برای آزمون مخرب استفاده نشد و اشیای موقت پاک شدند؛ دقیقاً سه داشبورد و یک datasource باقی مانده است.

۵. تحویل امن: `/etc/helix/monitoring-handoff/stakeholder.json` آماده است؛ فایل 0600 و پوشهٔ 0700 با مالک root دارد. مسئول مجاز باید فقط اعتبارنامهٔ ذی‌نفع را از کانال خصوصی تأییدشده یا password manager تحویل دهد. پس از تحویل، ذی‌نفع `/monitoring/` را در Chrome باز می‌کند، رمز edge را در گفت‌وگوی مرورگر و رمز مستقل Grafana را در فرم ورود وارد می‌کند؛ SSH، Termux و tunnel لازم نیست. فایل مدیر نباید به ذی‌نفع تحویل شود. تحویل به شخص انجام‌شده فرض نشده است. اسرار موقت CI پس از آزمون حذف و نبودشان تأیید شد.

۶. معیارها و محتوا: هویت فرایند برنامهٔ واقعاً در حال اجرا با سری Prometheus مطابقت داده شد. host CPU، حافظه، دیسک، شبکه، درخواست/خطا/تأخیر API، WebSocket، تحویل پیام و نتایج upload دادهٔ تولید دارند. تمام فایل‌های سه داشبورد نسبت به main اولیه بایت‌به‌بایت حفظ شده‌اند. datasource خصوصی `http://prometheus:9090` است؛ دادهٔ mock یا staging استفاده نشد. ترافیک آزمایشی روی تولید، از جمله upload نامعتبر، در معیارهای واقعی منعکس می‌شود.

۷. Live و نشست: WSS و پاسخ پروتکل Grafana Live برای مدیر و Viewer، شامل Android، موفق‌اند. کوکی دارای Secure، HttpOnly، SameSite=Lax و مسیر `/grafana` است. بازپخش نشست باطل‌شده در سرور و انقضای کوکی در مرورگر هر دو رد شدند؛ درخواست تازه به داشبورد به صفحهٔ ورود رفت و ورود دوباره موفق بود. مدت کامل انقضای چندروزهٔ سرور انتظار کشیده نشد. TLSv1.3 و اعتبار گواهی تا ۱۵ ژانویهٔ ۲۰۲۷ بررسی شد.

۸. Docker: چهار کانتینر تولید healthy هستند. شناسهٔ کانتینر، تصویر و mountهای HELIX، Grafana و Node Exporter تغییر نکرده‌اند. تصویر و volumeهای Prometheus نیز حفظ شدند؛ این سرویس برای flags وب و بازگشت‌های ایمنی بازایجاد شد، با وقفهٔ کوتاه و موجه در چند scrape. در اصلاح آخر فقط Nginx بسته و باز شد و collection ادامه داشت. تصویر Grafana همان مرجع وصله‌شدهٔ زیر است؛ build یا تعویض برنامه انجام نشد:
`ghcr.io/hamidrezab971-stack/helix-grafana@sha256:1386cfea0081497a6608e5947f208bf7d8e91cd180293eab75d01dd69b75a5d9`.
امضای runtime افزونهٔ Prometheus `valid / grafana` بود. اسکن تازهٔ image در این فاز ادعا نمی‌شود؛ تصویر تأییدشده حفظ و gateها تضعیف نشدند.

۹. دیسک: دیسک مجازی 64,424,509,440 بایت، معادل 60GiB است. filesystem ریشهٔ ext4 ظرفیت 61,285,326,848 بایت دارد. قبل از کار: مصرف 54,109,913,088 و آزاد 7,158,636,544 بایت، معادل 11.681٪. پس از کار: مصرف 48,443,781,120 و آزاد 12,824,768,512 بایت، معادل 20.926٪. inode مصرف‌شده 849,646 از 7,733,248 است. هدف حداقل ۲۰٪ آزاد محقق شد و برای رسیدن به این هدف افزایش ظرفیت لازم نشد.

۱۰. بازیابی امن فضا: افزایش خالص فضای آزاد filesystem برابر **5,666,131,968 بایت**، تقریباً 5.666GB است. این عدد اندازه‌گیری واقعی قبل/بعد است؛ به علت hard link، جمع اندازهٔ نام‌های حذف‌شده فضای فیزیکی بازیابی‌شده محسوب نمی‌شود. فقط پنج نام فایل DB اسکن تکراری پس از تطبیق SHA-256، حفظ نسخهٔ یکسان و بررسی عدم استفاده، و ۵۱۲ فایل zip کش دانلود ماژول Go دارای فایل ziphash و بدون build فعال حذف شدند. فهرست دقیق ZIPها و هش گزارش در میزبان حفظ است. سورس بازشده، go.sum، ziphash، نتایج اسکن، تمام تصاویر، volumeها، آرشیوهای release و دادهٔ زنده حفظ شدند؛ prune عمومی، volume prune، حذف پیام یا upload و vacuum لاگ انجام نشد.

فایل‌های DB حذف‌شده فقط این موارد بودند:

- `/root/helix-phase21.2.1/host-20261021/security-delivery/scan/cache/db/trivy.db`
- `/root/helix-cutover-20261021/security-final/scan/cache/db/trivy.db`
- `/root/helix-cutover-20261021/security-current/scan/cache/db/trivy.db`
- `/root/helix-phase21.2.1/host-20261021/security-ecr/scan/cache/db/trivy.db`
- `/root/helix-qualification-20261020/security/cache/db/trivy.db`

ZIPها فقط در `/root/helix-phase21.2.1/host-20261021/go-cache-grafana/pkg/mod/cache/download/` بودند؛ فهرست دقیق و عملیات unlink پیش از حذف در `go-download-cache-cleanup.json` ثبت شد. نسخهٔ یکسان DBها در مسیرهای `security-final-host` و `security-patched-exporter` حفظ شد. ۷۳ فایل tar در مجموعهٔ release بررسی‌شده، شامل ۵۸ inode مستقل و مجموع منطقی 3,438,155,866 بایت، حفظ شدند.

| محل مصرف | اندازهٔ تخصیص‌یافتهٔ نهایی، بایت |
|---|---:|
| `/var/lib/docker/volumes/helix-production_grafana_data/_data` | 1,732,608 |
| `/var/lib/docker/volumes/helix-production_prometheus_data/_data` | 27,721,728 |
| `/var/lib/helix-docker/data/uploads` | 98,304 |
| `/var/log/journal` | 80,949,248 |
| `/tmp` | 9,863,168 |
| `/root/helix-grafana-host-20261023T205337Z/publication` | 718,401,536 |
| `/opt/helix/releases` | 2,534,735,872 |
| مجموع پوشه‌های لاگ کانتینرهای فعال | 806,912 |

Docker در بررسی اولیه ۲۱ image با اندازهٔ گزارش‌شدهٔ 10.47GB و build cache برابر 3.47GB داشت؛ cache شامل 3.417GB اشتراکی و فقط 53.53MB خصوصی بود و prune نشد. مصرف اصلی اضافی، cacheهای قدیمی ساخت و DBهای تکراری اسکن بود. `/boot` و EFI کمبود ظرفیت ندارند. گزارش byte-level و manifest پاک‌سازی در `/root/helix-phase21.3/` موجود است.

۱۱. هشدار و retention: warning فضای آزاد ریشه زیر ۲۰٪ و critical زیر ۱۵٪، هر دو برای ۱۰ دقیقه، از `node_filesystem_avail_bytes / node_filesystem_size_bytes` واقعی محاسبه می‌شوند. آزمون promtool برای warning، critical، بازیابی و حذف tmpfs موفق بود؛ در بررسی نهایی هشداری firing نبود. اعلان خارجی جدید اضافه نشد. Prometheus مقدار 15d یا 2GiB، همراه با سربار معمول WAL/head، دارد. Docker از قبل local با 10MB × 3 بود؛ journald اکنون 256MB/۳۰ روز و keep-free برابر 2GB دارد؛ شواهد موجود حذف نشدند.

۱۲. Nginx: مسیرهای پیام‌رسان حفظ شدند. root_url، headerهای Host/Proto/Prefix، حذف Authorization پیش از upstream، cookie flags، Live و subpath صحیح‌اند؛ HTTP به HTTPS با 308 می‌رود. rate limit ورود POST برابر ۶ در دقیقه با burst=12 و درخواست‌های مانیتورینگ ۲۰ در ثانیه با burst=100 است. پاسخ 429 واقعاً آزموده شد. پیش از reload، syntax بررسی می‌شود و پیش از پذیرش، سه اتصال TLS تازه سیاست worker جدید را تأیید می‌کنند. [راهنمای Grafana](https://grafana.com/tutorials/run-grafana-behind-a-proxy/) و [flags رسمی Prometheus](https://prometheus.io/docs/prometheus/latest/command-line/prometheus/) مبنای رفتار مسیرها هستند.

۱۳. یافتهٔ امنیتی اصلاح‌شده: Viewer ابتدا از `/grafana/api/datasources/.../resources/` و `/proxy/` می‌توانست APIهای مدیریتی و metrics پرومتئوس را بخواند، هرچند `/prometheus/` رد می‌شد. این مسیر غیرمستقیم بسته شد؛ فقط query و metadata ضروری برای نمودار مجاز است. configuration، runtime، targets، federation، metrics و mutationها از آن مسیرها 404 می‌گیرند. مسیر خام باید با URI نرمال‌شده تطابق داشته باشد تا اختلاف decode و مسیرهای encoded/traversal دورزن نباشد. فایل اسرار bearer در پیکربندی به شکل مسیر فایل است؛ افشای مقدار رمز یا token در پاسخ‌های آزموده‌شده مشاهده نشد. exporterها روی اینترنت قابل اتصال نیستند و endpointهای خام عمومی بسته‌اند.

۱۴. شواهد آزمون: ۱۵۲ بررسی Nginx ایزوله؛ ۸۴ بررسی HTTPS تولید، شامل نام کاربری معتبر با رمز نادرست و بررسی نشت مقدار محرمانه؛ ۲۰ آزمون ایمنی داده؛ ۱۱ آزمون gate امنیتی؛ ۴ آزمون واقعی metrics/ASGI؛ و آزمون‌های promtool موفق‌اند. Chromium خارجی 156.0.8078.4 برای مدیر و Viewer دسکتاپ و Viewer Android هر کدام ۳ داشبورد/۲۶ پنل/۳۰ query، refresh، Live و نشست را بررسی کرد. خطای JavaScript و asset ناموفق در اجرای نهایی صفر بود. پورت‌های 13000، 19090، 19100، 9090، 3000، 9100 و 18000 از runner خارجی قابل اتصال نبودند.

۱۵. بازگشت: کپی اصلی تغییرناپذیر `/root/helix-phase21.3/rollback/manifest.json` و دستور `python3 infra/scripts/deploy-monitoring-browser.py --rollback` آماده و در عمل استفاده شده‌اند. خطای مجوز landing در تلاش اول و خطای رقابت navigation در آزمون تکمیلی موجب بازگشت شدند؛ هر دو اصلاح شدند، بدون تغییر پیام‌رسان. هنگام اصلاح مرز datasource فقط exposure Nginx بسته شد تا collection متوقف نشود. بازگشت کامل ابتدا مسیرهای جدید را می‌بندد و سپس پیکربندی قبلی را برمی‌گرداند؛ داده‌ها و تصویر برنامه حفظ می‌شوند.

۱۶. GitHub و محدودیت‌ها: شاخهٔ `phase21.3-browser-monitoring` و [PR شمارهٔ ۴](https://github.com/hamidrezab971-stack/helix/pull/4) آمادهٔ بازبینی مالک‌اند؛ merge و force-push انجام نشد. commit پیکربندی/آزمون تأییدشده `b34f53197dff8f49bf141414817a0962c19b8a5d` است؛ commit گزارش نهایی جداگانه ثبت می‌شود. هش پیکربندی واقعاً فعال در `phase21.3-production-config.json` است؛ SHA-256 سایت Nginx `89d290b9af396622ed9cc64cdc631b9360e266b55b250684b8faa9e7b0b595dc` است. manifest میزبان `/etc/helix/monitoring-release.json`، commit نهایی و هش‌های فعال را مستقل از merge ثبت می‌کند. Android با دستگاه Pixel 7 در Chromium شبیه‌سازی شد؛ دستگاه فیزیکی و مرورگرهای غیر Chromium آزموده نشدند. سه unit ناموفق قدیمی qualification در systemd باقی‌اند؛ سرویس‌های تولید سالم‌اند و آن خطاهای تاریخی پنهان نشدند. اقدام انسانی باقی‌مانده، تحویل خصوصی اعتبارنامه و تأیید مالک برای merge است؛ مانع فنی باز گزارش نشده است.

۱۷. شمارش و محتوای تمام پنل‌ها و ۳۰ عبارت PromQL در جدول زیر از فایل‌های تأییدشده استخراج شده‌اند؛ هیچ پنل تأییدشده حذف یا بازنویسی نشده است.

| داشبورد | پنل | PromQL |
|---|---|---|
| helix-application | Request rate | `sum by (method,route) (rate(helix_http_requests_total{route!="/api/health"}[5m]))` |
| helix-application | HTTP 5xx fraction | `(sum(rate(helix_http_requests_total{status=~"5.."}[5m])) or (0 * sum(rate(helix_http_requests_total[5m])))) / clamp_min(sum(rate(helix_http_requests_total[5m])), 0.001)` |
| helix-application | P50 / P95 / P99 latency | `histogram_quantile(0.5, sum by (le) (rate(helix_http_request_duration_seconds_bucket{route!="/api/health"}[5m])))`<br>`histogram_quantile(0.95, sum by (le) (rate(helix_http_request_duration_seconds_bucket{route!="/api/health"}[5m])))`<br>`histogram_quantile(0.99, sum by (le) (rate(helix_http_request_duration_seconds_bucket{route!="/api/health"}[5m])))` |
| helix-application | HTTP responses by status | `sum by (status) (rate(helix_http_requests_total[5m]))` |
| helix-application | Authenticated WebSocket connections | `helix_websocket_connections` |
| helix-application | WebSocket disconnects | `rate(helix_websocket_disconnects_total[5m])` |
| helix-application | Message frame delivery by outcome | `sum by (outcome) (rate(helix_message_delivery_total[5m]))` |
| helix-application | Message API attempts | `sum by (outcome) (rate(helix_message_submissions_total[5m]))` |
| helix-application | Upload failures | `sum by (kind) (rate(helix_uploads_total{outcome="failure"}[5m]))` |
| helix-application | Application RSS | `process_resident_memory_bytes{job="helix"}` |
| helix-infrastructure | Host CPU busy | `1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))` |
| helix-infrastructure | Host memory used | `1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes` |
| helix-infrastructure | Root disk free | `node_filesystem_avail_bytes{mountpoint="/",fstype!~"overlay\|tmpfs\|squashfs"}` |
| helix-infrastructure | Root disk available fraction | `node_filesystem_avail_bytes{mountpoint="/",fstype!~"overlay\|tmpfs\|squashfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"overlay\|tmpfs\|squashfs"}` |
| helix-infrastructure | Disk read/write throughput | `rate(node_disk_read_bytes_total[5m])`<br>`rate(node_disk_written_bytes_total[5m])` |
| helix-infrastructure | Disk busy fraction | `rate(node_disk_io_time_seconds_total[5m])` |
| helix-infrastructure | Host network RX/TX | `rate(node_network_receive_bytes_total{device!="lo"}[5m])`<br>`rate(node_network_transmit_bytes_total{device!="lo"}[5m])` |
| helix-services | Database health endpoint | `helix_api_health` |
| helix-services | Prometheus targets | `up` |
| helix-services | Container running | `helix_container_running` |
| helix-services | Container healthy | `helix_container_healthy` |
| helix-services | Container restart count (current container) | `helix_container_restart_count` |
| helix-services | Container memory saturation | `helix_container_memory_bytes / helix_container_memory_limit_bytes` |
| helix-services | Container CPU quota saturation | `helix_container_cpu_cores / helix_container_cpu_limit_cores` |
| helix-services | Collector freshness | `time() - helix_host_collector_timestamp_seconds` |
| helix-services | Active alerts | `ALERTS{alertstate="firing"}` |
