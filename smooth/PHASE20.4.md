# Phase 20.4

Profile selections are consumed immediately through FileReader before clearing
the file input. Only a bounded byte-backed Blob is decoded. The native File is
never reused for decoding, cropping or multipart upload. The crop source is
downscaled to 1536 pixels on its longest edge and its URL has one idempotent
owner. Unmount aborts loading; cancel/save/unmount release URLs. Canvas export
remains 512×512 and no upload occurs until Save. Existing server format, size,
pixel, metadata, storage and ownership checks remain enabled.

The reported sentence is a browser NotReadableError. The old implementation
cleared the selection before `file.arrayBuffer()`, displayed that exception
verbatim, and subsequently decoded a URL backed by the same original File.
These are verified code defects. The underlying Android provider failure has
not been reproduced on a physical device, so permission expiry or input reset
must not be described as the proven device-specific cause.

## Delete Chat

Delete Chat clears history **only for the authenticated participant**. Shared
conversation IDs, membership, messages, attachments and the other participant's
history are retained. Migration 204 adds `conversation_visibility` and its
version marker without rebuilding or modifying existing tables.

An SQLite write lock serializes deletion against sends. The boundary uses the
existing transactional monotonic message allocator and the conversation event
head, rather than wall-clock time. Repeating a delete with no new activity is
safe. Unread counts and the recent preview exclude cleared messages. A new
message can revive the same conversation, showing only messages after the
boundary. Explicitly reopening through Contacts reuses the existing identity
and preserves that boundary.

The shared visibility predicate covers legacy history, both pagination
directions, reply context/previews, event replay and hydration, send retries,
attachments, reactions, message mutations and receipt ranges. Delayed socket
events are filtered separately per recipient; clear notifications go only to
the deleting user's sessions. Reconnect also fetches authoritative server
state. Search currently filters the authorized recent list by username; there
is no independent full-text message search endpoint.

The Chats row supports a 480ms touch/pen hold, right click, Shift+F10, the context
menu key and an explicit focusable actions button. Movement over 10px, native
scroll, pointercancel, a second finger, backgrounding and unmount cancel the
hold. Confirmation explains the private scope. Escape, outside tap and mobile
Back dismiss the menu. Failed deletion keeps the row and allows retry. Removal
starts only after server success and uses 190ms motion, disabled when reduced
motion is requested.

## Verification and rollback

Run the entire backend unittest suite, `npm test`, `npm run test:interop`,
`npm run test:browser`, and `npm run build`. Phase 204 includes real authenticated
ASGI multipart tests with real CAPTCHA, image storage and decoding, plus private
history, security, concurrency, migration and WebSocket tests. Browser tests use
real Chromium with an isolated backend, including upload retries and deletion
confirmation/failure recovery. They require loopback sockets and Playwright.

The controlled successor release bundle is under
`/root/helix-phase20/phase20.4/release/`. It retains the existing host deployment
pipeline, checksum guards, Iranian Python mirror, absolute runuser path,
non-root systemd build, ALTCHA login verification, quiesced durable backups and
code rollback. Additional browser and migration gates run before activation.
No database is automatically restored and no additive table is dropped.

The previous application can start against the additive schema and preserves
the boundaries, profile data and files. That older application does not enforce
the new visibility semantics while its code is active; a code rollback therefore
temporarily restores its previous view behavior. The boundary records remain
available when Phase 20.4 is reactivated.

Physical Android Gallery/Files, pinch zoom and long-press acceptance are pending
the owner on the actual production domain. Local test success does not mean a
production release has been activated.
