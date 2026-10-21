# Phase 21.1: media ownership and HELIX icons

The chat picker now consumes the selected provider File through FileReader
before releasing its native input selection. Previews and retries use a fresh
Blob built from the resulting bytes. A component owns each URL for its actual
rendered lifetime, including the composer's closing transition. Preparing can be
cancelled, late reads are discarded, and invalid selections never become sends.

Input limits are 8 MiB, 25 million pixels, and 16000 pixels on either axis;
JPEG, PNG and non-animated WebP are accepted by the backend. The frontend reads
bounded headers before decoding; final format, animation and pixel validation
remain on the server. Unknown Android provider MIME is sniffed from bytes.
The backend strips private metadata when present, applies EXIF orientation,
retains clean originals, writes exclusively with mode 0600, and syncs the file
and directory before committing the message. No schema or Nginx change is needed.

The existing atomic image-message endpoint remains
`POST /api/conversations/{id}/messages/image`. FormData contains `file`,
`caption`, optional `reply_to_message_id`, and the immutable
`client_message_id`. The browser sets the multipart boundary and sends bearer
authentication. Upload and message publication are one operation; WebSocket
publication still follows successful database commit. Retrying reuses the same
bytes and UUID, including recovery after a lost successful response.

XHR supplies measured byte progress. Unknown length is indeterminate; completing
the transfer changes the UI to Sending while the server processes it. Uploads
have a 120-second deadline. Offline, expired authentication, invalid content,
oversize and server failures have distinct recovery messages, including HTML
errors from proxies. Repeated submissions share a synchronous lock. At most
20 pending intents and 32 MiB of owned pending photo data are retained.
Cancelling aborts transport and releases local data; a request already committed
by the server can still appear through canonical synchronization. Confirmed
entries disappear through existing timeline reconciliation. Logout clears the
bounded authenticated image cache and pending request ownership.

Icons are original inline SVGs from one local family: 24px grid, 1.75px round
strokes, shared proportions, inherited color, hidden from assistive technology,
and no pointer interception. Receipt ticks, retry, photo management and crop
arrows use the same family. Existing branding, bubbles, navigation, focus rings,
44px main controls and reduced-motion rules are retained. No icon dependency,
font or CDN was added.

Tests added:

- `frontend/tests/phase211-unit.mjs`: provider ownership/lifetime, read/decode
  failures, limits, multipart/auth contract, HTTP errors, measured XHR and abort.
- `frontend/tests/phase211-components.jsx`: all icons, preparing controls,
  indeterminate/measured progress, failed/rejected/cancelled actions.
- `backend/tests/test_phase211_storage.py`: real generated formats, metadata,
  orientation, permissions, failed writes, collisions and symlink rejection.
- `backend/tests/test_phase211_service.py`: real multipart parsing, real JWTs,
  SQLite commit/rollback, storage, authorized retrieval, history and idempotency.
- `backend/tests/test_phase211_http.py`: actual authenticated HTTP multipart,
  recipient WebSocket publication, persistence and authorization boundaries.
- `frontend/tests/phase211.cjs`: mobile Chromium input/read/preview/send,
  duplicate prevention, recipient rendering, refresh/reconnect, injected server
  failure, offline retry, cancellation, cleanup, keyboard and reduced motion.

`npm test` includes the new unit/component tests. `npm run test:browser` now
requires all seven prior phases and Phase 21.1. CI also covers phase21.1 branches.
Use the established non-root isolated release browser gate to remap test ports;
never point browser fixtures at the production database or port 8000.

Implementation is not evidence of deployment or physical Android acceptance.
Current execution evidence, blocked gates and deployment state are recorded in
`/root/helix-phase21.1/FINAL-STATUS.json` and `QA-RESULTS.json`. Activation must
remain blocked until the complete backend and eight-phase real Chromium gates,
fresh backup/integrity/migration rehearsal, and guarded release checks pass.
The known picker lifetime defect is established by source and controlled unit
regressions; the original physical-device failure still needs live diagnosis
and final Gallery/Files acceptance on the owner's Android device.
