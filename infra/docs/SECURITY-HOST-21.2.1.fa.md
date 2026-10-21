# تحلیل امنیت اجرای واقعی Phase 21.2.1

این سند مکمل [گزارش میزبان](HOST-QUALIFICATION-21.2.1.fa.md) و جایگزین نتیجهٔ اسکن تاریخی نیست. شمارش نهایی، digestها و زمان DB در گزارش میزبان و JSON وضعیت ثبت می‌شوند. هیچ یافته‌ای ignore یا برای تولید پذیرفته نشده است. تمام severityها در JSON خام و فهرست triage خصوصی نگهداری می‌شوند؛ تعداد package/binary finding با تعداد CVE یا exploit مستقل برابر نیست.

## HELIX: هشت CVE و ۴۴ یافتهٔ High

نسخهٔ جدید واقعاً از remediation commit ساخته و اجرا شد. در فایل‌سیستم همین container، هیچ SUID/SGID، ابزار infocmp، مدیر systemd-homed یا ماژول Archive::Tar وجود ندارد. metadata بسته‌های نصب‌شده حذف نشد. UID:GID برابر 997:987، root فقط‌خواندنی، capabilities خالی و no-new-privileges فعال است. این کنترل‌ها اثبات رفع کد کتابخانه نیستند.

| یافته | پیش‌شرط و شواهد اجرای واقعی | patch و ریسک باقی‌مانده |
| --- | --- | --- |
| CVE-2026-76642؛ ۹ match از util-linux | سوءاستفادهٔ محلی از mount helper و post-hook با اختیار privileged؛ SUID و capability لازم در container فراهم نیست، fstab بدون ورودی مجاز است. | fixed package سازگار در Trixie گزارش نشده؛ exposure فعلی مقید، یافته باقی است. |
| CVE-2026-78408؛ ۹ match | اپراتور privileged باید nsenter --join-cgroup را علیه target مهاجم اجرا کند؛ چنین فراخوانی در برنامه یا پیکربندی وجود ندارد. | بدون fix پایدار Trixie؛ استفادهٔ privileged از ابزار در container نباید اضافه شود. |
| CVE-2026-78409؛ ۹ match | نیازمند Linux >=6.15 و X-mount.subdir مجاز در fstab؛ kernel میزبان 6.8.0-147 است و ورودی مربوطه وجود ندارد. | پیش‌شرط جاری برقرار نیست؛ fix پایدار گزارش نشده و یافته suppress نشد. |
| CVE-2026-78410؛ ۹ match | bind mount مبتنی بر fstab، مسیر قابل تغییر و SUID mount؛ کنترل‌های واقعی این پیش‌شرط‌ها را فراهم نمی‌کنند. | بدون fix پایدار؛ تغییر privilege یا mount policy ارزیابی مجدد می‌خواهد. |
| CVE-2026-54369؛ libacl1 | عملیات pathname ACL در caller privileged؛ برنامه چنین caller یا privilegeای ندارد. | اصلاح upstream 2.4.0 در ABI متفاوت است؛ ترکیب کتابخانهٔ unstable با Trixie آزمون‌شده نیست. |
| CVE-2025-69720؛ ۴ match ncurses | آسیب‌پذیری parser ابزار infocmp؛ executable از image ساخته‌شده حذف و فقدان آن در runtime تأیید شد. | کتابخانه‌ها و metadata ncurses حفظ شدند؛ بدون fixed package Trixie، scanner همچنان High گزارش می‌کند. |
| CVE-2026-16742؛ libsystemd0/libudev1 | مربوط به systemd-homed؛ executable آن در image و runtime وجود ندارد. | overmatch محتمل در سطح component؛ raw finding محفوظ است و blanket exception صادر نشد. |
| CVE-2026-9538؛ perl-base | parser ماژول Archive::Tar لازم است؛ این ماژول در runtime وجود ندارد و برنامه tar را با Perl پردازش نمی‌کند. | component مورد هدف غایب است؛ metadata و finding حفظ شدند. |

وضعیت fixed package باید در اجرای بعدی دوباره از [Debian Security Tracker](https://security-tracker.debian.org/tracker/) بررسی شود. نصب بستهٔ sid/forky صرفاً برای کاهش عدد اسکن، patch سازگار محسوب نمی‌شود.

## اصلاح Pillow و بسته‌های پایدار سیستم

اسکن میانی با DB ساعت 01:19، در Pillow 12.3.0 یک Critical (CVE-2026-112403) و شش High تازه یافت. [اعلان رسمی JPEG](https://github.com/python-pillow/Pillow/security/advisories/GHSA-8g5g-8vmr-9782) و [release notes نسخهٔ 13.0.0](https://pillow.readthedocs.io/en/stable/releasenotes/13.0.0.html) بررسی شدند. برنامه فقط JPEG/PNG/WEBP غیرمتحرک را می‌پذیرد، پیش از resize پیکسل‌ها را load می‌کند و draft، morphology و PDF append فراخوانی نمی‌کند؛ این محدودیت‌ها جایگزین patch کتابخانه نشدند. Pillow به 13.0.0 ارتقا یافت، wheel با SHA256 رسمی PyPI قفل شد و suite کامل backend/Chromium و جریان تصویر واقعی تکرار شدند. اسکن میانی 50 High/1 Critical محفوظ است؛ image نهایی یافته‌های Pillow را ندارد.

مخزن امضاشدهٔ Debian دو upgrade سازگار ارائه کرد: ca-certificates=20250419+deb13u1 و liblzma5=5.8.1-1+deb13u2. این نسخه‌های دقیق در Dockerfile نصب شدند و سه UNKNOWN مربوط به DSA-6572-1، DSA-6549-1 و TEMP-1147318-639065 حذف شدند. metadata واقعی dpkg حفظ شد. UNKNOWN مربوط به Perl Pod::Text بدون fix پایدار باقی است؛ HELIX ورودی POD یا formatter Perl ندارد و این محدودیت به‌عنوان اثبات حذف تمام call pathها یا exception تلقی نمی‌شود.

## پایش: اصلاح انجام‌شده و موانع واقعی

Node Exporter از همان tag v1.12.1 و commit ثبت‌شده ابتدا با Go 1.26.9 و سپس با **Go 1.26.10** و x/net 0.60.0 ساخته شد؛ ارتقای انتقالی x/crypto به 0.57.0 و x/text به 0.43.0 نیز در go.sum ثبت است. آزمون upstream و fixtureها در build نهایی موفق بودند. اسکن واقعی image انتخاب‌شده همهٔ ۱۴ High اولیه و یافتهٔ تازهٔ X509 را برطرف کرد و **High/Critical صفر** است. یک UNKNOWN مربوط به GO-2026-5932 در OpenPGP منسوخ x/crypto بدون fix باقی است. سرویس فقط collectorهای CPU، memory، filesystem، diskstats، netdev و textfile دارد و ورودی OpenPGP تعریف نشده؛ نبود مسیر قابل دسترس از API ارزیابی پیکربندی است و اثبات کامل call graph ادعا نمی‌شود.

Grafana اصلی v13.2.4 با پنج High در kin-openapi 0.144.0 باقی می‌ماند: CVE-2026-100349، -100351، -100352، -100353 و -100354. اصلاح 0.149.0 در patch سورس آماده شد، اما build محدود نهایی روی این میزبان هنگام link با signal killed شکست خورد. باینری ناقص نصب نشد. به‌دلیل احتمال دورزدن احراز هویت و validation DoS و اثبات‌نشدن نبود call path، این گروه **P1 و مانع انتشار** است؛ loopback جایگزین patch نیست.

دوازده datasource غیرفعال به‌صورت کامل از overlay جدید Grafana حذف شدند. این حذف واقعی component است؛ package inventory اسکنر دستکاری نشد. Prometheus تنها datasource provisionشده است. این تغییر ۵۲ High در باینری‌های بلااستفاده را هدف می‌گیرد؛ تعداد نهایی فقط از اسکن image انتخاب‌شده گزارش می‌شود. main binary رسمی و افزونهٔ فعال Prometheus دست‌نخورده‌اند.

افزونهٔ فعال Prometheus نسخهٔ 13.2.3 با امضای Grafana Labs چهار High از سه CVE دارد: CVE-2026-78667، CVE-2026-78669 در stdlib و x/net، و CVE-2026-97031. build محلی با Go 1.27.2 و x/net 0.60.0 و آزمون و Mage SDK موفق بود؛ checksum آن با MANIFEST امضاشدهٔ ناشر برابر نیست. این artifact نصب نشد. تنظیم unsigned/development یا دورزدن signature verification مجاز نشده و اعمال نشد. patch منتشرشده و معتبر ناشر، یا مسیر انتشار امضاشدهٔ بازبینی‌شده، لازم است.

| گروه | exposure و قابلیت سوءاستفاده | اقدام لازم |
| --- | --- | --- |
| Go HTTP Range؛ CVE-2026-78667 | HTTP/1 نیز مشمول است؛ برای باینری‌های دارای ServeContent/FileServer مسیر بالقوه باقی می‌ماند. خصوصی‌بودن endpoint تعداد مهاجمان را محدود می‌کند و اثبات رفع نیست. plugin فعال یک HTTP asset server مستقل پیکربندی‌شده ندارد. | Go 1.26.9 یا 1.27.2 در **هر** باینری و package امضاشدهٔ افزونه؛ اصلاح OS روی Go استاتیک اثر ندارد. |
| HTTP/2 SETTINGS؛ CVE-2026-78669 | scrape و datasource جاری HTTP خصوصی هستند؛ TLS عمومی در Nginx خاتمه می‌یابد. فعال‌سازی HTTP/2 یا target جدید ارزیابی مجدد می‌خواهد. | stdlib اصلاح‌شده و x/net >=0.60.0؛ نبود HTTP/2 فعلی exception خودکار نیست. |
| TLS ECH؛ CVE-2026-97031 | نیازمند مسیر server TLS در Go؛ سرویس‌ها و plugin فعال، TLS listener مستقل ندارند. | compiler اصلاح‌شده؛ حفظ یافته تا تأمین artifact معتبر. |
| gRPC xDS؛ CVE-2026-84445 | Prometheus/promtool اولیه grpc 1.83.1 دارند؛ xDS server در پیکربندی وجود ندارد. pluginهای بلااستفادهٔ Grafana حذف شدند. | grpc >=1.83.2؛ اگر build جدید Prometheus موفق و انتخاب شد، نتیجهٔ اسکن و تست همان image ملاک است؛ patch سورس به‌تنهایی رفع محسوب نمی‌شود. |
| Tempo و gRPC fragment در pluginهای حذف‌شده | datasource یا backend مربوطه دیگر در overlay انتخابی وجود ندارد؛ عدم شروع plugin و query فعال کنترل می‌شود. | raw scan قبل محفوظ؛ با اضافه‌شدن دوبارهٔ package باید دوباره scan شود. |

patchهای سورس Grafana و افزونه در `infra/security/` برای ادامهٔ کار نگهداری شدند و **qualified runtime artifact نیستند**. نتیجهٔ build نهایی Prometheus، compilerهای pinned، commitها و artifactهای واقعاً انتخاب‌شده در `qualified-inputs.json` ثبت می‌شوند. buildها از checksum verification استاندارد Go استفاده کردند؛ mirror fallback اعتبار checksum را خاموش نکرد.

## یافتهٔ افزوده‌شده در DB نوبت دوم

DB ساعت 07:13 UTC همان روز، CVE-2026-111943 / GO-2026-6809 را برای denylist گواهی‌های میانی نامعتبر در crypto/x509 اضافه کرد. نسخهٔ اصلاح‌شدهٔ compiler اکنون **Go 1.26.10 یا 1.27.3** است؛ حداقل‌های قدیمی 1.26.9/1.27.2 در جدول بالا فقط به CVEهای قبلی مربوط‌اند. دادهٔ رسمی [Go vulndb](https://github.com/golang/vulndb/blob/master/data/osv/GO-2026-6809.json) خصوصی نگهداری شد. source/compiler به‌تنهایی رفع در runtime نیست.

در پیکربندی جاری Node Exporter ورودی/خروجی TLS و اتصال HTTPS به target ندارد. Prometheus و datasource فعال Grafana نیز HTTP خصوصی دارند؛ تنظیم target HTTPS، proxy TLS یا منبع دادهٔ جدید ارزیابی مجدد می‌خواهد. هیچ exception صادر نشد. این CVE دو match به Prometheus و دو match به Grafana اضافه کرد؛ ازاین‌رو شمارش نهایی آن‌ها با DB جدید ۱۲ و ۱۱ High است. Node Exporter واقعاً با Go 1.26.10 دوباره ساخته، جایگزین و اسکن شد؛ عدد صفر نهایی مربوط به digest تازهٔ ثبت‌شده است.

## یافته‌های دیگر و تصمیم

فهرست کامل Low/Medium/Unknown با installed/fixed version، binary target، شرح scanner و منبع اولیه بیرون Git محفوظ است. وجود fix در یک module الزاماً به معنی دسترسی exploit در سرویس نیست؛ هیچ گروه بررسی‌نشده‌ای بی‌خطر اعلام نشده است. triage خصوصی برای هر finding وضعیت fix و نوع exposure (مسیر ابزار محلی، API فعال، component حذف‌شده یا reachability اثبات‌نشده) را ثبت می‌کند. اصلاح Highهای قابل patch اولویت انتشار دارد و همهٔ severityها باید در چرخهٔ بعدی بازبینی شوند.

gate فعلی روی هر High/Critical شکست می‌خورد. کاهش تعداد، موفقیت آزمون‌ها و کنترل‌های container مجوز خودکار تولید نیستند. ورود حساب اصلی، بستن مراحل guard/manifest تراکنش و تأمین artifactهای امنیتی معتبر همچنان پیش‌شرط تصمیم‌اند.
