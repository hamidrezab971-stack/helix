# بازتأیید مستقل تولید HELIX — ۲۱ اکتبر ۲۰۲۶، ساعت ۱۵:۵۶ UTC

APPLICATION: **DEPLOYED — DOCKER PRODUCTION VERIFIED**

OBSERVABILITY: **PARTIAL — PROMETHEUS ACTIVE, GRAFANA ISOLATED/SUSPENDED**

در آغاز این بازبینی، cutover مجاز قبلاً در ساعت ۱۴:۴۳ تکمیل شده بود و commit
محلی `d4b2279a42bd025d691c2980a81f3b895d5f4e41` وجود داشت. وضعیت واقعی میزبان
با گزارش انتشار تطبیق داشت. bootstrap، مهاجرت، cutover، بازسازی کانتینر و
آزمون‌های کامل بدون علت تکرار نشدند؛ برنامه و تنظیمات اجرایی تغییر نکردند.

## تولید و پذیرش زنده

میزبان واقعی `srv8467792069` و مسیر فعال
`https://helix.localip.ir → Nginx → 127.0.0.1:18000 → Docker` تأیید شدند.
fingerprint برنامه:

`helix@sha256:4a1472f45e955cba7ea2bfefe4554e4d52e57ee8053214d2a4c3d03602618049`

OCI config همان `sha256:0bab97dec7835a90be631491cc9be015b7a505ac571be0346356e9ab14cb7772`
است؛ source backend با artifact و محتوای عمومی HTML/JS/CSS با manifest برابرند.
سه سرویس `app`، `prometheus` و `node-exporter` سالم‌اند و restart count هر سه صفر
است. هر سه target پایش `up` هستند؛ Prometheus خطای reload ندارد و alert فعال ندارد.
collector فعال است و دادهٔ تازه منتشر می‌کند. هر ۵۷ بررسی runtime موفق شدند.

آزمون تازه روی HTTPS عمومی با دو حساب QA موجود انجام شد: CAPTCHA واقعی و login،
اعتبار JWT، WSS احراز‌شده، ارسال متن و تصویر، دریافت دقیق بایت‌های پیوست، رد
Origin بیگانه، TLS 1.2/1.3، redirect صحیح HTTP 308، fingerprint تمام assetها و
ثبت پیام/پیوست در متریک‌های واقعی موفق بودند. مسیرهای عمومی metrics، internal،
docs، openapi و فایل مخفی 404 هستند؛ metrics خصوصی به توکن نیاز دارد.

SQLite و FK سالم‌اند. اکنون دو حساب QA، یک مکالمه، شش پیام و سه پیوست وجود دارد؛
بازبینی زنده یک متن و یک تصویر QA اضافه کرد. دادهٔ تاریخی وارد نشده است.
آزمون قبلی persistence با بازسازی واقعی کانتینر، حفظ ردیف‌ها، upload و کلید JWT
در شواهد اصلی موجود و هش آن معتبر است. در این بازبینی restart انجام نشد.

## امنیت مستقل برنامه و پایش

گزارش خام Trivy و DB رسمی `2026-10-21T07:13:45Z` هنوز در مهلت ۲۴ ساعت گیت
بودند. هر ۴۴ ردیف High، شامل هشت CVE، دوباره با review فردی، شناسهٔ config و
هش اسکن تطبیق داده شد. Critical برنامه صفر است. probe تازهٔ image، تطبیق source
و entrypoint، و بررسی process واقعی تولید موفق‌اند: فقط یک Uvicorn، UID/GID
10001، پنج مجموعهٔ capability صفر، NoNewPrivs=1 و Seccomp=2. process برنامه
libacl بارگذاری‌شده یا FD مربوط به cgroup میزبان ندارد؛ ابزار/daemonهای مستثنا
همچنان غایب‌اند. root فقط‌خواندنی، نبود SUID/SGID و fstab عملیاتی، kernel 6.8 و
نبود مسیر فراخوانی آسیب‌پذیر، مبنای ارزیابی هر ردیف باقی مانده است.

گیت مستقل برنامه مجدداً **PASS — REVIEWED APPLICATION SECURITY** شد.
هیچ ریسک مادی پذیرفته نشد. خروجی خام گیت شمارش شدت نیز دوباره تولید شد و عمداً
**NO-GO** باقی ماند؛ ignore، حذف metadata یا کاهش آستانهٔ شدت انجام نشد.

| جزء | High خام | نتیجه در محدودهٔ بررسی‌شده |
| --- | ---: | --- |
| HELIX | 44 | بررسی فردی کامل؛ پیش‌شرط‌های بهره‌برداری در runtime مقید برقرار نیستند |
| Grafana | 11 | حل‌نشده؛ سرویس معلق و بدون listener یا مسیر عمومی |
| Prometheus | 2 | یک CVE مربوط به xDS gRPC؛ سرویس فقط HTTP خصوصی با scrapeهای static دارد |
| Node Exporter | 0 | سالم؛ listener فقط `172.30.212.1:19100` |

API رسمی GitHub و رجیستری دوباره بررسی شدند. آخرین release مشاهده‌شده همچنان
[Grafana 13.2.4](https://github.com/grafana/grafana/releases/tag/v13.2.4) است و digest
image رسمی تغییر نکرده است:
`sha256:dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f`.
باینری `/usr/share/grafana/bin/grafana` از همین image، بدون اجرای سرویس، مجدداً
استخراج و SHA256 آن با باینری بررسی‌شده تطبیق داده شد. اجرای تازهٔ
`go version -m` وابستگی واقعی `kin-openapi v0.144.0` را تأیید کرد؛ کف لازم
`v0.149.0` است. go.mod رسمی چهار release پشتیبانی‌شده نیز دوباره بررسی شد:
13.2.4 و 13.1.8 دارای 0.144.0؛ 13.0.11 و 12.4.13 دارای 0.147.0 هستند.

artifact رسمی، پشتیبانی‌شده، اصلاح‌شده و دارای امضای تأییدشدهٔ مناسب پیدا نشد؛
ادعای تأیید امضای image مطرح نمی‌شود. Grafana فعال نشد. volume، archive، ۲۶
پنل، ۳۰ query و provisioning محفوظ‌اند. binary شخص ثالث ساخته نشد و تنظیمات
تأیید امضای plugin تضعیف نشد. این deliverable همچنان ناقص است.

## writer، archive، rollback و آزمون‌های کامل

قفل writer واقعاً در اختیار process تولید است. فقط یک کانتینر storage تازه را
mount کرده؛ systemd قدیمی inactive با PID صفر است. marker و drop-in مانع شروع
writer قدیمی می‌شوند. مسیر قدیمی placeholder خالی root با mode 000 است؛ دادهٔ
قدیمی در `/var/lib/helix-retired-20261021` جدا مانده است. modeهای 0700/0600 و
مالکیت storage، کلیدهای signing تازه و ماندگار، متفاوت‌بودن کلیدها، origin و
حفاظت فایل‌های secret مجدداً تأیید شدند؛ هیچ مقدار secret در گزارش ثبت نشد.

آرشیو `/root/helix-decoupled-20261021/old-systemd-offline.tar.gz` با mode 0400
زیر دایرکتوری خصوصی root حفظ شده است. SHA256 آن دوباره تأیید شد:

`19d0b24e23f6649f1d449e2bc0602d640625e625d0e2e63d40b356c0cd030342`

تمام ۴۰۶۲ فایل عادی archive در یک گذر با manifest هش تطبیق داده شدند؛ integrity
و FK دیتابیس استخراج‌شده نیز سالم‌اند. نسخهٔ خارج میزبان وجود ندارد.
۹۴ فایل مهرشدهٔ release و همهٔ لاگ‌های qualification بدون تغییرند: ۱۴۸ backend،
۹۹ frontend، یک interop، هشت فاز Chromium، ۱۱ security و ۲۰ safety موفق بودند.
خطای اولیهٔ Chromium و اجرای کامل موفق بعد از آن هر دو حفظ شده‌اند.

تمرین rollback به دیتابیس قدیمی مجزا و rollbackهای واقعی اجرای قبلی ثبت شده‌اند؛
runtime قدیمی و اسکریپت عملیاتی بدون تغییر موجودند. دستور rollback همچنان:

```sh
python3 /opt/helix-docker-production/infra/scripts/production-cutover.py \
  --manifest /root/helix-decoupled-20261021/release-manifest.json rollback
```

این مسیر ابتدا writer Docker را متوقف می‌کند، دیتابیس و upload تازه را حفظ
می‌کند و runtime/مسیر قدیمی را برمی‌گرداند. هیچ دیتابیس روی دیگری restore یا
merge نمی‌شود؛ داده‌های پس از cutover به دیتابیس قدیمی منتقل نخواهند شد.

## شواهد و محدودیت‌ها

شواهد اصلی: `/root/helix-decoupled-20261021`.
شواهد این بازبینی: `/root/helix-production-recheck-20261021T155014Z`، شامل
گیت برنامه، audit runtime، پذیرش زنده، provenance باینری رسمی، وضعیت رجیستری،
گیت خام NO-GO، listenerها، Nginx و وضعیت واقعی پایش.

آزمون عمومی TLS/WSS با hostname و DNS عمومی از VPS انجام شد؛ ابزار web مستقل
به این دامنه دسترسی نداشت و Android فیزیکی آزمون نشده است. نخستین اجرای harness
با Python سیستم به‌دلیل نبود wsproto متوقف شد؛ همان verifier با venv موجود
اجرا و موفق شد، بدون نصب بسته یا تغییر سرویس تولید.

مجوز GitHub مجدداً `pull=true, push=false` بود. push انجام نشد. گزارش بازبینی
محلی commit و bundle می‌شود؛ شناسهٔ نهایی و checksum شواهد در `FINAL-RECHECK.json`
همین دایرکتوری ثبت می‌شوند. commit سورس runtime و manifest اجرای اصلی حفظ شدند.
