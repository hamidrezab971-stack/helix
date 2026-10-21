# نتیجهٔ اجرای نهایی Docker روی میزبان واقعی — ۲۱ اکتبر ۲۰۲۶

**BLOCKED — SPECIFIC UNSAFE CUTOVER CONDITION**

تغییر مسیر عمومی انجام نشد. گیت امنیتی imageهای نهایی هنوز `NO-GO` است؛
Grafana حاوی کد اصلاح‌نشدهٔ validation و runtime افزونهٔ فعال است که برای این
انتشار بی‌خطر شناخته نشده‌اند. تعداد High به‌تنهایی معادل تعداد exploit نیست؛
تفکیک ریسک در ادامه آمده است. هیچ finding مخفی، ignore یا پذیرفته نشد و گیت
امنیتی و آزمون‌های آن تضعیف نشدند.

مجوز جدید مالک برای پایگاه‌دادهٔ کاملاً تازه و اجرای cutover پس از عبور از گیت‌ها
معتبر است. احراز هویت حساب تاریخی و انتقال داده، شرط این انتشار نیستند؛ درخواست
تأیید دوباره از مالک مطرح نشد. دستورالعمل قدیمی مهاجرت داده جایگزین این مجوز نیست.

## وضعیت واقعی تولید و دسترسی

Docker Engine `29.9.1`، Compose `5.6.0`، systemd، Nginx، TCP محلی، فایل‌سیستم
تولید و رجیستری واقعی در دسترس بودند. PID 1 میزبان systemd است و کار در sandbox
فاقد امکان deployment انجام نشد. دریافت Prometheus از Docker Hub با خطای CDN
403 شکست خورد؛ دریافت از رجیستری رسمی Quay موفق شد.

تولید عمومی همچنان `Nginx HTTPS → 127.0.0.1:8000 → helix.service` است. PID
برنامه `261758` و release فعال `/opt/helix/releases/2aec7a584c18194a3e1c` است.
fingerprint واقعی build:

`2aec7a584c18194a3e1c01acf7fd026a1e125e8b7c2811544c77ec77fe6c26c0`

هش unit، Nginx، marker انتشار، HTML و asset عمومی با ابتدای این اجرا برابر
ماندند و سلامت عمومی HTTPS پاسخ 200 داشت. هیچ Docker production project فعال
نشد. تغییر Nginx عمومی، توقف نویسندهٔ تولید و بازنشسته‌کردن دادهٔ قدیمی انجام نشدند.

## imageها و نتیجهٔ اسکن تازه

Trivy `0.76.0` با digest ثابت و DB رسمی دریافت‌شده از ECR اجرا شد؛ UpdatedAt
برابر `2026-10-21T07:13:45.702547343Z` و سن DB هنگام اجرا کمتر از ۲۴ ساعت بود.
اسکنر non-root، دارای محدودیت منابع و فاقد Docker socket بود. همهٔ severityها،
inventory بسته‌ها و یافته‌های بدون fix حفظ شدند؛ OCI index/manifest/config و
layerها مستقل از هم بررسی شدند. تمام Criticalها صفر بودند.

| سرویس | High قبلی | High نهایی | CVE یکتای High |
| --- | ---: | ---: | ---: |
| HELIX تازه | 44 | 44 | 8 |
| Prometheus رسمی 3.13.5 | 12 | 2 | 1 |
| Grafana 13.2.4 با حذف datasourceهای غیرفعال | 11 | 11 | 9 |
| Node Exporter اصلاح‌شدهٔ قبلی | 0 | 0 | 0 |

HELIX کاندید، که هنوز برنامهٔ عمومی نیست:

`helix@sha256:4a1472f45e955cba7ea2bfefe4554e4d52e57ee8053214d2a4c3d03602618049`

Prometheus رسمیِ انتخاب‌شده:

`quay.io/prometheus/prometheus:v3.13.5@sha256:aafa9d694e6a883c02db516d9f6e5b84e14195f49a2a6456a4cca815edda72b9`

[انتشار رسمی Prometheus 3.13.5](https://github.com/prometheus/prometheus/releases/tag/v3.13.5)
با Go 1.26.10 و x/net 0.60.0 ساخته شده است. main و promtool آن هر کدام یک
match مربوط به `CVE-2026-84445` در grpc 1.83.1 دارند. این مورد نیازمند سرویس
xDS است؛ پیکربندی جاری scrape خصوصی HTTP دارد و xDS server تعریف نمی‌کند.
دو finding به‌عنوان دو exploit عمومی مستقل طبقه‌بندی نشدند. شمارش خام حفظ شد.
Prometheus/Grafana بزرگ روی این VPS کامپایل نشدند.

## تفکیک ریسک باقی‌مانده

| گروه | پیش‌شرط و شواهد | نتیجهٔ ارزیابی |
| --- | --- | --- |
| HELIX، چهار CVE util-linux: 76642، 78408، 78409، 78410 در سال 2026؛ 36 match | mount/nsenter با privilege، fstab مجاز یا kernel جدید لازم است. image نهایی فاقد SUID/SGID و capability است، UID/GID آن 10001 است و kernel میزبان 6.8 است. | exposure محلی مقید؛ معادل آسیب‌پذیری قابل بهره‌برداری از API عمومی نیست. |
| HELIX، CVE-2026-54369؛ libacl | caller دارای privilege و عملیات ACL لازم است؛ چنین امکانی به برنامه داده نشده است. | ریسک مشروط محلی؛ patch ABI متفاوت از sid به Trixie تزریق نشد. |
| HELIX، CVE-2025-69720؛ چهار match ncurses | ابزار infocmp در image نهایی واقعاً وجود ندارد. | جزء هدف در runtime غایب؛ scanner finding نگهداری شد. |
| HELIX، CVE-2026-16742 و CVE-2026-9538 | systemd-homed و Archive::Tar در image نهایی غایب‌اند. | component overmatch محتمل؛ metadata حذف نشد. |
| Grafana main؛ CVE-2026-100349، 100351، 100352، 100353، 100354 | kin-openapi 0.144.0 حفظ شده است؛ fixهای لازم تا 0.149.0 هستند. مسیر `Schema.VisitJSON` در validation قواعد alert در سورس رسمی همین نسخه موجود است. پیش‌شرط‌های سوءاستفاده، از جمله schema چرخه‌دار یا ValidationHandler/router مناسب، باید برای هر مسیر احراز شوند. | **مانع حل‌نشدهٔ انتشار**: وجود کتابخانه به‌تنهایی اثبات auth bypass نیست؛ نبود تمام مسیرهای اثرگذار نیز تأیید نشده و ریسک بدون مدرک پذیرفته نشد. |
| Grafana main و افزونهٔ فعال؛ CVE-2026-111943 | trust-store/مسیر TLS وابسته به پیکربندی است؛ ارتباط datasource فعلی HTTP داخلی است و update/telemetry غیرفعال‌اند. | اصلاح OS جایگزین ادعای اصلاح Go استاتیک نشد؛ finding باقی است. |
| افزونهٔ فعال Prometheus در Grafana؛ CVE-2026-78667، 78669، 97031 | Go 1.27.1 و x/net 0.59.0 دارد. Range، HTTP/2 و TLS server پیش‌شرط‌های جدا دارند؛ این سرویس به‌صورت عمومی publish نشده است. | exposure محدودتر، اما artifact اصلاح‌شده و معتبر ناشر انتخاب نشده است. signature verification نباید برای نصب build محلی دور زده شود. |

وضعیت بسته‌های هر هشت CVE برنامه مجدداً از
[Debian Security Tracker](https://security-tracker.debian.org/tracker/) دریافت شد:
نسخه‌های Trixie همچنان vulnerable و اصلاحات گزارش‌شده در forky/sid بودند.
کنترل‌های فقدان اجزای آسیب‌پذیر روی **image تازه** نیز اجرا شدند.

[اعلان recursion](https://github.com/getkin/kin-openapi/security/advisories/GHSA-g8cf-rcjf-c8cf)،
[اعلان اختلاف مسیر احراز هویت](https://github.com/getkin/kin-openapi/security/advisories/GHSA-23vg-4cjm-66q5)
و سورس validator از API رسمی GitHub دریافت شدند. آخرین release پایدار Grafana
در API و رجیستری هنوز `13.2.4` بود؛ نسخهٔ nightly جایگزین تولید نشد. برای رفع
مانع، artifact سازگار و قابل اعتمادِ اصلاح‌شده یا اثبات کامل عدم دسترسی مسیرهای
متأثر لازم است؛ کاهش threshold اسکن راه‌حل نیست.

افزونهٔ فعال Prometheus با `signature=valid` و `signatureType=grafana` گزارش شد؛
فقط main و همین backend plugin اجرا می‌شوند. تنظیم unsigned/development فعال
نیست. امضای Cosign تمام imageها تأیید نشده و چنین ادعایی نمی‌شود. UNKNOWNها نیز
در اسکن خام باقی‌اند، از جمله OpenPGP استفاده‌نشده در Node Exporter.

## پایگاه‌دادهٔ تازه و آزمون‌ها

`/var/lib/helix-docker/data/smooth.db` از ابتدا و بدون اتصال دادهٔ قدیمی ساخته
شد. bootstrap صریح `--initialize-empty` از lifespan و migrationهای خود برنامه
استفاده می‌کند؛ database موجود، upload غیرخالی، symlink، اجرای root و bootstrap
مجدد پذیرفته نمی‌شوند. marker تکمیل خصوصی و قفل inherited تک‌نویسنده از حذف
ناخواسته یا شروع writer دوم جلوگیری می‌کنند. backup/restore marker نیز آزموده شد.

۲۰ جدول، integrity و foreign keys صحیح‌اند؛ تعداد کاربران، مکالمه‌ها، پیام‌ها و
پیوست‌ها همگی صفر و uploads خالی است. UID/GID برابر 10001:10001، فایل DB و
marker برابر 0600 و دایرکتوری‌های داده و uploads برابر 0700 هستند. SECRET_KEY و
CAPTCHA_KEY تازه و پایدار در `/etc/helix/docker-production.env` با مجوز 0600
قرار دارند. هیچ حساب یا credential مدیریتی پیش‌فرض ساخته نشد. secretهای جدید
در فایل‌های tracked و export واقعی فایل‌سیستم image جست‌وجو و یافت نشدند.

همین فضای آمادهٔ تولید با network=none و بدون publish پورت واقعاً start، restart
و recreate شد و همچنان صفر حساب دارد. **اکنون فعال یا در مسیر عمومی نیست.**

| آزمون جاری | نتیجه |
| --- | --- |
| Backend کامل با Pillow 13 | 148 موفق؛ 635.904 ثانیه |
| Frontend، build تولید، ALTCHA interop | 99 آزمون frontend و یک interop موفق؛ build موفق |
| Chromium | هر هشت فاز در اجرای پیوسته و شبکهٔ جدا موفق |
| Safety / security | 20 / 7 موفق؛ هیچ assertion حذف نشد |
| DB تازهٔ آزمایشی در Docker | ثبت‌نام دو حساب disposable، CAPTCHA واقعی، login، متن، PNG، retrieval و history موفق |
| Nginx کاندید روی listener خصوصی | hostname/CA و TLS 1.2/1.3، WSS احراز‌شده، presence، typing start/stop و رد Origin بیگانه موفق |
| persistence / exclusivity | حفظ داده در stop/start و حذف/بازسازی container، رد writer دوم، رد bootstrap مجدد بدون تغییر DB موفق |
| rollback خصوصی با دو DB مستقل | انتقال مسیر به runtime قبلی و بازگشت به DB تازه بدون overwrite هیچ‌کدام موفق |
| Prometheus/Grafana پس از upgrade رسمی | هر سه target up؛ 26 پنل و 30 query با اندازه‌گیری واقعی از هر دو API موفق |

شکست اولیهٔ browser به‌دلیل استفادهٔ اشتباه harness از شبکهٔ میزبان و اشغال
پورت 8000، پیش از تماس با برنامهٔ تولید توسط guard رد شد؛ تکرار کامل در namespace
جدا موفق بود. query اولیهٔ percentile نمونهٔ جاری نداشت؛ با ترافیک واقعی آزمایشی
تکرار شد. خطاهای harness حفظ شدند و با حذف آزمون یا دادهٔ ساختگی پوشانده نشدند.
آزمون Android فیزیکی انجام نشده است.

دادهٔ آزمایشی جداگانه دو کاربر، یک مکالمه، سه پیام و یک تصویر دارد؛ فهرست
credentialهای disposable فقط در evidence خصوصی است. در پایگاه‌دادهٔ آمادهٔ
تولید هیچ حساب آزمایشی ساخته نشد. حساب یا داده‌ای پس از cutover عمومی ایجاد نشد،
زیرا cutover عمومی اجرا نشده است.

## پایش، آرشیو و rollback

چهار سرویس پروژهٔ خصوصی `helix212-rehearsal-2121-20261021` healthy و non-root
هستند؛ root فقط‌خواندنی، cap_drop=ALL، no-new-privileges، محدودیت CPU/RAM/PID،
restart=unless-stopped و storage پایدار دارند. Docker socket یا حالت privileged
ندارند. RAM برنامه/Grafana هرکدام 768 MiB، Prometheus برابر 512 MiB و exporter
برابر 96 MiB است. Prometheus پورت منتشرشده ندارد؛ Grafana فقط روی
`127.0.0.1:13000` و Node Exporter روی gateway خصوصی `172.30.212.1:19100` است.

Grafana از SSH tunnel به loopback قابل استفاده است؛ credential آن در فایل محافظت‌شدهٔ
qualification باقی است. target برنامه هنوز **کاندید خصوصی** است، نه تولید عمومی.
manifest آمادهٔ `helix-production` از storage/secret مستقل استفاده می‌کند، ولی
project یا volumeهای پایش تولید هنوز فعال نشده‌اند.

آرشیو جدید شامل SQLite سازگار، هشت رسانه، environment، unit، Nginx، گواهی‌ها و
تنظیمات انتشار قدیمی ساخته شد. همهٔ 44 فایل عادی archive با SHA256 و DB استخراج‌شده
با integrity/FK بررسی شدند. مسیر خصوصی:

`/root/helix-cutover-20261021/old-production-online-archive.tar.gz`

SHA256: `2a03f9f50ce3e56c27619cc38f2e5915f15274340f79a68480bade5a70fbbb51`

این archive فایل آفلاین قابل بررسی از **snapshot آنلاین** است؛ backup نهایی پس
از توقف writer نیست و خارج میزبان کپی نشده است. اصل داده و upload قدیمی در مسیر
فعال خود حفظ شده‌اند، چون بازنشستگی تولید انجام نشده است. archiveها، نسخهٔ قبلی
Prometheus، manifest قبلی پروژهٔ خصوصی و تمام imageهای rollback حفظ شدند.

پس از رفع گیت امنیتی، ترتیب تراکنش مجاز چنین است: قفل deploy و بررسی drift؛ توقف
پروژهٔ qualification بدون حذف volume؛ نصب guard نویسنده و maintenance با TLS فعلی؛
توقف و اثبات خروج systemd writer؛ backup نهایی آفلاین و اعتبارسنجی و جداسازی دادهٔ
قدیمی؛ ایجاد marker guard؛ اجرای پروژهٔ تولید روی DB تازه و TSDB مستقل با label
تولید؛ سلامت داخلی؛ تغییر Nginx؛ acceptance عمومی HTTPS/WSS/ثبت‌نام/متن/تصویر و
مشاهدهٔ مستقل fingerprint. در شکست پذیرش، Docker writer متوقف، دادهٔ تازه حفظ،
مسیر داده و routing قدیمی بدون overwrite بازگردانده و سپس systemd فعال می‌شود.
آرشیو قدیمی هرگز روی DB تازه restore نمی‌شود. هیچ‌یک از مراحل activation یا
backup نهاییِ writer متوقف‌شده در این اجرا انجام نشدند.

## شواهد و GitHub

شواهد خام، secretها، image archiveها و اطلاعات حساب آزمایشی بیرون Git در
`/root/helix-cutover-20261021` نگهداری می‌شوند. خلاصهٔ بدون secret در
`final-cutover-status.json` کنار این سند ثبت شده است. نتیجهٔ commit/push و وضعیت
مخزن رسمی در گزارش تحویل جداگانه ثبت می‌شود؛ موفقیت GitHub معادل موفقیت تولید نیست.
