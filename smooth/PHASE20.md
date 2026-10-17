# Helix Phase 20

This is an additive change to the approved Phase 19.1 application. Production
activation is a separate, explicitly approved operation. No production service,
database, JWT key, upload directory, Nginx or TLS configuration is replaced by
the implementation work.

## Authentication

Both `POST /api/auth/register` and `POST /api/auth/login` require `altcha`, the
base64 JSON solution returned by the local widget. Obtain a challenge with
`GET /api/auth/challenge?purpose=register` or `purpose=login`. The purpose is
signed and cannot be exchanged. Existing login responses and bearer JWTs are
unchanged; `/api/auth/me` and `/api/users` add nullable `primary_photo_id` and
integer `profile_version` fields.

Official ALTCHA widget 3.4.0 and Python library 2.3.0 are vendored with MIT
licenses and upstream URLs/hashes in `THIRD_PARTY.json`. They are bundled and
verified locally. Runtime CAPTCHA does not call a CDN or third-party API.
See [server integration](https://altcha.org/docs/integration/server/) and
[security guidance](https://altcha.org/docs/integration/security-recommendations/).
Standalone proof of work increases automation cost; it does not prove that a
visitor is human or replace the following abuse controls.

Challenges use PBKDF2/SHA-256, cost 5000, prefix 00, 128-bit random nonce and
salt, signed parameters and an additional random 128-bit challenge ID. They
expire after five minutes. Stored parameters must exactly match before any KDF
work. A conditional SQLite DELETE consumes a solution once, before password
work, even when credentials later fail. Issuance/replay state is shared by all
processes, expires and is capped at 20000 rows. No frontend Boolean is accepted.

IP quotas: registration 20/15 min, login 60/15 min, challenge issuance 30/5 min.
Login account quota: 20/15 min. Failures per IP/account pair progressively back
off after the third failure, to a maximum 60 seconds. Unknown accounts perform
the existing dummy Argon2 verification and return the same 401 as a wrong
password. A SQLite lease permits two simultaneous password hashing/verifying
operations; expired process leases are reclaimed. Rate state has expiration
indexes and a hard 20000-row cap. Quota keys are HMAC pseudonyms; logs contain
neither credentials nor CAPTCHA signing keys. Registration still returns a
generic conflict for unavailable details; unique usernames remain observable
after a valid challenge.

An independent two-slot SQLite lease also bounds concurrent profile image
decoding across workers, so large uploads cannot consume all available memory
or compete with the password verification slots.

Only ASGI client addresses are read. The inspected active configuration binds
Uvicorn to 127.0.0.1, trusts proxy headers only from 127.0.0.1, and Nginx replaces
X-Forwarded-For with `$remote_addr`. Preserve both guarantees. Do not expose this
listener or configure `--forwarded-allow-ips '*'`. Direct caller-supplied
forwarding headers are ignored by application code. IPv6 addresses share /64
quotas. Auth/biography request bodies are limited to 16 KiB before parsing,
including chunked bodies. Multipart profile bodies are limited to 2 MiB +
64 KiB; decoded file content is limited to 2 MiB.

`CAPTCHA_KEY` may be a separate private random key of at least 32 bytes. When
unset, a domain-separated HMAC key is derived from the existing private
`SECRET_KEY`; no JWT rotation or new production environment file is required.
`PROFILE_MAX_PHOTOS` defaults to 10 (allowed range 1–50). Reducing the limit
does not delete existing photos.

## Profiles and images

All profile endpoints require the existing bearer authentication:

| Endpoint | Operation |
|---|---|
| GET `/api/profiles/me` | Own profile with bounded photo metadata |
| PATCH `/api/profiles/me` | `{ "biography": "plain text" }` |
| GET `/api/profiles/{user_id}` | Public authenticated profile |
| POST `/api/profiles/me/photos` | Multipart `file`, returns updated profile |
| PATCH `/api/profiles/me/photos/{id}/primary` | Choose an owned photo |
| DELETE `/api/profiles/me/photos/{id}` | Idempotent removal; owned photos only |
| GET `/api/profiles/photos/{id}/content` | Authenticated normalized WebP |

Avatars, galleries and the cropper use authenticated fetches and object URLs;
bearer tokens never appear in image URLs. Session cache retains at most 64
photos, shares concurrent downloads, revokes evictions/logout URLs and ignores
stale avatar versions. Existing message attachment loading remains separate.
Profile events use the existing authenticated WebSocket and target the owner's
sessions and existing conversation peers. Directory/conversation responses
include avatar summaries without additional per-avatar SQL queries.

Tapping the own avatar opens the Android-compatible native file picker. The
selected original is never uploaded. The native pointer/canvas cropper supports
1:1 preview, outside overlay, constrained drag, anchored two-finger pinch,
1–4× zoom slider, directional buttons, reset, cancel and explicit save. It
downsamples the working preview to a longest dimension of 1536px and exports
512px WebP. Originals are limited to 16 MiB / 32 MP in the client. Crop state
contains source coordinates so viewport resizing does not change the selection.
Dimensions are now read from JPEG/PNG/WebP headers before browser decoding, so
the 32 MP and aspect-ratio limits reject compressed pixel bombs before a bitmap
is allocated. The decoded dimensions are checked again. No additional crop or
animation dependency is required. Device acceptance,
especially orientation and touch performance, still requires a real browser.

Backend decoding accepts JPEG/PNG/WebP only, rejects animations, malformed
content, more than 16 MP / 8192px dimensions and Pillow decompression bombs.
EXIF orientation is applied before square normalization. Fresh 512×512 WebP
pixels exclude EXIF/GPS/XMP/ICC metadata. Client MIME and filenames are ignored.
Files have random names under `UPLOAD_DIR/profiles`; directory/file operations
use openat/O_NOFOLLOW and exclusive creation. DB ownership, one primary pointer,
photo cap and insertion order are protected by SQLite write transactions and
triggers. A durable GC intent is committed before file creation; failed
transactions/crashes and deferred deletion failures are recovered by bounded
cleanup on startup or later photo mutations. Recovery never touches `images/`,
the message attachment namespace.
File content and directory entries are synced before committing photo records;
GC retains its deletion intent until the directory removal is synced too.

Biography is plain text, normalizes CRLF/CR to LF and permits 1000 Unicode code
points (including joined emoji as multiple code points). Client uses Array.from,
server uses Python/Pydantic string length; there is no HTML or automatic link
interpretation. NUL and invalid surrogate text are rejected. Both languages,
mixed direction paragraphs, clear/save/cancel and visible counting are supported.

## Migration and rollback

`app/database/phase20.py:migrate_phase20` runs after existing migrations. It
takes a SQLite immediate write transaction and adds only:

- `users.biography` (nullable TEXT), `primary_photo_id` (nullable INTEGER),
  `profile_version` (NOT NULL INTEGER, default 0).
- `user_profile_photos`, `profile_file_gc`, `auth_challenges`,
  `auth_rate_buckets`, `auth_work_leases` with unique/foreign-key/check constraints
  and indexes. Photo IDs use AUTOINCREMENT to prevent cached-ID reuse.
- Ownership/primary-election/biography/version/GC triggers and version 20 in
  `smooth_schema_migrations`.

No original table is rebuilt and no user/message/hash/token is rewritten.
Deleting the primary elects the lowest remaining `(position,id)`; the last
deletion clears it. API writes cannot produce multiple primary flags.

Rehearsal tests create the actual previous release's schema using its source,
populate old accounts/messages/reactions/receipts, migrate twice, check counts,
foreign keys and integrity, populate new profile data, and run the previous
code against the expanded database. This is a production-like schema copy,
not a backup of real production data. Host activation MUST first take the
existing pipeline's SQLite online backup and upload backup and rehearse against
that real copy. The implementation sandbox cannot read `/var/lib/helix`.

Code rollback can ignore and retain the additional columns/tables/files.
Do not drop new columns/tables, remove new photos, or restore an old DB backup
over current messages. Schema additions are intentionally not automatically
reversed. Rolling back to Phase 19.1 also restores its older auth behavior;
that security tradeoff requires explicit review and approval.

## Recovery and release gates

There is no public or environment CAPTCHA bypass. During an outage, keep the
auth endpoints fail-closed and preserve existing bearer sessions. An explicitly
authorized operator should inspect private diagnostics, local challenge access,
worker loading and signing configuration, then repair the same secured release.
If a CAPTCHA key must be rotated, preserve SECRET_KEY/JWT settings and allow
users to refresh challenges. Do not log or paste environment file contents.

The Phase 20 bundle contains source checkpoint, reviewed inventory, build,
test evidence, a staged copy of the existing deployment tooling, and a guarded
promotion wrapper. Production service/config changes have not been executed.
The staged tool changes only reviewed test-source hashes and the login verifier
needed to solve real ALTCHA. It retains the non-root builder, Iranian PyPI
mirror, backup/rehearsal, diagnostics, source pinning, activation checks and
code-only rollback. The original deployment system remains untouched.

Promotion stays blocked until non-root host build and full tests, Chromium and
physical Android acceptance, real DB-copy rehearsal, backward compatibility,
and HTTPS/authenticated WSS verification are complete and explicit approval is
given. See the bundle report for exact commands and results; a successful local
Vite build alone is not deployment readiness.

Phase 20.1 verification, the isolated preview procedure and outstanding release
gates are documented in [PHASE20.1.md](PHASE20.1.md).
