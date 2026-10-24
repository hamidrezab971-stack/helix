# گزارش HELIX — فاز ۲۱٫۳

وضعیت این نسخه پیش از آزمون خارجی: استقرار روی VPS و آزمون Chromium محلی موفق؛ نتیجهٔ مستقل GitHub پس از اجرا ثبت خواهد شد. این متن نتیجهٔ تاریخی فاز قبل را سلامت فعلی فرض نمی‌کند.

۱. میزبان واقعی `srv8467792069` با دسترسی root، Docker 29.9.1، Compose 5.6.0، Nginx و systemd تأیید شد. DNS و HTTPS گیت‌هاب و GHCR سالم؛ CLI با حساب مالک مخزن احراز هویت شده است.

۲. پیام‌رسان در HTTPS و `/api/health` سالم است. کانتینر و تصویر برنامه، Node Exporter و Grafana دست‌نخورده‌اند. فقط Prometheus برای external URL بازایجاد شد؛ volume موجود و گردآوری معیارها حفظ شدند.

۳. دسترسی مرورگری `/grafana/`، `/prometheus/` و `/monitoring/` فعال است. بازدیدکنندهٔ ناشناس یا دارای اعتبارنامهٔ نادرست 401 می‌گیرد. Prometheus حتی با اعتبارنامهٔ معتبر Viewer نیز 401 می‌دهد. exporterها و endpointهای حساس 404 یا پورت خصوصی دارند.

۴. Nginx و Grafana دو رمز مستقل می‌خواهند؛ این معماری MFA نیست. نقش بومی `helix-stakeholder` برابر Viewer است و مدیر جداست. حذف داشبورد موقت، تغییر datasource موقت، ایجاد کاربر و تغییر alert توسط Viewer با 403 رد شد. داشبوردهای تأییدشده برای آزمون مخرب استفاده نشدند؛ اشیای موقت با مدیر حذف می‌شوند.

۵. فایل تحویل ذی‌نفع `/etc/helix/monitoring-handoff/stakeholder.json` با مجوز 0600 در پوشهٔ 0700 آماده است. مسئول مجاز باید فقط اعتبارنامهٔ ذی‌نفع را از کانال خصوصی یا password manager به او تحویل دهد. تحویل انسانی انجام‌شده فرض نشده است؛ هیچ رمز مدیریتی در این گزارش نیست.

۶. تصویر جاری Grafana حفظ شده است:
`ghcr.io/hamidrezab971-stack/helix-grafana@sha256:1386cfea0081497a6608e5947f208bf7d8e91cd180293eab75d01dd69b75a5d9`.
اسکن یا gate امنیتی تضعیف نشده؛ این تغییر تصویر تازه‌ای نمی‌سازد. امضای افزونهٔ runtime جداگانه بررسی می‌شود. گزارش اسکن ۲۳ اکتبر تاریخی است و اسکن تازهٔ این فاز ادعا نمی‌شود.

۷. کوکی نشست Grafana دارای Secure، HttpOnly، SameSite=Lax و مسیر `/grafana` است. نشست باطل‌شده رد شد و ورود دوباره موفق بود. برای آزمون، گذشت واقعی زمان انقضای چندروزه انتظار کشیده نشده است؛ ابطال سمت سرور و بازپخش کوکی قبلی بررسی شد. Live با WSS و پاسخ پروتکل تأیید شد.

۸. داده‌ها واقعی‌اند: هویت فرایند برنامهٔ جاری با سری Prometheus مطابقت داده شد؛ هر سه target سالم‌اند و همهٔ پرس‌وجوها، به جز تهی‌بودن مجاز Active alerts، مقادیر متناهی و تازه دارند. datasource همان `http://prometheus:9090` در شبکهٔ خصوصی است.

۹. دیسک ریشه پیش از کار 61,285,326,848 بایت ظرفیت، 54,109,913,088 بایت مصرف و 7,158,636,544 بایت آزاد داشت؛ یعنی 11.681٪ آزاد. اندازه‌گیری موقت پس از پاک‌سازی: 12,831,645,696 بایت آزاد، 20.938٪؛ افزایش خالص آزاد 5,673,009,152 بایت. اندازه‌گیری نهایی در شواهد میزبان ثبت می‌شود. مجموع اندازهٔ نام‌های حذف‌شده به علت hard link معیار فضای فیزیکی بازیابی‌شده نیست.

۱۰. عملیات دقیق پاک‌سازی: فقط فایل `trivy.db` تکراری در مسیرهای زیر پس از تطبیق SHA-256، بررسی عدم استفاده و حفظ نسخهٔ یکسان حذف شد:

- `/root/helix-phase21.2.1/host-20261021/security-delivery/scan/cache/db/trivy.db`
- `/root/helix-cutover-20261021/security-final/scan/cache/db/trivy.db`
- `/root/helix-cutover-20261021/security-current/scan/cache/db/trivy.db`
- `/root/helix-phase21.2.1/host-20261021/security-ecr/scan/cache/db/trivy.db`
- `/root/helix-qualification-20261020/security/cache/db/trivy.db`

همچنین ۵۱۲ فایل zip کش دانلود ماژول Go فقط در `/root/helix-phase21.2.1/host-20261021/go-cache-grafana/pkg/mod/cache/download/`، با فهرست دقیق پیش از حذف، پاک شدند. سورس بازشده، go.sum، ziphash، manifest، نتایج اسکن و همهٔ تصاویر و آرشیوهای بازگشت حفظ شدند. prune عمومی، حذف volume، حذف پیام، پاک‌کردن upload و حذف دادهٔ زندهٔ Prometheus انجام نشد. گزارش‌های دقیق `scanner-cache-inventory.json`، `cleanup-plan.json` و `go-download-cache-cleanup.json` در پوشهٔ خصوصی شواهد موجودند.

۱۱. هشدار فضای آزاد ریشه: warning زیر ۲۰٪ و critical زیر ۱۵٪، هر دو برای ۱۰ دقیقه. آزمون واقعی promtool شامل هشدار، بحرانی، بازیابی و کنارگذاشتن tmpfs موفق است. اعلان به سامانهٔ خارجی جدید ایجاد نشده است. لاگ Docker از قبل local با 10MB × 3 بود؛ journald به 256MB و ۳۰ روز محدود شد، بدون حذف شواهد موجود. Prometheus همچنان 15d/2GB است.

۱۲. تغییرات Nginx فقط دسترسی مانیتورینگ را جایگزین کرد: حذف ACL عمومی localhost، حساب‌های مجزای edge، فایل جداگانهٔ مدیر Prometheus، forwarded header معتبر، حذف Authorization پیش از upstream، مسیر صحیح asset/API، پشتیبانی Live و محدودیت نرخ. پیش از هر reload، `nginx -t` اجرا شد. خطای مجوز صفحهٔ راهنما در تلاش اول باعث rollback خودکار شد؛ مجوز اصلاح و فعال‌سازی مجدد بررسی شد.

۱۳. آزمون‌ها: ۶۸ بررسی واقعی Nginx ایزوله شامل 429؛ ۶۴ بررسی HTTPS تولید؛ ۲۰ آزمون ایمنی داده؛ ۱۱ آزمون gate امنیتی؛ قواعد promtool؛ Chromium واقعی برای مدیر، Viewer و نمای Android. ورود عادی HELIX، CAPTCHA، WSS، تحویل پیام به مرورگر دوم، دریافت تصویر، رد تصویر نامعتبر و تاریخچه بعد از بازکردن دوبارهٔ گفت‌وگو با حساب‌های آزمایشی موجود بررسی شد. پیام‌های آزمایشی جدید حفظ شدند و کاربر بازایجاد نشد.

۱۴. بازگشت آماده: `/root/helix-phase21.3/rollback/manifest.json` و دستور `python3 infra/scripts/deploy-monitoring-browser.py --rollback`. این مسیر ابتدا exposure جدید را می‌بندد و سپس تنظیمات Prometheus قبلی را برمی‌گرداند. داده و تصویر پیام‌رسان تغییر نمی‌کند.

۱۵. تحویل GitHub در شاخهٔ `phase21.3-browser-monitoring` انجام می‌شود؛ merge نیازمند تأیید مالک است و خودکار انجام نمی‌شود. commit و هش تنظیمات واقعاً فعال جدا از هم در فایل میزبان `/etc/helix/monitoring-release.json` ثبت می‌شوند.

۱۶. محدودیت‌های روشن: اجرای محلی Chromium آزمون خارج از VPS محسوب نمی‌شود؛ آزمون runner خارجی جداگانه لازم است. Android فعلاً شبیه‌سازی viewport/user-agent/touch در Chromium است؛ دستگاه فیزیکی آزمایش نشده است. سه unit ناموفق قدیمی مربوط به qualificationهای قبلی در systemd دیده شدند؛ سرویس‌های تولید سالم‌اند و این unitها حذف یا پنهان نشدند.

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
