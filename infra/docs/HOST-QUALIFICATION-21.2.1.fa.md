# ارزیابی واقعی میزبان HELIX Phase 21.2.1

**NO-GO — VERIFIED REMAINING BLOCKERS**

زمان گزارش: `2026-10-21T10:49:15.633675+00:00`. مبنای سورس `78530d5031739eee409541001fe39b59b32d9b9c` روی شاخهٔ `phase21.2-production-observability` است. Docker، systemd، TCP محلی و مسیرهای محافظت‌شده روی همین VPS واقعاً در دسترس بودند. برنامهٔ عمومی جابه‌جا نشد؛ unit و پیکربندی Nginx تولید دست‌نخورده باقی ماندند.

## اسکن امنیت و هویت imageها

| سرویس | High قبل | High بعد | Critical بعد |
| --- | ---: | ---: | ---: |
| app | 44 | 44 | 0 |
| prometheus | 10 | 12 | 0 |
| grafana | 61 | 11 | 0 |
| node-exporter | 14 | 0 | 0 |

اسکن‌های خام همهٔ severityها و یافته‌های بدون fix را حفظ می‌کنند. ignorefile برابر `/dev/null` است و هیچ suppression یا استثنای خودکار اعمال نشده است. gate موجود روی هر High/Critical شکست می‌خورد. تحلیل مسیر اجرا و کار قابل اقدام در [گزارش ریسک](SECURITY-HOST-21.2.1.fa.md) آمده است.

DB اسکنر از مخزن رسمی ECR دریافت شد؛ UpdatedAt برابر `2026-10-21T07:13:45.702547343Z` است. دریافت از mirror اولیه و GHCR با 403/denied مواجه شد و به‌عنوان شکست نگهداری شد. Trivy 0.76.0 با digest ثابت، بدون Docker socket، با UID غیر root و محدودیت منابع اجرا شد. زنجیرهٔ OCI index، manifest، config و layerها و هویت گزارش اسکن بررسی شدند.

| image انتخاب‌شده | مرجع immutable محلی |
| --- | --- |
| app | `helix@sha256:6dd818b91b1de902c806a7f1ebbead3be46e1a7a3efca78fa4dfa3a9232e3271` |
| prometheus | `prom/prometheus:v3.13.4@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e` |
| grafana | `helix-grafana@sha256:0ba86c2c8d85e837751858ad99a0882757fec868208b6b01902887e2593442d9` |
| node-exporter | `helix-node-exporter@sha256:c3f91da714ada22d873de8fb66a6c6fec8bc9bd34f6bbbfacebff5089c3246df` |

buildهای سفارشی، image رسمی منتشرشدهٔ ناشر محسوب نمی‌شوند و به registry push نشده‌اند. آرشیوهای image و provenance کامل بیرون Git محفوظ‌اند. این کنترل‌ها شامل hashهای OCI، checksumهای Go/wheel و امضای plugin فعال‌اند؛ برای imageهای محلی ادعای امضای ناشر، تأیید Cosign یا build مستقل bit-for-bit نمی‌شود. ورودی‌ها و patchهای dependency در `infra/security/` ثبت شده‌اند؛ Go checksum verification غیرفعال نشد. جایگزینی بدون امضای افزونهٔ Prometheus در image انتخاب‌شده انجام نشد؛ فایل‌های بستهٔ دارای امضای Grafana Labs حفظ شدند.

در اسکن میانی با DB تازه‌تر، Pillow 12.3.0 علاوه بر ۴۴ High قبلی، شش High و یک Critical تازه داشت. نسخهٔ 13.0.0 با SHA256 رسمی wheel قفل، image دوباره ساخته و suiteها و integration تکرار شدند. اسکن میانی با 50 High/1 Critical حفظ شده و با نتیجهٔ image نهایی اشتباه گرفته نمی‌شود. [اعلان رسمی](https://github.com/python-pillow/Pillow/security/advisories/GHSA-8g5g-8vmr-9782) و [release notes](https://pillow.readthedocs.io/en/stable/releasenotes/13.0.0.html) بررسی شدند.

## موانع ساخت و امنیت

ساخت محدود نهایی Grafana (exit=2) و Prometheus (exit=1) با Go اصلاح‌شده، 2 GiB حافظه و حداکثر 2 GiB swap رمزگذاری‌شده، هنگام link با signal killed شکست خورد. این باینری‌ها deploy یا qualified نشدند. Prometheus رسمی فعلی با DB جدیدتر ۱۲ High دارد؛ overlay جدید Grafana فقط دوازده datasource غیرفعال را حذف می‌کند و main رسمی و Prometheus plugin امضاشده را حفظ می‌کند. پنج High kin-openapi در main و یافته‌های Go در main و plugin فعال باقی می‌مانند؛ شمارش جدید Grafana ۱۱ High است. build و آزمون محلی plugin موفق بود اما امضای معتبر ناشر برای artifact محلی وجود ندارد؛ signature verification تضعیف نشد.

DB تازهٔ 07:13 UTC یافتهٔ CVE-2026-111943 را نیز اضافه کرد؛ compiler لازم اکنون Go 1.26.10 یا 1.27.3 است. اعداد بین DBهای متفاوت به‌تنهایی اثر patch را نشان نمی‌دهند؛ همهٔ اسکن‌های میانی نگهداری شدند. دو patch پایدار Trixie برای ca-certificates و liblzma5 با نسخهٔ دقیق در image نهایی نصب شدند.

نسخهٔ اصلاح‌شدهٔ نهایی Node Exporter با Go 1.26.10 واقعاً ساخته و جایگزین شد و High/Critical آن صفر شد. ورودی‌های source/compiler/dependency و وضعیت هر artifact در [qualified-inputs.json](../security/qualified-inputs.json) ثبت‌اند؛ patchهای Grafana و Prometheus اثبات رفع در runtime نیستند.

## نتیجهٔ آزمون‌های جاری

| کنترل | نتیجهٔ واقعی |
| --- | --- |
| Backend کامل با Pillow 13 | ۱۴۸ آزمون موفق؛ 704.258 ثانیه |
| Frontend کامل | ۹۹ آزمون موفق، build تولید و ALTCHA interop موفق |
| Chromium | هر هشت فاز در اجرای پیوسته روی bundle تولید موفق؛ assertion حذف نشد |
| جریان Docker از Nginx خصوصی | CAPTCHA، ورود، متن، PNG، دریافت تصویر، history، WebSocket و presence موفق |
| TLS/Nginx | CA و hostname و TLS 1.2/1.3، ورود، WSS و رد Origin بیگانه موفق |
| سلامت Docker | هر چهار سرویس healthy؛ non-root، root فقط‌خواندنی، cap_drop=ALL و no-new-privileges |
| Prometheus | هر سه target یعنی helix/node/prometheus برابر up |
| Grafana | ۲۶ پنل و ۳۰ query از مسیر Prometheus و datasource واقعی؛ پاسخ‌های range در Chromium نیز ثبت شدند |
| هشدارها | syntax و fixtureهای پنج rule موفق؛ قطع واقعی کاندید دو alert را firing کرد و پس از بازیابی هر دو inactive شدند |
| persistence | restart روی کپی خصوصی همهٔ ردیف‌ها و رسانه‌های پیش از restart را حفظ کرد |
| WebSocket هنگام restart | close code=1012؛ JWT، تاریخچه و تصویر قبلی پس از restart معتبر ماندند |
| rollback | دو چرخهٔ واقعی کاندید↔runtime قبلی، با متن/تصویر تازه و تنها یک نویسنده روی کپی خصوصی، موفق |

اجرای اولیهٔ مرورگر در حالت development روی صفحهٔ خالی timeout شد؛ شواهد شکست نگهداری شده‌اند. runner اکنون bundle تولید را build و سرو می‌کند و هر هشت فاز در یک اجرای کامل موفق شدند. ورودی/خروجی subprocessها JWT و credentialها را حتی در مرز chunkها redact می‌کند و آزمون regression آن موفق است. viewportهای موبایل آزموده شدند؛ ادعای آزمون فیزیکی Android نمی‌شود.

Grafana در بودجهٔ اولیهٔ 384 MiB طی queryهای واقعی به OOM رسید و restart خودکار داشت. بودجه به 768 MiB و GOMEMLIMIT هر پردازه به 256 MiB تغییر کرد؛ queryهای مرورگر تکرار و پایداری نسخهٔ نهایی جداگانه بررسی شد. شکست‌های محدود به cgroupهای build نیز محفوظ‌اند. swap موقت رمزگذاری‌شده پس از buildها حذف و تنظیم قبلی میزبان بازگردانده شد.

## fingerprint و ایمنی دادهٔ تولید

پردازهٔ عمومی PID `261758` از `/opt/helix/releases/2aec7a584c18194a3e1c` روی پورت 8000 است. SHAهای unit، سایت Nginx، release marker و بایت‌های environment با ابتدای کار برابر ماندند. assetهای عمومی با release فعال مطابقت داشتند و گواهی تا ۱۵ ژانویهٔ ۲۰۲۷ معتبر است.

پایش 522 نمونهٔ سلامت عمومی از `2026-10-21T00:57:05.446103+00:00` تا `2026-10-21T10:48:34.864459+00:00` همگی موفق بود؛ بیشینهٔ زمان مشاهده‌شده 0.632 ثانیه است. این مشاهده، تضمین SLA آینده نیست.

پایش دو بازهٔ جداگانه داشت؛ از حدود 02:56 تا 10:37 UTC نمونهٔ متوالی ثبت نشده است. سلامت آن فاصله ادعا نمی‌شود. fingerprint و HTTPS در شروع بازهٔ دوم دوباره از میزبان و مسیر عمومی بررسی شدند. SHA256های unit/Nginx/release marker و asset/TLS در JSON وضعیت ثبت‌اند.

SQLite online backup تازه و سازگار همراه uploadها ساخته و فقط کپی دوم به Docker متصل شد. هر ۲۰ جدول، integrity، foreign keys، تاریخچه، ارجاع فایل‌ها، اندازه و hash تمام رسانه‌ها بررسی شدند. hash حساب‌ها و کلیدهای مؤثر JWT/CAPTCHA با snapshot و محیط پردازهٔ زنده برابرند. داده، password hash، رسانه و secret وارد Git نشدند.

snapshot تازهٔ تحویل در ساعت 2026-10-21T10:44:32.987749+00:00 نیز روی کپی جداگانه با همین image نهایی واقعاً اجرا شد؛ هر ۲۰ جدول، آخرین last_seen و هشت رسانه حفظ شدند. تفاوت طبیعی snapshot تولید با ابتدای کار فقط last_seen_at بود. هیچ snapshot قدیمی روی دادهٔ زنده restore نشد.

ورود یک حساب اصلی با credential واقعی هنوز تأیید نشده است. حساب‌های synthetic حفظ‌شده بین دو runtime آزمایش شدند؛ این نتیجه جایگزین ورود حساب اصلی و مشاهدهٔ تاریخچه/رسانهٔ همان حساب نیست. ابزار `verify-retained-auth.py` با ورودی مخفی SSH یا FD مهروموم‌شده آماده است و credential را log نمی‌کند.

در تولید فعلی مسیرهای /internal و /internal/metrics و /metrics همان HTML دقیق SPA را برمی‌گردانند؛ exposition افشا نشد. کاندید Nginx این مسیرها را 404 می‌کند. public routing برای اصلاح این تفاوت تغییر نکرد.

## backup، rollback و برنامهٔ cutover

snapshot آنلاین، backup نهایی پس از توقف نویسندهٔ تولید نیست. snapshot و restoreهای خصوصی به‌معنی backup خارج میزبان نیستند. تمرین خصوصی توقف نویسنده، backup، اعتبارسنجی runtime قبلی روی کپی restore و بازگشت API حدود 9.165 ثانیه طول کشید. برآورد برنامه‌ریزی پنجرهٔ عمومی ۲–۵ دقیقه است؛ زمان قطعی واقعی تولید اندازه‌گیری نشده و باید پیش از تصویب محدود شود.

[ترتیب دقیق مهاجرت و rollback](CUTOVER-21.2.1.md) شامل lock، maintenance، توقف و اثبات خروج writer، backup نهایی، کنترل داده و کلیدها، فعال‌سازی تک‌نویسندهٔ Docker، آزمون خصوصی، تغییر بررسی‌شدهٔ Nginx و پایش پس از آن است. rollback باید روی جدیدترین داده انجام شود؛ backup قدیمی نباید نوشته‌های پس از cutover را بازنویسی کند. maintenance پیشنهادی فقط روی listener جداگانه با TLS معتبر و 503/Retry-After آزموده شد.

برای تولید TSDB مستقل و label محیط تولید لازم است؛ داده‌های QA مانیتورینگ تولید نامیده نشدند. volumeها و runtime قبلی حفظ شده‌اند. manifest/guard نهایی و حذف خطر شروع هم‌زمان writerها پس از reboot باید پیش از درخواست approval مهر و بازبینی شوند. backup خارج میزبان و تحویل بیرونی alert تأیید نشده‌اند.

## موانع تصمیم و تحویل

یافته‌های High باقی‌مانده طبق gate حل‌نشده‌اند و ریسک آن‌ها برای تولید پذیرفته نشده است. ورود حساب اصلی، guard/manifest نهایی و شروط عملیاتی recovery/notification نیز بسته نشده‌اند. هیچ درخواست اجرای cutover و هیچ تغییر عمومی خودکار انجام نشد.

GitHub connector در بررسی جاری pull=true و push=false دارد؛ Git میزبان هم credential قابل استفاده نداشت. تغییرات بازبینی‌شده commit محلی می‌شوند؛ push و force-push انجام نشدند. شناسهٔ commit نهایی در تحویل آمده است.

شواهد خصوصی کامل در `/root/helix-phase21.2.1/host-20261021`؛ خلاصهٔ machine-readable در [phase21.2.1-status.json](phase21.2.1-status.json).
