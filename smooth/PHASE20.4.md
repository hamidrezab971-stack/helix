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

## Browser presence regression investigation

Host run `20261017T180445Z-810d9a` reached real Chromium 134 and Vite 8.3.3.
The Phase 8 assertion at the former line 365 searched for `.avatar-presence`
inside `.recent-row`. The preceding assertions had already found that exact
username's preview and timestamp. The avatar belongs to the sibling profile
button inside the same list item, a structure also present before Phase 20.4.
This was an obsolete test hierarchy assumption. Changing presence transport,
conversation visibility, deletion boundaries or assertion timeouts cannot fix
that descendant lookup.

The replacement asserts one named chat row, its exact username, one enclosing
list item, its named profile button and exactly one presence indicator with
the expected online flag and rendered opacity. It also covers offline/tab
close/logout and recovery after reconnect. A component regression verifies
both presence states and the separate profile/chat/actions buttons.

All seven browser phases capture sanitized HTML, masked screenshots, recent
API method/path/status metadata and presence/connection summaries on failure,
before closing browser contexts. Only transport response headers (content type,
length, cache control, date, server, connection and transfer encoding) are allowed;
bodies, auth/cookie headers, auth frames, storage and query strings are excluded.
Request finish/failure timestamps and errors distinguish completed responses
from aborted requests. Socket request/close/error timestamps and isolated backend
logs correlate proxy resets with intentional page closure and backend restarts.
The host browser gate retains evidence outside
the disposable workspace and prints its location. CI uploads that evidence
on failure. These diagnostics do not change assertions or release gates.

## Presence response lifecycle investigation

Run `20261017T223516Z-b089d0` passed the first two Phase 8 checkpoint groups,
then failed at the former line 459 in Chromium's `Network.getResponseBody`.
The selected response was a 200 for `/api/users/presence`, fulfilled by the
test's missing-timestamp route. The hook refreshes on mount and again on the
WebSocket snapshot, aborting the previous refresh. Selecting the first response
headers and later asking CDP for that request's body depends on a resource that
may already be cancelled. Playwright 1.51.1 already waits for response completion
inside `Response.body()`, so adding `response.finished()` is insufficient.

Presence checks now perform a dedicated authenticated GET and consume its body
inside browser Fetch with a five-second abort bound. Status 200, JSON content
type, the exact persisted peer timestamp and the resulting UI are all asserted.
The missing-timestamp case seeds only the offline peer's row in the disposable
test DB, uses the same real endpoint and asserts null plus the rendered `offline`.
The original stored value is restored in `finally`, then the real API timestamp
and last-seen UI are asserted again. No presence request is intercepted or
fulfilled; parsing/network errors fail the suite. No production DB is touched.

The saved host browser evidence is unreadable in the restricted agent session;
old backend output was discarded by the fixture. Therefore the original
response headers and precise cancellation/fulfillment timing remain unverified.
Proxy ECONNRESET before the first checkpoint and EPIPE during final cleanup
are consistent with intentional socket closure, not proof of application
failure or proof that every reset was harmless. Full Chromium and live host
gates remain mandatory, with all seven phases and checksum checks retained.

## Last-seen reference clock and ordered presence

Run `20261017T205431Z-4d9038` reached the final-tab logout check in Phase 8
and displayed `offline`. The old hook updated `lastSeen` on the disconnect
frame but left its reference `now` at the previous 30-second tick. A valid
new server timestamp was therefore in the future relative to that stale
reference; `formatLastSeen` correctly rejected it. This code path reproduces
the reported text without any absent fixture data. Backend contract tests on
the unchanged baseline separately verify final-tab persistence, authorized
HTTP snapshots and private timestamp delivery. Full host artifact access and
a fresh complete Chromium run are still required for host confirmation.

The presence reducer updates status, known last seen and its reference clock
atomically. Server time corrects client clock skew. HTTP responses merge only
newer private timestamps and cannot replace realtime status. Missing/invalid
timestamps keep the offline fallback; genuinely future timestamps are still
rejected. Relative formatting through 59 minutes and older calendar formatting
remain unchanged. No timestamp is created from a local disconnect.

The frontend requests presence protocol 204. It adds server time and a
monotonic revision to snapshots and transitions; protocol 18 and legacy
payloads retain their previous shapes. Transition order is reserved before
database/delivery awaits. Superseded broadcasts are suppressed, including a
reconnect during membership lookup. The client rejects stale/duplicate events
and snapshots, resets revision order on a new socket stream, and retains valid
timestamps. Concurrent persistence cannot overwrite newer activity. Last-seen
details remain limited to authenticated conversation members.

Regressions cover the stale-clock failure, online/offline transitions, the
one-hour boundary, clock skew, stale events/snapshots, database write order,
reconnects, page refreshes and missing data. Phase 8 keeps its original 5-second
last-seen assertion and adds real-parser stale-frame, reconnect, refresh and an
explicit missing-data fixture. The complete seven-phase Chromium gate, crop
and long-press deletion checks remain mandatory before production activation.

## Login navigation synchronization

Host run `20261018T000356Z-bf57fa` failed after Bob's re-login because the
navigation helper inspected the layout immediately after clicking Log in.
Login and the authenticated-user request were still asynchronous. Seeing no
navigation, it committed to waiting for a mobile Back button; the eventual
desktop Chats screen correctly had navigation and no conversation Back button.
The saved sanitized DOM confirms that final layout.

The helper now waits, within the existing assertion timeout, for authenticated
navigation or a mobile conversation Back button before choosing its path. The
re-login regression delays the real login request by 250ms and immediately
selects a contact, exercising the pending-login state without mocking the auth
response. All seven browser phases, mobile Back assertions, security checks and
release gates remain required.

The next host run reached the unread batch after the mobile Back/keyboard
checks. Expanding to desktop exposed the retained conversation, so its messages
were correctly marked read. The unread fixture now remains on the mobile list,
asserts that the composer is hidden and that each message is Delivered, retains
the exact unread counts and replay/second-tab checks, then restores desktop
after explicitly reopening the conversation.

The following run passed those unread checks and reached an immediate
send-then-delete. The action helper matched a pending bubble, which recovery
replaced during scrolling. Message actions now resolve a row with its canonical
server message ID; pending and REST-before-recovery tests remain independent.
The deletion response waiter is joined with the action promise so an action
failure cannot also become an unhandled rejection when cleanup closes the page.
Older-message actions also finish the requested scroll over two animation
frames before pressing Enter on the resolved bubble. Scroll dismisses open
menus by design; a queued scroll must finish before the menu is opened.

The final explicit conversation retry fixture keeps its 503 response enabled
until the real Retry click. Previously removing the failure route first let a
realtime snapshot refresh the list and remove the button before the click.
The retry still requires an actual successful GET and visible persisted row;
the subsequent 401/storage-cleanup and exact database-count assertions remain.

Phase 17's mobile reduced-motion check targets the animated composer controls.
Its previous `.auth-input` selector addressed the authentication form, which is
absent from an authenticated chat. Normal motion must have a positive transition
duration; reduced motion must compute exactly `0s`.

The late eviction fixture reloads a real latest page and requires 30 rows plus
the older-page control before loading seven pages. Earlier reply-context checks
retain disjoint history, so their window is not a valid fresh fixture. Direct
SQL recovery fixtures also reload because SQL inserts emit no socket/sync hint.
Pagination response and click promises are joined to retain diagnostics if
either fails, while all eviction, deleted-target and recovery assertions remain.

Phase 18 reached its lost image-response fixture with a 422 from the forwarded
multipart request, followed by a 201 from the direct browser retry. The fixture
now leaves native multipart transmission to Chromium, pauses the actual server
response, requires 201 and a valid image message, consumes that paused body,
then drops the response. Retry must reuse the exact UUID and leave one persisted
row. Sync recovery remains blocked until the retry is confirmed. The protocol
documents multipart-file omission from request post-data and the required
response-pause lifetime for body reads in the
[official CDP schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json).
The mobile Back assertion uses the rendered header's exact accessible name.

Phase 19 waits for the viewport hook's animation-frame resize update before
checking composer bounds. The same nonnegative coordinates, one-pixel bounds
tolerance and document overflow checks remain. Failure output includes actual
viewport, scroll and composer rectangles. The captured 360px screenshot showed
the settled composer inside the viewport after the former immediate assertion.

Phase 19.1 measures creation attempts before and after reopening the retained
chat and requires no additional attempt. The initial development Strict Mode
mount can abort one opening POST before a second completes; counting those as
two chat creations was incorrect. A real authenticated API check additionally
requires exactly one persisted conversation identity. Draft retention and the
subsequent no-extra-WebSocket checks remain unchanged.
