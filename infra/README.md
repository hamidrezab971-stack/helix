# HELIX Phase 21.2 — controlled Docker transition

[Current final cutover report](docs/FINAL-DOCKER-CUTOVER-20261021.fa.md):
**BLOCKED — security gate remains NO-GO; public production still uses systemd**.
The owner has authorized a fresh empty database and cutover once the mandatory
technical and security gates pass. Historical account authentication and data
migration are no longer release requirements. No additional authorization is
needed for a cutover that satisfies those gates.

Fresh production storage was initialized through the application's own lifespan
and tested through container restart/recreation with zero accounts. Initialization
is an explicit `--initialize-empty` entrypoint command, requires dedicated empty
storage, and never overwrites an existing database. Normal startup still refuses
missing, zero-byte or uninitialized empty databases. Keep the private
`.helix-fresh-bootstrap-v1` completion marker with database backups and restores;
`data-safety.py` and `prepare-rehearsal.py` preserve it. An inherited file lock
prevents two entrypoint writers from using the same storage.

Official Prometheus 3.13.5 was pinned, scanned and installed in the **private
qualification project only**, reducing its High findings from 12 to 2. Grafana's
unresolved retained binary findings still block activation. All 26 dashboard
panels and 30 queries passed against real private measurements after the upgrade.
The [previous report](docs/HOST-QUALIFICATION-21.2.1.fa.md), retained-data drill
instructions below and [previous migration plan](docs/CUTOVER-21.2.1.md) are
historical evidence; the linked final report defines the current fresh-data scope.

The proposed production topology below keeps port 80/443, domain, ACME webroot, certificates and renewal
hook. The candidate proxies HTTP/static assets and upgraded WebSockets to
127.0.0.1:18000. FastAPI serves the exact React build embedded in the image.
HELIX uses one worker, one named container and one replica. There is no database
schema change in this phase. Existing additive startup migrations still run.
Nginx retains the previous host asset directory as a fallback for old hashed
asset URLs requested by already-open tabs; the image supplies current HTML/assets.

```
Internet → existing Nginx/TLS → loopback:18000 → HELIX (single worker)
                                                ↕ bind /data
                                      fresh SQLite + new uploads
Private Docker bridge: Prometheus → HELIX token-protected /internal/metrics
                       Prometheus → node-exporter private bridge listener
SSH tunnel → loopback:13000 Grafana → Prometheus
Host-only timer → narrow Docker state/stats → node-exporter textfile
```

Prometheus keeps 15 days or 2 GB, whichever expires first, on a named volume.
Grafana has its own named volume, provisioned datasource and three dashboards.
No Prometheus port is published. Grafana and the app publish loopback only.
The monitoring bridge remains internal; app and Grafana also join a dedicated
172.30.213.0/24 ingress bridge because current Docker does not publish ports
from internal-only networks. Only loopback ports are published. The trusted
forwarding gateway is 172.30.213.1. Check both fixed subnets for overlaps.

All containers have restart policies, health checks, bounded local log rotation,
CPU/memory/PID limits, non-root users, read-only roots, dropped capabilities and
no-new-privileges. Application /tmp is capped. No Docker socket is mounted.

Node Exporter alone uses host networking to measure the actual host network;
it binds **172.30.212.1:19100**, the internal bridge gateway. It never binds the
public IP. Read-only /proc, /sys and rootfs mounts support CPU/memory/disk/filesystem
collectors; only six selected collectors run. It has no privileged flag, host
PID namespace or additional capabilities. Verify this subnet does not overlap
existing VPN/routes and verify listener/firewall behavior on the real host.
The root host collector needs Docker daemon access solely to inspect four
services and read stats; selected fields exclude environment/secrets. Containers
receive only its atomically written, low-cardinality .prom file.

## Build inputs and private configuration

Prerequisites on the real host: approved Docker Engine and Compose >=2.33.1
(raw environment and explicit gateway priority support), linux/amd64, Node >=22.12, Python 3.12, existing
Nginx, and a separately pinned Playwright/Chromium installation. Docker
installation changes the host firewall; review Docker bridge/iptables behavior
before installation. Docker CE 29.9.1 and Compose 5.6.0 from the official signed
repository were installed and validated during real-host qualification.

The Dockerfile **requires immutable base image references**. No mutable fallback
is provided. Resolve five explicitly reviewed exact version tags with:

```bash
python3 infra/scripts/lock-images.py \
  --node 'node:REVIEWED_VERSION-bookworm-slim' \
  --python 'python:REVIEWED_3.12_VERSION-slim-bookworm' \
  --prometheus 'prom/prometheus:REVIEWED_VERSION' \
  --grafana 'grafana/grafana:REVIEWED_VERSION' \
  --node-exporter 'prom/node-exporter:REVIEWED_VERSION' \
  --output infra/images.resolved.env
```

These placeholders are deliberately not deployable. Registry access and version
security review remain required. Preserve resolved digests in the release
manifest and commit the reviewed non-secret lock before approval; never substitute
an invented digest. `requirements.lock` pins the complete CPython 3.12 amd64
runtime dependency closure with SHA256s from the retained release wheelhouse;
pip enforces every hash. Frontend uses the existing npm lock and npm ci. Build
stages contain toolchains/wheels; runtime contains the venv, app and built assets.
No credentials, DB, uploads or host environment enter the build context.
The old Railway quickstart no longer applies to this audited Dockerfile.

Copy `.env.example` to ignored `infra/.env` and add the digest lock. Use absolute
paths outside Git for all storage, environment and secret files. Never run
`docker compose config` without `--quiet` in a shared log; rendered configuration
can contain environment secrets. The app's raw environment file must contain
normalized literal values, not shell quotes; `prepare-rehearsal.py` creates this
from the original environment without rotating JWT/CAPTCHA keys.

Create monitoring-only credentials with:

```bash
python3 infra/scripts/init-monitoring-secrets.py /PRIVATE/secrets
```

That new directory must be root-owned mode 0700. Each assigned container reads
only its mounted secret. Local Compose secrets are bind files, not an encrypted
secret store. Files have read bits for the non-root container identities while
the host parent prevents traversal. Keep backups of Grafana's persistent secret
key and password root-only. Grafana admin username is `helix-admin`. Changing a
bootstrap password file does not rotate an existing Grafana account; use Grafana's
supported password reset procedure if needed.

## Isolated rehearsal

1. Run `scripts/audit-host.py --output /PRIVATE/fresh-audit` using the project
   venv in a real host session. Confirm systemd, running release, nginx -T, cert
   validity/renewal, port bindings and route safety. This command changes no
   services. Run the existing guarded host readiness checks without apply.
2. Obtain a verified baseline with `data-safety.py snapshot`. For the actual
   production path it requires `--inactive-unit helix.service`; it never stops a
   service itself. This final maintenance step needs an authorized window. For
   qualification while production stays up, use explicit `--online-rehearsal`: it
   performs a SQLite online backup with stable upload hashes, labels it as
   rehearsal-only, and cannot claim a quiesced cutover backup. Existing
   independently verified consistent backups can be used for initial rehearsal,
   but cannot stand in for a fresh pre-cutover backup. Never copy a live SQLite
   file with cp; the helper uses SQLite backup, integrity and FK checks, hashes
   every upload and preserves the original secret environment privately.
3. Keep the baseline immutable; make a SECOND copy:

```bash
python3 infra/scripts/prepare-rehearsal.py --baseline /PRIVATE/baseline \
  --output /PRIVATE/rehearsal --origin http://127.0.0.1:18443
```

4. Set APP_DATA_DIR to /PRIVATE/rehearsal/data, APP_ENV_FILE to its app.env,
   COMPOSE_PROJECT_NAME to `helix212-rehearsal-<unique-name>`, and set numeric
   APP_UID/GID to the copy owner. Change ownership **only on this copy** if
   necessary. Create TEXTFILE_DIR (0755) with files readable by UID 65534. Secret
   paths must reference the private secret files. Use APP_PORT=18000 and
   GRAFANA_PORT=13000. Confirm the production service still listens at 8000.
5. Run existing backend/frontend/browser suites per `.github/workflows/` with
   the candidate sources, current dependency lock, and disposable test DBs. Set
   HELIX_QA_BACKEND_PORT=18080 for browser fixtures/Vite so tests never use the
   production port. Use the retained Node 22 toolchain and qualified Python venv.
   Browser tooling is pinned separately to Playwright 1.64.1. The browser runner
   builds once and serves the resulting production bundle on loopback 5173,
   preserving HTTP/WebSocket proxying to the isolated fixture. All eight phases
   retain their assertions. Subprocess log lines redact JWTs and credentials.
6. Run the real integration harness from a venv with dotenv/Pillow. Supply a
   separately installed pinned Playwright through NODE_PATH:

```bash
python3 infra/scripts/run-rehearsal.py --env-file infra/.env \
  --work /PRIVATE/rehearsal
```

It validates Compose, builds the image, starts all services, checks Prometheus
config/rules, starts a separate Nginx on 127.0.0.1:18443, solves real CAPTCHA,
registers disposable users, logs in, authenticates WebSockets, sends a message,
uploads/downloads a real PNG, checks history and private metrics, collects real
container observations, validates exposition using promtool, checks live scrape
targets, queries Grafana's datasource and every dashboard expression, then
restarts the rehearsal app and compares all pre-restart rows/files. No synthetic
Prometheus samples are substituted. The isolated Nginx exits on completion;
Compose stays available for review. Ensure ports/subnet are free before running.

7. Run `data-safety.py compare /PRIVATE/baseline/smooth.db
   /PRIVATE/rehearsal/data/smooth.db` BEFORE intentional test traffic can modify
   any baseline account. This checks every old row/column, including stored
   message history; hashes in uploads-manifest.json must still match baseline
   media. Log in to a retained account using a protected operator credential
   handoff; new synthetic accounts alone do not verify legacy authentication.
8. Stop the disposable app, then run `rehearse-old-runtime.py` against its data
   and environment with the audited retained `--old-release`. It creates yet
   another copy, runs old startup twice and rejects lost/changed rows or files.
   Complete real login, CAPTCHA, history, media and WebSocket checks under the
   previous runtime too; a startup-only test is not a complete rollback test.
9. Keep sanitized results and private backup manifests outside Git. Shut down
   only the explicitly named rehearsal project when finished; do not remove
   volumes. Never have both app runtimes write the production DB concurrently.

## Monitoring access and operations

```bash
ssh -N -L 127.0.0.1:13000:127.0.0.1:13000 root@helix.localip.ir
```

Open http://localhost:13000 locally and sign in with the private Grafana
credentials. Dashboards: HELIX Application, VPS Infrastructure and Service
Health. The qualification collector timer and private proxy service are already enabled
on this host; exact names and paths are in the inventory. For production, adapt
`systemd/helix-host-collector.{service,timer}` to the reviewed installed project. Run it every 30 seconds; freshness
is alerted after two minutes. See [METRICS.md](docs/METRICS.md) for exact semantics.

Rules evaluate locally in Prometheus and are visible in Grafana's Service Health
panel. External notification delivery is not configured. Protect monitoring
volumes and backups; never publish Prometheus/Grafana or disable authentication.
Rehearsal traffic is not production monitoring evidence.

For restricted dependency networking, set WHEELHOUSE_DIR to the private retained
wheel directory and PIP_NO_INDEX=1. Compose supplies the named BuildKit context;
pip still enforces requirements.lock hashes. Do not add wheels or credentials
to Git. Network builds use the empty infra/wheelhouse context and the same hashes.

Build rehearsals with a unique candidate tag, then freeze HELIX_IMAGE to its
actual resolved digest after the final build. Do not rerun the build harness on
the final digest-pinned env or existing qualification data; use verify-stack.py
for read-only verification and a newly prepared disposable copy for new builds.

See [QUALIFICATION.fa.md](docs/QUALIFICATION.fa.md),
[CUTOVER-REVIEW.md](docs/CUTOVER-REVIEW.md) and
[MIGRATION.md](docs/MIGRATION.md) for the production approval gates and rollback.
Official references: [Compose services](https://docs.docker.com/reference/compose-file/services/),
[Prometheus configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/),
[Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/).
