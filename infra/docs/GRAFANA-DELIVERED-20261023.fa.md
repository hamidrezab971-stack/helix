# تحویل امن Grafana — ۲۰۲۶/۱۰/۲۳

**DEPLOYED** — Grafana واقعی در `https://helix.localip.ir/grafana/` از مسیر خصوصی مدیر با TLS معتبر، احراز هویت لبه و ورود Grafana بررسی شد. دسترسی عمومی به همین مسیر عمداً `403` است.

| مورد | نتیجهٔ واقعی |
| --- | --- |
| میزبان | DNS و HTTPS گیت‌هاب سالم؛ API برابر 200؛ پاسخ احراز هویت استاندارد GHCR برابر 401؛ Docker daemon در دسترس |
| GitHub | ورود CLI حساب `hamidrezab971-stack` معتبر؛ مجوز مخزن `push/admin` و Actions فعال؛ انتشار GHCR با `GITHUB_TOKEN` دارای `packages:write` موفق |
| ساخت و انتشار | [Actions 40028282120](https://github.com/hamidrezab971-stack/helix/actions/runs/40028282120)، هر دو job موفق |
| بازبینی | [PR شمارهٔ ۲](https://github.com/hamidrezab971-stack/helix/pull/2) پس از بررسی فنی و سبزشدن همهٔ checkها merge شد؛ commit برابر `c91d4949eafda267f6ca5c2f1336e7008dfc9d19` |
| وابستگی واقعی | باینری Grafana شامل `kin-openapi v0.149.0` با Go `1.26.10`؛ افزونهٔ رسمی Prometheus `13.2.4` با Go `1.27.3` و `x/net v0.61.0` |
| امنیت ایمیج | اسکن کامل و تازهٔ Trivy: HIGH=0، CRITICAL=0، MEDIUM=0، UNKNOWN=1؛ هیچ finding یا شناسه‌ای مستثنا نشده است |
| امضای افزونه | PGP ناشر، هر ۲۰۳ فایل manifest و وضعیت واقعی `valid / grafana` در runtime تأیید شد |
| امضا و provenance | OIDC دقیق workflow و SHA ساخت، گواهی، شواهد transparency log، همهٔ هش‌های artifact و زنجیرهٔ کامل manifest/config/layer روی VPS دوباره تأیید شدند |
| runtime | `helix-production-grafana-1` سالم؛ همان digest منتشرشده، پورت فقط `127.0.0.1:13000`، فایل‌سیستم اصلی فقط‌خواندنی و اجرای بدون privilege |
| مرورگر | ورود مدیر، کوکی `Secure / HttpOnly / SameSite=Lax` با مسیر `/grafana`، عنوان هر ۲۶ پنل و پاسخ موفق و متناهی هر ۳۰ کوئری پاس شدند |
| Grafana Live | اتصال WebSocket و پاسخ موفق پروتکل در `wss://helix.localip.ir/grafana/api/live/ws` پاس شدند |

مرجع immutable منتشرشده و مستقرشده:

```text
ghcr.io/hamidrezab971-stack/helix-grafana@sha256:1386cfea0081497a6608e5947f208bf7d8e91cd180293eab75d01dd69b75a5d9
```

مرورگر احراز هویت‌شده هر سه داشبورد را از URL واقعی HTTPS نمایش داد؛ تصاویر نیز بازبینی شدند:

| داشبورد | پنل | کوئری |
| --- | ---: | ---: |
| Service Health | 9 | 9 |
| VPS Infrastructure | 7 | 9 |
| HELIX Application | 10 | 12 |
| مجموع | 26 | 30 |

یافتهٔ خام باقی‌مانده `GO-2026-5932` مربوط به بسته‌های OpenPGP منسوخ در ماژول x/crypto است. ابزار رسمی `govulncheck v1.9.0` برای هر دو executable هیچ نماد آسیب‌پذیر یا package آسیب‌پذیر واردشده‌ای پیدا نکرد. دو هشدار قدیمی سطح ماژول AWS S3 Crypto (`GO-2022-0646` و `GO-2022-0635`) نیز در گزارش کامل ابزار حفظ شده‌اند؛ آن‌ها هم در کد بررسی‌شده package یا نماد آسیب‌پذیر ندارند. Grafana برای امضای افزونه از fork نگهداری‌شدهٔ ProtonMail استفاده می‌کند. Brotli، musl و zlib با بسته‌های امضاشدهٔ اصلاح‌شدهٔ Alpine به‌روز شدند.

این artifact ساخت اصلاح‌شدهٔ HELIX است. برای image پایهٔ upstream ادعای امضای OCI ناشر نشده است؛ digest آن ثابت است و image نهایی امضا و provenance workflow HELIX را دارد. کل افزونهٔ فعال امضای Grafana را حفظ کرده و تنظیم پذیرش افزونهٔ unsigned فعال نشده است.

CDN متادیتای Sigstore روی این میزبان `403` داد. `cosign initialize` با mirror رسمی `https://sigstore.github.io/root-signing/`، root تعبیه‌شدهٔ Cosign و اعتبارسنجی عادی TUF موفق شد. بررسی مستقل امضا و attestation از بستهٔ کامل OCI با شواهد آفلاین transparency log انجام شد؛ اعتبارسنجی گواهی، issuer، workflow، SHA و claimهای digest غیرفعال نشد. نداشتن scopeِ `read:packages` در CLI با انتقال artifact احراز هویت‌شده و تأیید همان manifest حل شد؛ ورود مجدد درخواست نشد و credential مربوط به CI به VPS منتقل نشد.

دسترسی مدیر دو لایه دارد: در لبه کاربر `helix-monitoring` و سپس در Grafana کاربر `helix-admin`. رمزها فقط در فایل‌های محافظت‌شدهٔ `/etc/helix/docker-secrets/monitoring_password` و `/etc/helix/docker-secrets/grafana_password` هستند. برای مرورگر مدیر، از SSH موجود یک تونل loopback بسازید:

```sh
ssh -N -L127.0.0.1:8443:127.0.0.1:443 SSH_USER@VPS
google-chrome --user-data-dir="$HOME/.helix-grafana-admin" --host-resolver-rules="MAP helix.localip.ir 127.0.0.1:8443" https://helix.localip.ir/grafana/
```

جایگزینی پورت در resolver مرورگر با TLS معتبر و بدون نادیده‌گرفتن خطای گواهی آزمایش شد. دسترسی عمومی حتی با رمز صحیح و هدرهای جعلی loopback رد می‌شود. آزمون واقعی دسترسی ۱۹ بررسی موفق داشت: عمومی `403`؛ خصوصی بدون رمز یا با رمز غلط `401`؛ ورود معتبر `200`؛ redirect مجاز `308`. رابط Prometheus و مسیرهای metrics/internal عمومی همچنان `404` هستند.

فقط Grafana راه‌اندازی شد. شناسه، image و mountهای سه کانتینر قبلی برنامه، Prometheus و node-exporter ثابت و سلامت آن‌ها حفظ شد. volumeهای موجود و دیتابیس برنامه تغییر نکردند؛ Grafana volume مستقل خود را دارد. تعریف شبکه‌ها، secrets و دیگر سرویس‌های Compose و مسیرهای برنامه در Nginx یکسان ماندند.

در پیش‌بررسی محلی، فایل مستقل syntax که من ساخته بودم مسیرهای موقت Nginx را جدا نکرده بود و مالکیت آن مسیرها را به `nobody` تغییر داد؛ یک پاسخ JavaScript ناقص شد. مالکیت هر پنج مسیر با تنظیم production به worker واقعی بازگردانده شد و مسیرهای موقت فایل پیش‌بررسی جدا شدند. workerها و مسیرهای برنامه هنگام اصلاح ثابت ماندند. دریافت کلاینت کند با طول و SHA256 صحیح و بررسی بیرونی مرورگر پس از اصلاح پاس شدند. تست ایزولهٔ موجود مخزن از ابتدا مسیرهای موقت مستقل داشت و تغییر نکرد.

یک alert واقعی و قدیمی `HostLowDiskSpace` با شدت `critical` از ساعت `20:45:42 UTC`، پیش از شروع این اجرا، فعال است؛ حدود `11.7%` فضای root آزاد است. پنل آن را درست نمایش می‌دهد. پاک‌سازی این وضعیت خارج از تحویل Grafana است؛ فایل‌های تولید، volumeها و آرشیوهای قبلی حذف نشدند. فقط کپی‌های انتقالی و image میانی ایجادشده در همین تحویل، پس از اثبات برابری با manifest امضاشده، حذف شدند.

شواهد خام، گزارش مرورگر، سه تصویر و رسیدهای بررسی مستقل در مسیر خصوصی زیر نگه‌داری می‌شوند؛ credential، cookie، HAR یا trace ورود در Git ذخیره نشده است:

```text
/root/helix-grafana-host-20261023T205337Z/
```
