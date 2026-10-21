# Production transaction review — NOT AUTHORIZED

> Superseded transaction requirements: [Phase 21.2.1 plan](CUTOVER-21.2.1.md).
> The new source changes have no built/qualified image yet. The old proposed
> Prometheus volume adoption must not mix qualification history into production
> telemetry. No current or old manifest authorizes this cutover.

Decision: NO-GO pending the gates in [RESULTS.md](RESULTS.md). This document and
private proposed configs do not authorize execution. Do not reuse or bypass the
existing sealed approval for a different candidate. Prepare a newly reviewed
manifest and integrate the Docker transaction with that guard before execution.

The actual live release is `/opt/helix/releases/2aec7a584c18194a3e1c`, PID
261758 at qualification. The shared deployment lock is
`/var/lib/helix-deploy/lock`. Reviewed candidate image:
`helix@sha256:aa9dbf55ad94b1f8102e511349734f416ee83e1158b8c9f8416ca1d287f165d4`. Numeric runtime identity: 997:987.

Prepared, validated with `docker compose config --quiet`, but never started:

- `/root/helix-qualification-20261020/cutover-compose.proposed.env`: project
  helix212, APP_DATA_DIR=/var/lib/helix, immutable images and protected paths.
- `/root/helix-qualification-20261020/cutover-app.proposed.env`: normalized
  production env, exact retained JWT/CAPTCHA values, container data paths,
  FRONTEND_ORIGIN=https://helix.localip.ir; root-only.
- `/root/helix-qualification-20261020/cutover-volumes.proposed.yaml`: adopts
  the retained rehearsal Grafana/Prometheus volumes as external volumes.
- Site candidate `/root/helix/infra/nginx/helix-docker.conf`, compared against
  `/etc/nginx/sites-available/helix.localip.ir.conf`; preserve existing ACME/TLS,
  switch upstream 8000→18000, add internal denies, retain old assets.
- Private unsigned review manifest in the evidence directory has approval=false.

## After all gates AND explicit production approval

Run under the newly integrated guard and exclusive existing lock. Record timer
states first, prevent concurrent deploy/backup/cleanup/renewal edits, and keep
all transaction evidence root-only. Re-audit PID/cwd/public assets, image IDs,
mount UID/GID, subnet/port ownership, key continuity and source/config hashes.
Any drift requires a new review, not automatic continuation.

1. Create a root-only transaction directory outside Git and preserve the exact
   current unit, current symlink target, Nginx config, image locks, environment
   key names and timer states. Do not print rendered Compose or secret values.
2. Stop the private qualification proxy and collector timer. Stop the rehearsal
   stack using its exact env/config; `down` is allowed **without -v** solely to
   release fixed networks/ports. Keep all named volumes and backups. Confirm
   the rehearsal app cannot restart as a second writer.
3. Prepare a maintenance version of the current site that returns a bounded 503
   with Retry-After for application routes, while retaining ACME and TLS.
   Review the exact diff, validate `nginx -t`, then reload the public Nginx only
   inside the approved window. Stop `helix.service`, wait for inactive and
   verify no writer holds the production DB. Do not disable/delete the service.
4. Create the final backup with the exact reviewed helper (substitute a new
   private transaction path):

   ```bash
   python3 /root/helix/infra/scripts/data-safety.py snapshot \
     --data /var/lib/helix --env /etc/helix/production.env \
     --output /PRIVATE/transaction/final-backup --inactive-unit helix.service
   ```

   Reverify SQLite integrity/FKs, all upload hashes, unchanged environment and
   restoration/old-code compatibility on a disposable second copy of THIS
   final backup. Never treat the online qualification backup as the final one.
   Abort and resume the original runtime/routing if any gate fails.
5. Use the prepared production env and retained external-volume overlay with
   the reviewed Compose file. Start the **app only**, using `up -d --no-build
   --wait app`. Its reviewed mount is the existing /var/lib/helix, UID/GID
   997:987; never chown production to fit the image and never run both writers.
   Compare the fresh baseline before any public writes; check actual image ID,
   DB health and all uploads. A missing/empty DB must abort startup.
6. Install the reviewed Nginx candidate into the original site path only after
   health/data gates pass. Run `nginx -t` and reload. Keep /opt/helix/current
   pointing at the retained old release for hashed-asset fallback and rollback.
   Verify CA-valid HTTPS, retained-account real CAPTCHA/login, WS/presence,
   text/image/history, body limits, headers and public internal-path denies.
7. Start all four production Compose services with the proposed volume overlay.
   Point the collector service at project helix212, restart its timer and verify
   three up scrape targets, 30 real dashboard panels, API/host/container data
   and freshness. Keep Grafana loopback, credentials and monitoring volumes.
8. Retain the old runtime, transaction backup, monitoring and failed artifacts
   through the observation window. Report migration complete only after real
   production verification, not at container startup.

## Rollback with newest data (requires the same lock)

Triggers: auth/WS/data/media failure, repeated 5xx, health failure, unsupported
schema or an exposed internal/secret endpoint. Re-enter bounded maintenance;
stop the Docker app and verify it cannot automatically restart. Snapshot the
**current post-cutover** DB, uploads and environment into a new transaction
backup. Preserve all new customer writes; never copy the pre-cutover backup
onto production. Validate the retained old runtime against a second copy of
that newest state. If incompatible, hold maintenance and apply a reviewed
forward repair rather than deleting new data.

Restore the exact saved old Nginx file and current symlink if it changed.
Start `helix.service` on the same current /var/lib/helix and unchanged original
/etc/helix/production.env. Validate local port 8000, then `nginx -t` and reload
old routing. Recheck real retained-account CAPTCHA/login, WS, newest text/images
and history; preserve metrics volumes and report the outcome. Production
rollback was NOT performed during qualification; two isolated round trips with
the actual retained code and newest isolated writes did pass.
