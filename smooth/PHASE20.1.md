# Helix Phase 20.1 QA

This candidate preserves the Phase 19.1 design and Phase 20 API. No production
publication is authorized. Private evidence is in
`/root/helix-phase20/phase20.1/REPORT.fa.md` and `RESULTS.json`.

## Verification

Use Python 3.12 with `backend/requirements-test.txt` and Node >=22.12. Run the
entire backend suite from `smooth/backend`:

```sh
.venv/bin/python -m unittest discover -s tests -v
```

Run frontend checks from `smooth/frontend`:

```sh
npm test
HELIX_QA_PYTHON=../backend/.venv/bin/python npm run test:interop
VITE_API_URL='' VITE_WS_URL='' npm run build
npm run test:browser
```

For interoperability, use an absolute Python path if the working directory is
changed. The browser suite requires Playwright and Chromium installed separately.
The backend suite uses isolated temporary accounts, DBs and uploads. It must
never be pointed at production storage. The sandbox's QA-only asyncio wake timer
is outside release source; normal host tests must run without it.

## Production read-only diagnosis and copy rehearsal

Run this first in the real host's SSH session. It creates no files, database
connections, listeners or releases, and never prints environment values:

```sh
python3 -B /root/helix-phase20/phase20.1/host-readiness.py --check
```

After the read-only checks pass, this separate command opens production SQLite
with `mode=ro`, takes a consistent backup with SQLite's backup API, then runs
application startup/migrations twice on a disposable copy as `helix-build`:

```sh
python3 -B /root/helix-phase20/phase20.1/host-readiness.py --rehearse
```

It compares every original column and record using private, ephemeral keyed
digests, checks counts/integrity/foreign keys, tests the old startup on the
upgraded schema and verifies retention of synthetic new bio/photo data and
files. Old Argon2 hashes/JWT formats are checked with a synthetic compatibility
fixture. Existing stored password hashes are compared unchanged; this is not a
known-password login test for a real user. No report contains user names,
messages, passwords, hashes, tokens or environment values. Reports and DB
copies remain private (directories 0700, files 0600). The original snapshot is
retained separately from the migrated rehearsal DB. No production upload is
read, deleted or overwritten by this rehearsal.

The existing promotion pipeline still makes its own DB and upload backups.
Old migration checksum guards remain enabled. Phase 20's additional migration
file and every candidate file are pinned by the reviewed source inventory.
Code rollback must retain the new columns, tables and `uploads/profiles` files;
there is no automatic down migration or database restore. Existing attachments
remain under `uploads/images`. Rolling code back also restores the previous
release's login security behavior and requires an explicit decision.
Photo creation now syncs the parent directory before the photo row can commit.
Photo deletion retains its GC intent until directory sync succeeds, including
retries after an unlink succeeded but syncing failed. Injected sync failures
exercise both recovery paths; actual power-loss testing is not claimed.

## Isolated browser preview via SSH

The sandbox cannot open listening sockets. Prepare a NEW preview tree on the
host, from the reviewed candidate archive, without changing the active release.
The following commands require the already configured `helix-build` account and
the existing private Node runtime. They do not install global packages or touch
production DBs, uploads, configuration or services.

```sh
preview_dir=$(mktemp -d /var/lib/helix-build/phase201-preview-XXXXXX)
tar -xzf /root/helix-phase20/phase20.1/candidate-source.tar.gz -C "$preview_dir"
chown -R helix-build:helix-build "$preview_dir"
runuser -u helix-build -- env -i PATH=/opt/helix/toolchains/node-v22.23.3-linux-x64/bin:/usr/bin:/bin LANG=C.UTF-8 sh -c '
  set -eu
  cd "$1/smooth/backend"
  python3 -m venv .venv
  .venv/bin/python -m pip install --no-index --find-links /opt/helix/current/.python-wheels -r requirements-test.txt
  cd ../frontend
  npm ci --cache /var/lib/helix-build/.npm --no-audit --no-fund
  npm run dev:phase20
' sh "$preview_dir"
```

Keep that SSH terminal open. From a separate client terminal:

```sh
ssh -N -L 127.0.0.1:5190:127.0.0.1:5190 root@helix.localip.ir
```

Open `http://127.0.0.1:5190`. Both listeners are loopback-only (Vite 5190,
backend 8190). The preview explicitly sets a new random JWT key, CAPTCHA key,
temporary DB and uploads, and disables dotenv loading. It passes no inherited
production configuration to its backend. Register only test accounts; data is
deleted on Ctrl+C. Do not expose these ports publicly.

Check mobile widths 360/390/430, desktop 1280, light/dark and reduced motion.
Test CAPTCHA failure/retry/expiry without losing fields; crop cancel, drag,
two-finger pinch, save and double tap; EXIF orientations; multiple photos,
primary/delete/fallback; 1000 and 1001 Unicode code points; another account's
profile and avatar updates in Chats, Contacts and headers. Compare screenshots
to the Phase 19.1 baseline. Test real Android Chrome separately for the native
picker, keyboard resize, Back, rotation, memory and navigation smoothness.
Mobile Chromium emulation does not verify a physical Android device.

## Practical limits

Proof of work and quotas increase abuse cost; they do not guarantee that all
bots are blocked. Distributed IPs and shared NATs affect the tradeoff. Nginx
must overwrite X-Forwarded-For and Uvicorn must remain bound to loopback with
only 127.0.0.1 trusted. Password/image work uses two separate slots per kind;
leases expire after 120 seconds to recover from crashed workers. Very slow or
suspended jobs beyond that lease lifetime are not a measured hard process
memory bound. Physical-device memory/performance remains an acceptance gate.

The UI prevents concurrent duplicate Save taps. Independent direct upload
requests, including retries after a lost response, can create distinct photos
with identical content; each counts toward the gallery cap. Concurrent bio
saves use the last committed value. Profile modifications preserve primary
ownership, unique photo ordering and DB/filesystem cleanup invariants.
