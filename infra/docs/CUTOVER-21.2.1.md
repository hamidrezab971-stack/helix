# Phase 21.2.1 production transaction — NOT APPROVED

No production cutover sequence is approved. This is the exact required order
for a future reviewed transaction, subject to the unresolved inputs below.
Do not run this plan merely because it is committed. The existing Phase 21.1
sealed approval does not cover Docker or the new source changes.

## Inputs that must be sealed before requesting approval

- New commit and built amd64 app reference/config ID; supported fixed monitoring
  images or reviewed evidence for each remaining finding. The archived app
  `helix@sha256:aa9dbf55ad94b1f8102e511349734f416ee83e1158b8c9f8416ca1d287f165d4`
  does **not** contain Phase 21.2.1 hardening.
- Real-host PID/cwd/release fingerprint, CA-valid public assets, exact Nginx
  before/maintenance/after diffs and unit hashes, actual data UID/GID, networks,
  ports, signing comparison, health criteria and a bounded maintenance window.
- Fresh isolated online snapshot and real retained-account credential check;
  complete backend/frontend/Chromium/live stack/restart/rollback gates. Resolve
  the inventory discrepancy: files define 26 panels and 30 queries, not 30 panels.
  The real-host Phase 21.2.1 request explicitly confirms this scope. The verifier
  now independently enforces both counts by default, and all 30 expressions
  have returned real observations through both Prometheus and Grafana.
- New manifest and transaction integration under `/var/lib/helix-deploy/lock`.
  It must bind every image/config/script and expire on drift. Integration with
  the existing sealed guard remains unfinished; no replacement apply command
  or reusable authorization token is supplied in this phase.
- Root-only transaction path outside Git. Confirm off-host recovery storage and
  external alert delivery or explicitly settle their outstanding operational
  requirements. Neither has been verified here.

## Isolated qualification before the window

1. Reconfirm the public upstream is port 8000 and matches
   `/opt/helix/current`, currently resolving on disk to
   `/opt/helix/releases/2aec7a584c18194a3e1c`. Read actual systemd PID/cwd;
   the previous PID 261758 is historical evidence, not a fresh assertion.
2. Build the candidate under a **new tag** using reviewed locked build inputs;
   never overwrite the old digest. Run `scan-images.py --env-file PRIVATE_ENV
   --output NEW_PRIVATE_SCAN_DIR` and retain all results, DB age and identities.
   High/Critical findings block its gate. Do not edit counts or ignore files.
3. Create a fresh `data-safety.py snapshot --online-rehearsal` from
   `/var/lib/helix` and `/etc/helix/production.env`; prepare a second copy with
   `prepare-rehearsal.py`. Only the copy gets UID/GID 997:987 after real stat
   reconfirms those IDs. Use a unique `helix212-rehearsal-*` project and the
   existing private networks/listeners. The systemd writer stays running.
4. Verify missing/zero-byte/schema-only DB and FK failures in the **built**
   candidate, real account login and hash continuity, all suites, real metrics,
   dashboards and exposure/resource/user checks. The protected credential path
   is an inherited sealed FD, or an operator-only SSH terminal command:

   ```bash
   /root/helix-phase21.2/venv/bin/python \
     /root/helix/infra/scripts/verify-retained-auth.py \
     --baseline /PRIVATE/fresh-production-snapshot \
     --env-file /PRIVATE/rehearsal-compose.env --hidden-input
   ```

   The helper contacts loopback only, verifies actual Docker mount/image and
   preserved keys first, solves real CAPTCHA, checks JWT/protected APIs and
   refuses echoed input, proxying and redirects. No password goes into argv,
   environment, files, logs or Git. No real account is registered or altered.
   This helper has not passed a real retained-account login yet.
5. Perform two isolated Nginx route cycles candidate -> retained runtime ->
   candidate with fresh text/image writes between switches. Stop each isolated
   writer before starting the next. Snapshot the newest isolated state for
   rollback; compare original durable rows, files and all newer test writes.
   Source-only lifespan drills are insufficient for this live gate.

## Approved-window execution order (only after explicit user approval)

1. Acquire the existing exclusive deploy lock. Capture and hash the live unit,
   Nginx file, release pointer/marker, protected env and timer states. Recheck
   the sealed manifest, public release and image IDs. Abort on any drift. Block
   overlapping deployment/backup/cleanup/configuration edits without interfering
   with ordinary certificate servicing outside this bounded transaction.
2. Announce the approved maintenance window. Stop the isolated qualification
   proxy/collector timer and exact rehearsal project without `-v`. Confirm its
   app cannot restart and it has no production bind. Preserve all volumes and
   backups. Do not stop the production writer until the prepared maintenance
   config and abort route have passed review and Nginx syntax validation.
3. Install/reload the reviewed bounded 503 + Retry-After maintenance config,
   preserving TLS and ACME. Stop `helix.service`; verify inactive, process exit,
   port 8000 release and no remaining writer handles. Do not disable/delete the
   service. Never start Docker against production while this writer is active.
   A stopped but enabled service can start after a reboot. The reviewed future
   transaction must first stage `infra/systemd/helix-docker-writer-guard.conf`
   as a production unit drop-in and bind its hash in the manifest. Its persistent
   root-owned `/var/lib/helix-deploy/docker-active` marker is created atomically
   **after** the old writer exits and the final backup passes, and **before**
   Docker activation. The marker prevents systemd writer startup while Docker
   may restart. Neither this drop-in nor its production marker is installed by
   qualification. Guard enforcement and recovery remain release prerequisites.
4. Create the final consistent backup:

   ```bash
   python3 /root/helix/infra/scripts/data-safety.py snapshot \
     --data /var/lib/helix --env /etc/helix/production.env \
     --output /PRIVATE/transaction/final-backup --inactive-unit helix.service
   ```

   Verify integrity/FK checks, every media hash, all user/message/conversation
   baselines, private key continuity, permissions and backup fsync. Test restore
   and old-code compatibility on a **second copy of this exact final backup**.
   Online qualification copies never substitute for this backup. If a gate
   fails before Docker writes, restore original routing/runtime on unchanged
   production data; preserve failed artifacts.
5. Start only the reviewed app via the approved production Compose environment,
   `up -d --no-build --wait app`, binding existing `/var/lib/helix:/data`,
   numeric audited UID/GID, one worker/replica and loopback port 18000. The new
   entrypoint must reject absent, empty-account, invalid-schema, symlinked or
   FK-corrupt storage. Compare all baseline rows/uploads before public writes.
   Do not chown, initialize, restore or replace the live production tree.
6. Verify the actual image, user, read-only root, dropped capabilities,
   no-new-privileges, limits, DB health, retained-account real CAPTCHA/login,
   protected APIs and existing media privately. If they fail, stop Docker and
   use newest-data rollback below. Check writer exclusion throughout.
7. Install the newly reviewed Nginx site at the original site path, preserving
   ACME/TLS, headers, body limits and old hashed-asset fallback. Validate
   `nginx -t`, reload and confirm public upstream 18000 plus matching new assets.
   Keep `/opt/helix/current` and the retained old release available for fallback.
8. Verify CA-valid public HTTPS, real CAPTCHA/login/token, retained history,
   WebSocket/presence, text delivery, attachment upload/retrieval, original
   profile photos, security/cache/size boundaries and public internal-path
   denies. Health alone never authorizes completion.
9. Start reviewed monitoring and point the collector at the production project.
   Keep the old qualification Prometheus volume intact. Prepare a **separate
   production TSDB volume** so unlabeled historical QA samples cannot become
   production graphs; preserve Grafana state and back it up before migration.
   The old proposed overlay that reuses the qualification TSDB is superseded.
   Label future scrape series with a fixed environment value; external_labels
   alone do not label local PromQL series. Validate all targets and the reviewed
   panel/query inventory after real traffic/two scrapes. Recheck that loopback
   Grafana, private exporter and unpublished Prometheus remain inaccessible
   from an independent external vantage.
10. Observe health/5xx/latency, resource headroom, DB locks, restarts and media
    failures for the approved observation period. Retain the old runtime, newest
    backups and both monitoring histories. Declare migration verified only when
    authenticated public and monitoring gates pass.

## Newest-data rollback / recovery

11. On auth/WS/media/data errors, repeated 5xx, unhealthy runtime, schema
    incompatibility or public internal exposure, re-enter bounded maintenance.
    Stop the Docker app and remove its ability to restart concurrently. Confirm
    writer exit. Snapshot **current post-cutover** SQLite, uploads and env to a
    new private backup. Preserve every new customer write and failed artifact.
    Validate the retained runtime on a second copy of this newest state.
12. If compatible, restore the saved Nginx file/release pointer if changed,
    start `helix.service` against the **same current** `/var/lib/helix`, validate
    port 8000 privately, then validate/reload old public routing. Recheck real
    auth, newest text/images/history, WS and private monitoring. If incompatible,
    remain in maintenance and perform reviewed forward repair. **Never overwrite
    production with the pre-cutover DB or media backup to force a rollback.**
    Before removing the Docker-active marker, the transaction must explicitly
    stop the exact Docker writer and set its restart policy to `no`, then prove
    process/port exit. Only then remove the marker and start the retained
    systemd writer. Keep the unit drop-in available: when the marker is absent,
    normal systemd startup is allowed. Seal these state transitions under the
    same deployment lock; the marker alone is not an authorization token.

The 2026-10-21 isolated handoff measured 16.301 seconds from stopping its writer,
through a quiesced snapshot, old-runtime validation on a second restored copy,
and restarting the candidate until API readiness. This is not production
downtime. Keep a provisional 2–5 minute maintenance window for final checks,
retained-account login, Docker health and routing validation; agree the abort
threshold before approval. Full regression suites stay outside downtime.

`../nginx/helix-maintenance.conf` is a concrete unapproved maintenance candidate.
Its loopback-only derivative passed Nginx syntax and CA-valid TLS tests and
returned 503 with Retry-After: 60. It was never installed on the public site.
The live-to-candidate site diff is preserved privately with the current host
evidence. All old production fingerprints must be rechecked under the deploy
lock before any future authorization can be bound to them.
