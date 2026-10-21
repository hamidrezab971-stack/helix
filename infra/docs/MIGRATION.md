# Production migration and rollback — approval plan

Current gates and ordered transaction: [Phase 21.2.1](CUTOVER-21.2.1.md).
The existing image does not contain the new entrypoint/build hardening. Build,
rescan, live qualification and new guard integration are required before approval.

This is a reviewable plan, not an authorization or an executed deployment.
No cutover command is run automatically by the supplied scripts. The retained
systemd release guard pins an earlier candidate and approval. Its seal, lock,
backups and verification gates remain authoritative for the current deployment;
Docker requires a newly reviewed release manifest and guard integration.

## Evidence required for authorization

- Fresh real-host inventory: PID/cwd/active build fingerprint agrees with
  Nginx assets and public HTTPS; service units, systemd/Certbot timers, TLS dates,
  complete nginx -T, ports, disk/inode headroom and subnet conflicts reviewed.
- Docker Engine/Compose installation and firewall/routing changes reviewed;
  four immutable monitoring/base image references resolved from reviewed exact
  versions, vulnerability policy checked, digests preserved with Git commit.
- Candidate image built successfully with hash-verified Python/npm dependencies;
  image ID/digest and frontend asset hashes captured. Runtime UID/GID matches
  production `stat` from the real host, not the sandbox's unmapped ownership.
- Integrity_check and foreign_key_check pass on verified SQLite backup;
  every existing upload copied and hashed; original environment/key material
  preserved root-only. Backup restoration is tested ONLY in a disposable path.
- Existing regression suites and Chromium suites pass on the real host.
  `run-rehearsal.py` passes against an isolated copy with actual Prometheus,
  Grafana, container restarts, Nginx WebSocket and image retrieval. Verify all
  dashboards after real traffic and two scrapes, not just their JSON syntax.
- Row-level baseline continuity and existing history/media checked; known
  retained-account login + real CAPTCHA verified through protected credential
  handoff. Compare existing JWT/CAPTCHA keys in memory, never print them.
- Old runtime tested on candidate-migrated data copy, twice, with DB/file
  continuity checks and actual old-runtime auth/WS/media/history tests.
  Perform a full isolated Nginx → container → previous-runtime → container
  route-switch drill. Record resulting health/traffic before production review.
- Confirm normal SIGTERM disconnect/close behavior, attachment maximum size,
  CORS/Origin, forwarding trust boundary, security headers, no-cache HTML,
  immutable assets, and negative public metrics/environment/monitoring probes.
  Check retained old hashed asset URLs as well as new candidate assets; keep the
  old host frontend directory available throughout the observation window.
- Operator reviews exact Nginx diff, environment *key names*, image digests,
  final data mount, rollback release path, maintenance window, health criteria
  and maximum acceptable outage. Obtain explicit production authorization.

## Authorized cutover transaction

1. Acquire the existing deployment lock discovered in the retained tooling;
   exclude concurrent deployment, cleanup, backup and renewal edits. Recheck
   release identity and that no data/env/image changed since review. Preserve
   the exact current Nginx config, helix.service, current symlink target,
   image references and timer states in a private transaction directory.
2. Ensure rehearsals use separate data and stop their stack to release the fixed
   private subnet/ports. Do not remove Grafana/Prometheus volumes. Prepare
   production Compose configuration with `APP_DATA_DIR=/var/lib/helix` and the
   actual helix UID/GID; never chown the production tree to fit the image.
   Prepare the normalized private application env preserving SECRET_KEY and
   any CAPTCHA_KEY exactly. FRONTEND_ORIGIN remains https://helix.localip.ir.
   Only data path strings change inside the container to /data/....
3. Prepare a bounded maintenance response in Nginx and validate with nginx -t
   before reload. Keep ACME challenge servicing and TLS intact. Stop
   helix.service in the authorized maintenance window; verify process exit and
   release of its DB handles. Confirm the container app is also stopped.
4. Run a fresh `data-safety.py snapshot --data /var/lib/helix
   --env /etc/helix/production.env --output /PRIVATE/transaction/final-backup
   --inactive-unit helix.service`. Preserve it, fsync, and verify upload hashes.
   Rehearse migrations and old-runtime compatibility against copies of this
   exact final backup. Abort and resume the old service if any gate fails.
5. Start only the reviewed app image with the existing production bind mount,
   one worker/replica, port 127.0.0.1:18000. Entrypoint refuses a missing/empty
   database/uploads tree. Before public writes, compare every baseline row and
   upload hash; preserve DB integrity and secrets. Never start systemd and
   container writers simultaneously. Record app health and image ID.
6. Install the reviewed `nginx/helix-docker.conf` diff, test nginx -t and reload.
   Ports/certificates/domain/ACME stay unchanged. Validate HTTPS and actual
   authenticated login/CAPTCHA, WebSocket delivery, uploads/downloads, existing
   history, size/security/cache headers and private endpoints. Unauthenticated
   /api/health alone is insufficient. Start/verify monitoring and host collector.
7. Keep the previous release/service available for the observation window.
   Do not remove or disable rollback artifacts. Record all service/target
   health and traffic evidence. Only then declare migration verified. Document
   that external alert notifications still need a reviewed receiver.

## Rollback using the newest data

Triggers: health or auth failure, missing baseline history/media, broken WS or
uploads, repeated 5xx, schema incompatibility, or a public metrics/secret leak.

1. Acquire the same deployment lock and enter the bounded maintenance route.
   Stop the container app and confirm it has exited. Do not leave it under an
   automatic supervisor that can restart concurrently with helix.service.
2. Make a new private SQLite backup + uploads/environment manifest of the
   **current post-cutover state**, including all new user writes. Verify
   integrity/FK checks. Never replace production DB/uploads with a pre-cutover
   backup. No script in this change implements a restore-to-production command.
3. Validate the previous systemd code against a copy of this newest data. If
   it is incompatible, hold maintenance and use a reviewed forward repair;
   do not erase new data to force a rollback.
4. Restore the previous Nginx file/current release pointer if changed and
   start the previous helix.service with the **same current** `/var/lib/helix`
   database/uploads and unchanged `/etc/helix/production.env`. Validate local
   health, then nginx -t and reload the previous routing to 127.0.0.1:8000.
5. Recheck real existing-account login, CAPTCHA, WS, image retrieval and newest
   messages after rollback. Preserve monitoring volumes, backup evidence and
   failed candidate artifacts. Report the rollback outcome explicitly.

A startup-only old-code rehearsal does not count as a verified production
rollback. The later real-host qualification performed two complete isolated
route-switch round trips with authenticated traffic for the final image; no
live production rollback or cutover ran. Current evidence, open security/auth
gates and prepared transaction paths are in [RESULTS.md](RESULTS.md) and
[CUTOVER-REVIEW.md](CUTOVER-REVIEW.md).
