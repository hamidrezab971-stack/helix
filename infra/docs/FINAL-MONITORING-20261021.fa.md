**گزارش نهایی بازبینی مانیتورینگ HELIX — ۲۱ اکتبر ۲۰۲۶**

وضعیت برنامه: **تولید Docker سالم و حفظ‌شده**.
وضعیت مانیتورینگ: **Prometheus فعال؛ تحویل Grafana مسدود و تکمیل‌نشده**.
مدیر هنوز نمی‌تواند داشبورد واقعی تولید را باز کند؛ بنابراین موفقیت آزمون
queryها یا proxy به‌معنی تحویل Grafana نیست.

این تغییر از merge commit
`d8ad6213294986f6dd4c8b38f57118b62204ab9d` ساخته شده است.
هیچ کانتینر تولید بازسازی، restart یا redeploy نشد؛ دیتابیس reset یا restore
نشد. محتوای فایل فعال Nginx نیز بدون تغییر باقی ماند. همهٔ تغییرات اجرایی
پیشنهادی فقط در templateها هستند؛ مسیرهای تولید همچنان بسته‌اند.

| URL دقیق | وضعیت تأییدشده |
| --- | --- |
| https://helix.localip.ir/ | HTTPS 200؛ صفحهٔ ورود و هر دو asset اصلی در مرورگر بارگذاری شدند |
| https://helix.localip.ir/api/health | 200 و `{"status":"ok"}` |
| https://helix.localip.ir/grafana/ | 404؛ برای مدیر و کاربر ناشناس غیرفعال |
| https://helix.localip.ir/prometheus/ | 404؛ UI اختیاری فعال نشده است |
| https://helix.localip.ir/internal/metrics | 404 عمومی؛ scrape خصوصی نیازمند توکن است |

در این بازبینی، API رسمی GitHub، release notes، go.mod چهار شاخهٔ نگهداری‌شده
و رجیستری رسمی دوباره بررسی شدند. آخرین release مشاهده‌شده
[Grafana 13.2.4](https://github.com/grafana/grafana/releases/tag/v13.2.4)، منتشرشده
در ۱۳ اکتبر، بود. نسخه‌های 13.2.4 و 13.1.8 در source از kin-openapi 0.144.0،
و نسخه‌های 13.0.11 و 12.4.13 از 0.147.0 استفاده می‌کنند. هیچ‌یک fix شناخته‌شدهٔ
0.149.0 را در source نشان نمی‌دهد. یافتهٔ source به‌تنهایی مجوز انتشار نیست؛
باینری کامل image فعلی نیز جداگانه بررسی شد.

طبق [advisory سازندهٔ kin-openapi](https://github.com/getkin/kin-openapi/security/advisories/GHSA-g8cf-rcjf-c8cf)،
CVE-2026-100354 می‌تواند هنگام validation زنجیرهٔ حلقوی schema باعث stack
overflow غیرقابل recover و توقف کل پردازش شود؛ fix اعلام‌شده 0.149.0 است.
آزمون مخرب این CVE روی تولید اجرا نشد.

| هویت artifact رسمی بررسی‌شده | SHA256 |
| --- | --- |
| index مربوط به `grafana/grafana:13.2.4` | `dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f` |
| manifest مربوط به linux/amd64 | `7b22f3edf947329d75eba7a62d9f6ea1ac1e786736813ef7a98cfb275a52e49b` |
| OCI configuration | `45900b2eda7da0cbda80b9025e446147d9085fee71675ba86a48a1cad34e4c8a` |
| باینری اصلی Grafana | `91040ca83733197346a586b79b102a408b269d0d63af72fb78f6f5055ea0df15` |

زنجیرهٔ index، manifest، config و همهٔ layerهای archive با digest بررسی شد؛
شناسهٔ image در اسکن با config همین زنجیره برابر بود. ابزار جدید
`inspect-grafana-runtime.py` بدون اجرای Grafana، فایل‌سیستم ادغام‌شدهٔ image را
خواند و هر ۹۷ فایل ELF عادی را بررسی کرد. ۱۴ باینری Go شامل main و ۱۳ datasource
شناسایی شدند؛ moduleها، وابستگی‌های transitively linked، checksumها، replacementها
و build settingهای موجود از خود باینری ثبت شدند. فقط main شامل
`github.com/getkin/kin-openapi v0.144.0` با checksum
`h1:hIRcTH+KjLfkLpYU6bSSfdFpi0fZi1fp+hSPi4aQu9Y=` بود و replacement ثبت‌شده‌ای
برای این module نداشت. در ۱۳ باینری دیگر این module ثبت نشده بود. main با
Go 1.26.9 ساخته شده است؛ datasourceها از Go 1.26.6، 1.26.7 و 1.27.1 استفاده می‌کنند.
build info کامل همهٔ باینری‌ها در شواهد خصوصی موجود است.

در tag رسمی، مسیر ریشهٔ `vendor/modules.txt` پاسخ 404 داد؛ go.work نیز ذخیره شد.
نسخهٔ اعلام‌شدهٔ module با وضعیت runtime و scanner تطبیق داشت. build info
به‌تنهایی اصالت کد کپی‌شده یا تغییر vendor بدون تغییر metadata را اثبات نمی‌کند؛
اثبات اتصال باینری به source همچنان به provenance معتبر ناشر نیاز دارد.

**امضای image و build provenance تأیید نشده‌اند.** برای هر دو digest مربوط به
index و amd64، tagهای متعارف cosign با پسوند `.sig` و `.att` پاسخ 404 داشتند و
OCI referrerها خالی بودند. lookup مربوط به GitHub artifact attestation برای
manifest نیز 404 بود. این نتیجه فقط نبود مدرک قابل تأیید در مسیرهای بررسی‌شده
را نشان می‌دهد. label ناشر یا امضای commit در صفحهٔ release، امضای image نیست.
هیچ امضا، کلید یا identity فرضی جایگزین نشد و هیچ گزینه‌ای برای دورزدن signature
verification استفاده نشد.

اسکن تازه با Trivy رسمی 0.76.0 و image digest ثبت‌شده، با database رسمی به‌روزشده
در `2026-10-21T19:18:22.876313144Z` انجام شد. تمام imageها اسکن شدند؛ ignorefile
خالی، findingهای بدون fix نیز فعال، و آستانهٔ High/Critical حفظ شد.

| سرویس | High خام | Critical | CVE متمایز High/Critical | نتیجه |
| --- | ---: | ---: | ---: | --- |
| HELIX | 44 | 0 | 8 | بررسی فردی هر ۴۴ ردیف و probe runtime دوباره موفق؛ گیت مستقل برنامه PASS |
| Grafana رسمی کامل | 75 | 0 | 13 | گیت رد؛ سرویس متوقف |
| Prometheus | 2 | 0 | 1 | findingها حفظ شدند؛ فقط HTTP خصوصی و UI عمومی غیرفعال |
| Node Exporter | 0 | 0 | 0 | listener فقط روی bridge خصوصی |

اسکن Grafana علاوه بر CVE-2026-100354، CVE-2026-111943 را نیز در main گزارش کرد؛
fix اعلام‌شدهٔ آن در Go 1.26.10 یا 1.27.3 است. شمارش Medium/Low/Unknown هم در
JSON و گزارش‌های خام حفظ شده است. گیت خام تجمیعی **NO-GO** باقی ماند؛ نتیجهٔ
مجزای برنامه این شکست را تغییر نمی‌دهد. گزارش جدید برنامه فقط پس از تطبیق
تمام ردیف‌ها با review قبلی و بررسی دوبارهٔ همان artifact و confinement صادر شد.
هش گزارش جدید و provenance آن ذخیره‌اند.

پیکربندی آمادهٔ Grafana شامل `root_url=https://helix.localip.ir/grafana/`،
`serve_from_sub_path=true`، TLS termination در Nginx، کوکی Secure/SameSite،
domain enforcement، غیرفعال‌بودن anonymous و signup، و origin مجاز Live است.
proxy پیشوند Grafana را نگه می‌دارد و upgrade مربوط به `/grafana/api/live/ws`
را عبور می‌دهد. هیچ گزینهٔ allow-unsigned یا غیرفعال‌سازی تأیید امضای plugin
اضافه نشده است. [مرجع رسمی proxy](https://grafana.com/tutorials/run-grafana-behind-a-proxy/).

در access template، `satisfy all` صریح شد تا هم ACL اتصال واقعی و هم رمز مدیر
الزامی باشند. حالت آماده، دسترسی loopback از tunnel خصوصی SSH و رمز جداگانهٔ
edge است؛ برای دسترسی دائمی، VPN مدیر یا identity-aware proxy با حساب و MFA
تأییدشده ترجیح دارد. هیچ شبکهٔ VPN، IdP یا رمز مدیریتی جدیدی فعال نشده است.
هدرهای X-Forwarded-For مبنای اجازه نیستند و رمز Basic مربوط به edge قبل از
ارسال به Grafana حذف می‌شود؛ Grafana همچنان login و RBAC خودش را نیاز دارد.

آزمون جدید `test-monitoring-routes.py` با Nginx واقعی و upstream آزمایشی، روی
listenerهای loopback جداگانه، ۳۸ بررسی موفق داشت: پاسخ 401 بدون رمز یا با رمز
غلط، پاسخ 403 برای اتصال غیرمجاز حتی با رمز درست و IP جعلی، redirect 308 فقط
پس از اجازه، حفظ/حذف درست پیشوندها، هدر HTTPS، flagهای کوکی، حذف credential
edge، upgrade موفق 101، و رد metrics/admin/lifecycle مربوط به Prometheus.
این آزمون در CI هم اضافه شد. محتوای واقعی assetها و رفتار خود Grafana هنوز
به‌دلیل توقف سرویس قابل تأیید نیست.

Prometheus UI عمداً فعال نشده است؛ flags مربوط به external-url/route-prefix
و port اختیاری 19090 روی runtime تولید اعمال نشدند. overlay آماده برای آینده
external-url برابر `https://helix.localip.ir/prometheus/` و route-prefix برابر
`/` دارد؛ proxy پیشوند عمومی را حذف می‌کند تا scrape و datasource داخلی تغییر
نکنند. Node Exporter فقط روی `172.30.212.1:19100` است؛ Grafana listener ندارد و
Prometheus پورت host منتشر نمی‌کند.

هر ۳۰ query موجود در سه داشبورد و ۲۶ پنل علیه Prometheus واقعی تولید اجرا شد.
هر سه target شامل helix، node و prometheus در وضعیت up بودند؛ داده‌های غیرتهی
و finite بررسی شدند و نتیجهٔ خالی Active alerts مجاز بود. زمان شروع پردازش
مشاهده‌شده مستقیم از کانتینر با series مربوط به scrape تولید برابر بود.
این آزمون دادهٔ تولید را تأیید می‌کند؛ نمایش ۲۶ پنل در Grafana تأیید نشده است.
فایل‌های داشبورد و provisioning تغییر نکردند و دو volume قدیمی Grafana دست‌نخورده
باقی ماندند. volume تولید Grafana جدیدی ساخته نشد.

آزمون مرورگر Chromium از همین میزبان، HTTPS واقعی، دو asset، API سلامت و رد
ناشناس/credential نامعتبر در ۱۳ مسیر حساس را تأیید کرد؛ خطای browser صفر بود.
آزمون مستقل خارجی در job مربوط به public-https در PR اجرا می‌شود و نتیجهٔ آن
باید در checks همان PR بررسی شود. آزمون محلی به‌تنهایی مدرک مبدأ خارجی نیست.
ورود دو حساب QA موجود، WSS احراز‌شده و presence، رد Origin بیگانه و دریافت پیوست
قبلی موفق بودند؛ هیچ پیام یا upload جدیدی در تولید ایجاد نشد.

۲۰ آزمون safety، ۱۱ آزمون security و چهار آزمون واقعی metrics/auth/realtime
موفق شدند. اجرای اولیه با interpreterهای فاقد dotenv یا httpx2 شکست خورد؛
لاگ شکست‌ها حفظ شد و اجرای موفق با محیط‌های مجزای موجود انجام شد. وابستگی یا
باینری سرویس تولید برای رفع مشکل محیط تست تغییر نکرد. فایل‌های Python و
JavaScript از بررسی syntax و diff از whitespace check گذشتند.

شناسه و زمان شروع کانتینرهای app، Prometheus و Node Exporter با baseline آغاز
بازبینی برابر و restart count هر سه صفر بود. برنامه با UID/GID برابر 10001،
root فقط‌خواندنی، capability صفر، NoNewPrivs و Seccomp فعال تأیید شد.
SQLite integrity و foreign key check سالم بودند. cache و archiveهای تکراری
اسکن جدید پس از ثبت digest، provenance و گزارش خام حذف شدند تا فضای موقت
اسکن باقی نماند؛ alert موقت کمبود فضای دیسک پس از این پاک‌سازی رفع شد.
هیچ فایل داده یا volume برنامه حذف نشد.

برای تکمیل Grafana، این سه مانع باید رفع شوند:

1. artifact رسمی و پشتیبانی‌شده با fix تأییدشده در باینری اصلی و pluginهای
   همراه، امضای ناشر و provenance معتبر، و گیت امنیت موفق لازم است. هیچ‌یک از
   releaseهای فعلی بررسی‌شده این مجموعهٔ شروط را برآورده نکرد.
2. دسترسی مدیر از VPN/IAP یا tunnel تأییدشده و رمز edge باید provision و آزمون
   شود. تا عبور گیت artifact، فعال‌سازی route یا Grafana مجاز نیست.
3. پس از فعال‌سازی امن، مدیر باید URL واقعی تولید و هر سه داشبورد را باز کند؛
   assetها، redirect، login/session، کوکی و Live در مرورگر مجاز و رد کاربران
   غیرمجاز بررسی شوند. تنها پس از این پذیرش می‌توان تحویل Grafana را کامل نامید.

شواهد خصوصی این اجرا در
`/root/helix-monitoring-final-20261021T195707Z` است: inventory کامل moduleها،
پاسخ‌های رجیستری و upstream، گزارش خام چهار image، provenance و metadata/هش DB،
گیت‌های امنیت، queryهای تولید، مرورگر، WSS، سلامت داده، و لاگ آزمون‌ها.
خلاصهٔ قابل انتشار در `infra/security/grafana-release-review-20261021.json`
ثبت شده است. هیچ credential یا دادهٔ خصوصی تولید وارد Git نشده است.
