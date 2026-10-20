# Real-host qualification results — 2026-10-20 UTC

**Private qualification: PASS. Public production migration: NO-GO.**
Production is still the original systemd application. Monitoring observes the
candidate and actual host; candidate application traffic is isolated QA traffic,
not production user traffic. Initial restricted-session results are preserved in
[RESULTS-PRE-HOST.md](RESULTS-PRE-HOST.md).

| Executed check | Actual outcome |
| --- | --- |
| Full backend | 148 tests passed in 816.700 seconds; no failures/skips in completed run |
| Frontend unit/component | 98 passed with retained Node 22.23.3; clean npm ci and production build succeeded |
| ALTCHA interoperability | Actual bundled JS PBKDF2 worker and Python verifier passed |
| Chromium | All 8 phases executed on Chromium 156.0.8078.4 / Playwright 1.64.1; first 6 passed in full run; phase204 blank fixture timeout retained, then phase204 + phase211 passed independently without assertion changes |
| Backup safety tests | 8 passed, including explicit online-only classification and quiescence guard |
| Container build | Reviewed app, npm lock, CPython 3.12.15, hash-verified offline wheels; final Debian 13 image built successfully; pip check passed |
| Compose/runtime | 4/4 services healthy; actual non-root/read-only/capability/resource/storage checks passed |
| Prometheus | promtool config, 5 alert rules and actual metrics exposition passed; helix/node/prometheus targets all up |
| Grafana | All 30 panels queried through real Grafana datasource and Prometheus APIs: application 12, infrastructure 9, services 9; real frames returned; empty firing-alert series allowed when no alert fires; all three UIs rendered and screenshots retained |
| Real application path | Actual CAPTCHA/register/login, text, PNG upload/retrieval, rejected malformed upload, WS/presence and history passed through private Nginx |
| TLS compatibility | Real certificate CA/SNI validated; actual CAPTCHA/login + authenticated WSS + text delivery + old image retrieval passed; foreign WebSocket Origin rejected; sensitive paths 404; no-cache HTML and 11 retained immutable assets verified |
| HTTP size / CORS | Actual private Nginx path rejected 9 MiB at app with JSON 413 and 11 MiB at Nginx with HTML 413; allowed Origin preflight 200, foreign Origin 400 without allow-origin |
| Restart | Pre-restart SQLite rows and upload hashes preserved; final image authenticated WS closed cleanly with 1012 on SIGTERM; API recovered in 2.909 s from restart command |
| Old-runtime rollback | Two complete final-image container→old systemd runtime→container drills on the same isolated current data, with real login/CAPTCHA/WS/new writes/history/media after every switch |
| Original data continuity | All 20 tables exact immediately after initial migration; after QA writes, all 16 durable original tables exact and all 8 original upload hashes preserved; allocation cursor advances, three expiring auth tables explicitly excluded from after-traffic equality |
| Production safety | Original PID 261758, zero restarts; Nginx/unit/release marker hashes and production environment bytes unchanged; final live SQLite integrity/FK checks and public HTTPS health pass |
| Image vulnerability scan | Actual Trivy 0.76.0, fresh vulnerability DB, every runtime image scanned; see security findings below |
| Known production account login | NOT VERIFIED: protected retained-account credential not supplied; new disposable accounts do not satisfy this gate |
| Public cutover / live rollback | NOT EXECUTED; explicit approval required after remaining gates |

Initial attempts with the default Node 18 and an incomplete/wrong-cwd Python
venv failed and are retained separately; they are superseded only by the actual
successful Node 22 / qualified-venv runs above. Direct Chromium downloads were
geographically denied; the current browser came from Microsoft's official pinned
Playwright image, digest
`sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf`.
The initial Docker-only internal network did not publish loopback ports; the
reviewed ingress bridge fixes that without public bindings. Docker package
installation did not upgrade unrelated services. Registry TLS verification and
Python/npm integrity checks were never disabled.

## Immutable runtime identities

Candidate build source: `20e6f20d9d6ecbdae0e855f8c1fbed338e092df2`; application implementation
remains the reviewed e2a53c9 source. Later changes are qualification/docs/dashboard
formatting. Final app reference:

`helix@sha256:aa9dbf55ad94b1f8102e511349734f416ee83e1158b8c9f8416ca1d287f165d4`

This is a locally built immutable Docker image, not a registry publication.
Compose now uses its digest, and no further build overwrote it.

| Input | Exact resolved reference |
| --- | --- |
| NODE | `node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` |
| PYTHON | `python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1` |
| PROMETHEUS | `prom/prometheus:v3.13.4@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e` |
| GRAFANA | `grafana/grafana:13.2.4@sha256:dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f` |
| NODE_EXPORTER | `prom/node-exporter:v1.12.1@sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0` |

## Security findings and NO-GO gates

The original Debian 12 candidate had 2 Critical / 61 High findings. The final
Debian 13 candidate has **0 Critical / 44 High** package findings, corresponding
to **8 unique High CVEs**, plus 68 Medium, 63 Low, 3 Unknown. No High/critical
fixed package version is supplied by the scanner for that final application
base. The raw scan is retained without suppressions. The eight IDs are:
CVE-2025-69720, CVE-2026-16742, CVE-2026-54369, CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410, CVE-2026-9538.

The remaining app findings concern mount/nsenter/ACL/ncurses/systemd-homed/Perl
code. Dropped capabilities, non-root identity, read-only root and no-new-privileges
reduce relevant local privilege paths; this is not proof of non-exploitability
and does not silently accept the findings. Debian identifies the old zlib
MiniZip finding as unbuilt in Bookworm binaries, and the SQLite issue as fixed
in Trixie: [zlib advisory](https://security-tracker.debian.org/tracker/CVE-2023-45853),
[SQLite advisory](https://security-tracker.debian.org/tracker/CVE-2025-7458).

| Runtime image | Critical | High package findings | High findings with fixes reported |
| --- | --- | --- | --- |
| HELIX final | 0 | 44 (8 unique CVEs) | 0 |
| Prometheus | 0 | 10 (4 unique CVEs) | 10 |
| Grafana | 0 | 61 (12 unique CVEs) | 61 |
| Node Exporter | 0 | 14 (13 unique CVEs) | 14 |

Monitoring findings include newer Go stdlib/module fixes than the selected
published binaries. Use reviewed patched upstream images or an explicit,
documented exposure/exception review before a public release decision. No
vulnerability-free status is claimed. The private monitoring listeners remain
restricted throughout. External alert notification delivery and off-host backup
storage are not configured or verified.

Other remaining gates: retained-account credential verification against the
candidate and previous runtime; a newly approved manifest/guard integration
(the old sealed guard pins a different release); a fresh quiesced final backup
and revalidation in the authorized window; explicit user cutover approval.

## Timing

Final isolated command-to-healthy API handoffs: container→old
1.938 / 1.898 s;
old→container 2.846 / 2.780 s.
These include stop/start/route reload until successful health, not a measured
public user outage or full authenticated client reconnection duration.
**Production interruption is unmeasured.** Planning estimate only: 2–5 minutes
for bounded maintenance, fresh backup, data gates, startup and route validation;
no SLA or maximum outage is established by the rehearsal.

See [CUTOVER-REVIEW.md](CUTOVER-REVIEW.md) for exact prepared paths and transaction.
