# Production inventory — 2026-10-20 UTC

This inventory was recorded before infrastructure/application changes. This
session sees the VPS filesystem through a restricted execution sandbox; it is
not a systemd host session. On-disk configuration is evidence of intent, not
proof of an active process or a successful HTTPS response.

| Item | Observed configuration | Live verification |
| --- | --- | --- |
| Host | `srv8467792069`, Ubuntu 24.04.5 LTS | Process/network namespace restricted |
| Source | `/root/helix`, baseline `12617db`, clean at audit | Local Git inspected |
| Selected release | `/opt/helix/current` → `/opt/helix/releases/2aec7a584c18194a3e1c` | Running release unknown |
| Release identity | `.helix-build.json`, full fingerprint in `audit-evidence.json`; retained assets checked against marker | Public assets inaccessible |
| API | `/etc/systemd/system/helix.service`, user/group `helix`, one uvicorn worker, `wsproto`, `127.0.0.1:8000` | systemd bus denied |
| Hardening | NoNewPrivileges, PrivateTmp, ProtectHome, ProtectSystem=strict, UMask 0077, writable `/var/lib/helix` | Config inspected |
| Nginx | `/etc/nginx/sites-enabled/helix.localip.ir.conf` → sites-available; default site also enabled | Reload/test not attempted |
| TLS | `/etc/letsencrypt/live/helix.localip.ir/{fullchain,privkey}.pem`, TLS 1.2/1.3 | Expiry/live chain not yet verified |
| Renewal | Certbot webroot `/var/www/helix-acme`, renewal config and deploy hook `renew-helix` retained | Timer/renewal dry-run pending |
| Frontend | Nginx root `/opt/helix/current/smooth/frontend/dist`, SPA fallback, immutable asset cache, no-cache HTML | On-disk assets match retained marker |
| API proxy | HTTP/1.1, trusted X-Forwarded-* overwritten, 5s connect / 120s read timeout | Pending |
| WebSocket | exact `/ws`, Upgrade + Connection, Origin passed, 3600s read/send, buffering off | Real socket test denied by sandbox |
| Limits/headers | Nginx 10m; app image 8 MiB; nosniff and same-origin Referrer-Policy | Config inspected |
| SQLite | `sqlite:////var/lib/helix/smooth.db` from persistent environment and guarded tooling | File access denied; integrity unknown |
| Uploads | `/var/lib/helix/uploads` | Directory access denied; contents not inventoried |
| Secrets | `/etc/helix/production.env`; key values never printed/copied into repo; JWT key retained, CAPTCHA derives from it unless overridden | Keys/path settings inspected without values |
| Docker | No docker executable, daemon/socket or Compose available; existing Railway Dockerfile specifies root runtime and mutable base tags | Container tests blocked |
| Release tooling | `/root/helix-phase21.1/release/phase20.4/controlled-release.py`, pinned approval/seal, host preflight, non-root builds, quiesced DB/upload backup, migration/old-code rehearsal, release lock, guarded activation | Inspected, not invoked with apply |
| Rollback | Retained releases and systemd service; existing guard validates old code against current migrated data; never blindly restores DB | Docker transition requires new review |

`systemctl` fails with “Operation not permitted”; IPv4 socket creation fails
with EPERM; DNS for helix.localip.ir and github.com is unavailable. `/etc`,
`/opt` and `/var/lib` are read-only/protected in this session. No production
backup, service health, database integrity, successful push, deployment or
rollback is claimed. Old reports describe earlier runs and are not current
verification. The existing release guard pins another candidate and MUST NOT
be repurposed or bypassed for this Docker transition.

Before cutover, repeat `infra/scripts/audit-host.py` in the real host session,
confirm the PID, cwd, environment file, bound port, release fingerprint and
public asset identity agree. Capture `nginx -T`, service units, timers, TLS
expiry and release seals into a root-only evidence directory outside Git.
