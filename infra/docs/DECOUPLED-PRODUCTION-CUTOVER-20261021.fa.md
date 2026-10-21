# انتشار مستقل HELIX و وضعیت جداگانهٔ Grafana — ۲۱ اکتبر ۲۰۲۶

APPLICATION: **DEPLOYED — DOCKER PRODUCTION VERIFIED**

OBSERVABILITY: **PARTIAL — PROMETHEUS ACTIVE, GRAFANA ISOLATED/SUSPENDED**

بازتأیید ساعت ۱۵:۵۶ UTC با همان artifact و بدون تکرار cutover در
[`PRODUCTION-REVERIFICATION-20261021.fa.md`](PRODUCTION-REVERIFICATION-20261021.fa.md)
ثبت شده است. تعداد ردیف‌های داده در ادامه، snapshot پذیرش اولیهٔ ساعت ۱۴:۴۳ است.

این گزارش جایگزین وضعیت تاریخی گزارش `FINAL-DOCKER-CUTOVER-20261021.fa.md`
است. cutover برنامه با مجوز صریح مالک برای SQLite کاملاً تازه انجام شد. امنیت
Grafana شرط انتشار HELIX قرار نگرفت؛ سرویس آسیب‌پذیر Grafana اجرا نمی‌شود.

## تولید واقعی

میزبان `srv8467792069`، Ubuntu 24.04.5 و kernel `6.8.0-147-generic` بررسی شدند.
Git آغاز کار `af22654b816ba6506a1e399fa780b2364ca5d1a0` بود. سورس runtime
برنامه تغییر نکرد؛ فایل‌های backend داخل image با سورس تطبیق هش دارند.

مسیر فعال `https://helix.localip.ir → Nginx → 127.0.0.1:18000 → Docker` است.
پروژهٔ تولید `helix-production` و fingerprint فعال برنامه:

`helix@sha256:4a1472f45e955cba7ea2bfefe4554e4d52e57ee8053214d2a4c3d03602618049`

OCI config: `sha256:0bab97dec7835a90be631491cc9be015b7a505ac571be0346356e9ab14cb7772`

SHA256 صفحهٔ عمومی: `b933c9b7b8869dc9d46e67cf3ddd63a7316d2d08fd5908160c57c8fc0167fafa`

HTML و همهٔ assetهای عمومی با فایل‌های استخراج‌شده از همین image تطبیق دارند.
JavaScript اصلی و ALTCHA دقیقاً با build آزمون Chromium برابرند؛ تفاوت CSS فقط
utility استفاده‌نشدهٔ `.collapse` است که از اسکن فایل‌های آزمون ایجاد می‌شود و
در context تولید، طبق `.dockerignore` وجود ندارد.

| سرویس واقعی | وضعیت | دسترسی |
| --- | --- | --- |
| HELIX Docker | healthy؛ UID/GID 10001 | فقط loopback 18000 پشت HTTPS/WSS |
| Prometheus رسمی 3.13.5 | healthy؛ هر سه target برابر up | شبکهٔ داخلی، بدون port publish |
| Node Exporter | healthy | فقط gateway خصوصی `172.30.212.1:19100` |
| Grafana | معلق؛ در پروژهٔ تولید ایجاد نشده | بدون listener 13000 و بدون مسیر عمومی |
| systemd قدیمی | inactive؛ PID صفر | شروع مجدد با guard مسدود شد |

root کانتینرها فقط‌خواندنی، capabilities حذف‌شده، no-new-privileges فعال و
CPU/RAM/PID محدودند. restart برنامه `unless-stopped` است. Docker socket، حالت
privileged و host PID به برنامه داده نشده‌اند. collector تولید با timer فعال
هر ۳۰ ثانیه متریک واقعی می‌نویسد. proxy آزمایشی قدیمی نیز متوقف شد.

## گیت مستقل امنیت برنامه

اسکن خام Trivy 0.76.0، با DB رسمی به‌روز در `2026-10-21T07:13:45Z`، حفظ شد.
image، OCI index/manifest/config و هش گزارش همان artifact بررسی‌شده هستند.
هیچ ignore، حذف metadata، تغییر severity threshold یا پذیرش ریسک مادی اعمال نشد.
گیت شمارش خام چهار سرویس همچنان **NO-GO** گزارش می‌کند؛ این خروجی مخفی نشد.

هر ۴۴ ردیف High برنامه، شامل ۸ CVE یکتا، جداگانه در
[`application-review-20261021.json`](../security/application-review-20261021.json)
ثبت شده است. Critical برنامه صفر است. نتیجهٔ برنامه برای image و runtime دقیق
بررسی‌شده **PASS — REVIEWED APPLICATION SECURITY** است.

| CVE | تعداد ردیف | دلیل نبود مسیر مؤثر در runtime مقید |
| --- | ---: | --- |
| CVE-2026-76642 | 9 | mount دارای privilege، SUID/capability و مجوز fstab موجود نیست؛ HELIX mount اجرا نمی‌کند. |
| CVE-2026-78408 | 9 | nsenter ریشه و FD بازشدهٔ cgroup میزبان وجود ندارد؛ برنامه بدون capability اجرا می‌شود. |
| CVE-2026-78409 | 9 | مسیر kernel 6.15+ با kernel واقعی 6.8 فعال نیست؛ fstab مجاز و mount ممتاز نیز غایب‌اند. |
| CVE-2026-78410 | 9 | restricted bind mount ممتاز و SUID و ورودی fstab وجود ندارند. |
| CVE-2026-54369 | 1 | caller ممتاز ACL وجود ندارد؛ برنامه ACL اجرا نمی‌کند و libacl در probe پایتون load نشده است. |
| CVE-2025-69720 | 4 | ابزار آسیب‌پذیر infocmp واقعاً از image حذف شده است. |
| CVE-2026-16742 | 2 | systemd-homed و socket میزبان وجود ندارند؛ تطبیق بستهٔ کتابخانه، daemon را فراهم نمی‌کند. |
| CVE-2026-9538 | 1 | Archive::Tar وجود ندارد؛ بارگذاری واقعی module شکست می‌خورد و HELIX tar استخراج نمی‌کند. |

probe دوباره روی image نهایی اجرا شد: پنج مجموعهٔ capability صفر، NoNewPrivs=1،
Seccomp=2، بدون SUID/SGID و بدون ورودی عملیاتی fstab. source برنامه نیز هیچ
فراخوانی mount/nsenter/ACL/Perl ندارد. گیت جدید برای scan تغییرکرده، image
نامنطبق، review ناقص یا risk acceptance شکست می‌خورد؛ آزمون این حالت‌ها افزوده شد.
تغییر image، kernel یا این کنترل‌ها، نیازمند ارزیابی تازه است.

## Grafana؛ تحویل حل‌نشده و جداگانه

API رسمی GitHub و tagهای رجیستری دوباره بررسی شدند. آخرین stable مشاهده‌شده
[Grafana 13.2.4](https://grafana.com/grafana/download/13.2.4?edition=oss) بود.
باینری اصلی image رسمی استخراج و با `go version -m` بررسی شد:
`github.com/getkin/kin-openapi v0.144.0`؛ کف اصلاح موردنیاز `v0.149.0` است.
go.mod شاخه‌های پشتیبانی‌شدهٔ 13.1.8، 13.0.11 و 12.4.13 نیز به‌ترتیب 0.144،
0.147 و 0.147 داشتند. artifact رسمی، پشتیبانی‌شده و اصلاح‌شدهٔ مناسب پیدا نشد.
ادعای تأیید امضای image مطرح نمی‌شود.

Grafana متوقف شد، restart کانتینر قبلی غیرفعال شد و پس از حفظ داده، کانتینر
qualification حذف شد. volume اصلی
`helix212-rehearsal-2121-20261021_grafana_data` و ۲۶ پنل/۳۰ query و provisioning
حفظ شده‌اند. archive خصوصی `grafana-suspended.tar.gz` نیز وجود دارد. profile
`grafana-reviewed` از startup پیش‌فرض Compose کنار گذاشته شده است. فعال‌سازی آن
به رفع گیت مستقل Grafana نیاز دارد. هیچ binary نامعتبر یا override امضای افزونه
ساخته یا فعال نشد. ۱۱ ردیف High Grafana همچنان حل‌نشده‌اند.

Prometheus رسمی 3.13.5 دو match مربوط به CVE-2026-84445 در main/promtool دارد؛
پیش‌شرط آن `xds.NewGRPCServer` است. این سرویس فقط HTTP خصوصی و scrapeهای static
دارد؛ xDS gRPC server در پیکربندی وجود ندارد. این نتیجه، ادعای صفر finding نیست.
Node Exporter همان artifact قبلی تأییدشده با صفر High است؛ build جدیدی انجام نشد.

## آزمون و پذیرش زنده

۱۴۸ آزمون backend، ۹۹ frontend، یک ALTCHA interop، هر هشت فاز Chromium،
۲۰ safety و ۱۱ security موفق شدند. dependencyهای محیط آزمون backend با lock
تولید دقیقاً برابرند. timeout اولیهٔ حذف متوالی با افزودن assertion انتظار برای
حذف ردیف رفع شد؛ تمام فازها مجدداً موفق شدند و assertion قبلی حذف نشد.

روی **تولید عمومی Docker** ثبت‌نام دو حساب QA، حل CAPTCHA واقعی، login، متن،
تصویر، دریافت attachment، history، WSS احراز‌شده و رد Origin بیگانه موفق‌اند.
TLS 1.2/1.3 با CA/hostname واقعی و redirect HTTP 308 تأیید شدند. متریک‌ها پشت
توکن هستند و مسیر عمومی آن‌ها 404 است. message/upload واقعی در Prometheus
دیده شد و هر سه target برنامه، node و prometheus بالا هستند.

کانتینر واقعی تولید متوقف و **بازسازی** شد؛ تمام ردیف‌ها و فایل‌های upload و JWT
قبلی سالم ماندند. اکنون فقط دو حساب QA، یک مکالمه، چهار پیام و دو پیوست آزمایشی
وجود دارند؛ دادهٔ تاریخی وارد نشده و حساب مدیریتی پیش‌فرض ساخته نشده است.
credentialهای QA فقط در evidence خصوصی با دسترسی محدود هستند.

آزمون Android فیزیکی انجام نشده است. ابزار web خارج VPS به این دامنه دسترسی
نداشت؛ پذیرش زنده از DNS عمومی/TLS روی VPS و Chromium واقعی انجام شد.

## آرشیو و rollback

پس از توقف و اثبات PID صفر writer قدیمی، snapshot نهایی SQLite و uploadها و
کل release/venv قدیمی، environment، unit، Nginx و گواهی‌ها آرشیو شدند. هر ۴۰۶۲
فایل عادی با SHA256 بررسی و DB از archive استخراج و integrity/FK آن تأیید شد.

آرشیو نهایی: `/root/helix-decoupled-20261021/old-systemd-offline.tar.gz`

SHA256: `19d0b24e23f6649f1d449e2bc0602d640625e625d0e2e63d40b356c0cd030342`

آرشیو 0400 زیر دایرکتوری خصوصی root نگهداری می‌شود. نسخهٔ خارج میزبان تهیه نشده
است. اصل دادهٔ قدیمی در `/var/lib/helix-retired-20261021`، release قبلی در
`/opt/helix/releases/2aec7a584c18194a3e1c` و storage تازه در
`/var/lib/helix-docker/data` جدا هستند. `/var/lib/helix` اکنون placeholder خالی
متعلق به root با mode 000 است. marker و drop-in مانع شروع writer قدیمی می‌شوند.

تمرین خصوصی rollback دو DB مجزا موفق بود. در اجرای گاردشده نیز سه rollback
واقعی بدون اختلاط DB انجام شد: خواندن غیرترتیبی gzip، نیاز آزمون Promtool به
tmp و ناپدیدشدن unit موقت qualification اصلاح شدند. اعتبارسنجی archive اکنون
یک گذر ترتیبی دارد؛ آزمون قواعد قبل از maintenance در runner فقط‌خواندنی با tmpfs
جدا اجرا می‌شود. تمام تلاش‌های قبلی و خطاهایشان در evidence محفوظ‌اند.

rollback آماده از تولید Docker به runtime قبلی:

```sh
python3 /opt/helix-docker-production/infra/scripts/production-cutover.py \
  --manifest /root/helix-decoupled-20261021/release-manifest.json rollback
```

این دستور maintenance را فعال، writer Docker را متوقف، اصل دایرکتوری قدیمی را
به مسیر قبلی برمی‌گرداند، guard را پاک و systemd/مسیر قبلی را فعال می‌کند.
DB و uploadهای Docker در محل خود حفظ می‌شوند؛ هیچ archive روی DB تازه restore
نمی‌شود. داده‌های ایجادشده پس از cutover به DB قدیمی merge نمی‌شوند.

## شواهد و Git

شواهد کامل، manifest مهرشده، journal تراکنش، اسکن‌های خام، probeها، screenshot،
حساب‌های QA و archiveها در `/root/helix-decoupled-20261021` هستند. manifest دقیق
اجرای موفق با نام `release-manifest.executed.json` حفظ شده؛ manifest عملیاتی
پس از توقف proxy آزمایشی با اصلاح همان نام unit به‌روزرسانی شده است. artifact
برنامه تغییر نکرد. خلاصهٔ بدون secret در
[`final-cutover-status.json`](final-cutover-status.json) ثبت شده است.

مجوز اتصال GitHub برای این مخزن `pull=true` و `push=false` است؛ میزبان نیز در
تلاش قبلی credential نداشت. تغییرات بررسی‌شده محلی commit و bundle می‌شوند؛
push بدون مجوز انجام نمی‌شود. شناسهٔ commit نهایی در گزارش تحویل ثبت می‌شود.
