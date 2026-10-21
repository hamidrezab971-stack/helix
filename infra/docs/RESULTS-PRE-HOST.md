# Execution results — 2026-10-20 UTC

Candidate source branch: `phase21.2-production-observability`, based on
`12617db`. This is an implementation/preparation result, **not a successful
production deployment or a fully accepted Docker migration**.

| Check | Actual outcome |
| --- | --- |
| Initial infrastructure audit | On-disk inventory and selected release asset checksum comparison completed before edits; active running release not verifiable |
| Existing backend regressions | 144 passed, 700.394 seconds, no failures/skips |
| Added real ASGI metrics/auth/WS/multipart/history checks | 4 passed, 16.908 seconds, no failures/skips |
| Separate Phase 21.1 real multipart HTTP suite | 3 passed, 31.576 seconds |
| Persistence safety checks | 7 passed: snapshot continuity, changed/deleted rows, symlinks, corrupt DB, production quiescence gate, empty DB refusal, root refusal |
| Existing frontend tests | 98 passed, no failures/skips |
| React production build | Passed with retained Node 22.23.3 and npm lock |
| Python dependency hash lock | Full runtime closure resolved from retained wheels with --require-hashes; offline clean-venv installation and pip check passed |
| JSON dashboards / YAML files | Parsed; static privacy/resource/one-replica assertions passed; this is not Compose/promtool runtime validation |
| Python / JavaScript script syntax | compileall and node --check passed |
| Full existing browser suite | Attempted; first bind to loopback 5173 failed with EPERM; no Chromium result claimed |
| Standalone Nginx rehearsal config | nginx reports syntax OK, then socket() EPERM; full nginx -t failed, no listener/reload attempted |
| Docker build / Compose start / health | Blocked: docker executable/daemon/Compose absent; host installation paths read-only |
| Valid exposition checked by promtool | Pending real Docker execution; actual ASGI exposition tested, no mocked replacement |
| Prometheus actual targets | Not deployed; no up status claimed |
| Grafana datasource/dashboard observations | Not deployed; no successful live query claimed |
| Container persistence / Docker-to-systemd rollback drill | Harness/procedures implemented; execution pending real host and verified production copy |
| Fresh production backup / integrity / upload hashes | Blocked by data access; no backup or integrity success claimed |
| Production login/CAPTCHA/WS/media/history | Not tested live in this session; isolated tests are not production proof |
| DNS / TLS / Nginx / runtime cutover | Not changed |

The isolated transport checks use the existing external, test-only 10 ms asyncio
wake adapter at `/root/helix-phase21.1/qa-runtime/sitecustomize.py`, because this
sandbox denies socketpair wake writes. It changes no app/HTTP/auth/database
function or assertions and is excluded from the repository and images. Actual
HTTP routing, real signed CAPTCHA, JWT, multipart images, SQLite persistence and
ASGI WebSocket frames are exercised. These tests cannot establish real network,
Nginx, Docker or browser integration.

Private local logs/evidence are retained in `/root/helix-phase21.2/` outside Git.
The host inventory script reports PID 1 is not systemd, denied IPv4 sockets,
unavailable host bus and unavailable Docker. The deployment-selected path on
disk is `/opt/helix/releases/2aec7a584c18194a3e1c`; it is not a verified running
process. Database/uploads were not opened or modified.

Registry connectivity is unavailable from the execution shell; immutable base
and service digests remain unresolved. The configuration intentionally refuses
to deploy without them. Selecting reviewed exact image versions, resolving and
preserving their actual registry digests remains a release gate. No fabricated
SHA256 values or mutable default images are supplied.

GitHub read access was checked through the connected GitHub app: pull=true,
push=false. Shell git access also fails DNS resolution for github.com. A plugin
search for SSH/remote terminal returned no relevant capability; it is not proof
that no such plugin exists in the directory. Commit/push details are reported
with the final Git result; no remote success is implied by the local commit.

Remaining gates: real VPS execution with systemd/Docker/network/data access,
verified backups and baseline continuity, registry digest lock, complete browser
and real-stack tests, retained-account compatibility, tested reversible route
switch and old-runtime rollback, followed by explicit production authorization
for the exact reviewed transaction in MIGRATION.md. Monitoring alert rules are
provisioned in source; external notification delivery is not configured.
