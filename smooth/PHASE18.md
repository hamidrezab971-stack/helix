# Phase 18 implementation and validation

Implemented on `phase18-fluid-messaging`, based on `0b62630`. This is a local
review branch; production acceptance is pending the runtime checks below.
Existing uncommitted hosting work is excluded from the Phase 18 commits.

The branch has five milestone commits: shell/composer (18A), message presentation
and context actions (18B), idempotent optimistic sends (18C), scoped durable
presence (18D), and regression coverage/polish/documentation (18E).

## Message contract

Text JSON and image multipart accept optional `client_message_id` UUIDs. Omission
preserves legacy sends. The UUID is returned in full message, history, replay and
message events. Both members may see a UUID; it contains no credentials. Identity
is scoped to the sender, including in the frontend reconciliation helpers.

Migration 18 adds nullable `messages.client_message_id`, a unique sender/UUID
index, nullable `users.last_seen_at`, and `message_send_intents`. Existing rows and
Phase 17 migrations remain intact. Startup runs the migration before receipt
hydration. New installations use the same model metadata.

Message and intent hash commit atomically. A duplicate identical request returns
HTTP 201 with the current canonical message, without another create event.
Different conversation/text/reply/image bytes with the same sender/UUID return
409. Caption whitespace is normalized; filename and multipart MIME are not part
of intent. Validated content bytes determine image identity. Concurrent losers
roll back and remove their extra stored file. A retry after deletion returns 410;
the retained hash ledger prevents resurrection. It retains no message text or
image bytes. Do not prune this ledger without defining an idempotency expiry
contract for clients.

The outbox belongs to the authenticated HomePage. Its UUID-keyed pending entries
never enter the numeric Phase 17 timeline. Failed text, reply and file selections
remain in the composer; the pending bubble also retains its immutable intent and
retry control. Retrying unchanged content uses the same UUID. Changing/cancelling
a failed composer draft cancels that local attempt and allows a new UUID. Explicit
Dismiss removes a failed local entry. Conversation switches retain pending sends
and files; logout/page reload releases this in-memory outbox. Pending sends are
not stored across a page reload, so do not describe them as a durable offline queue.

The 30-second transport deadline reports an uncertain send as failed. A later
retry is safe even if the server committed. A socket echo can confirm an entry
before REST. Canonical recovery removes its overlay exactly once. REST create
responses only request recovery and cannot overwrite later edits/deletions.
Confirmed IDs are tracked only in their own conversation during replay. Pending
ordering uses submission order; browser timestamps never sort the canonical list.

## Presence contract

Run exactly **one backend worker**. Online means at least one authenticated socket
registered in this process. Closing a tab preserves Online while another socket
remains. The browser sends a heartbeat every 30 seconds; a silent socket is
closed after 75 seconds without a frame. This bounds stale registrations when a
transport stops reporting disconnects. Typing and receipt packets do not write
last seen. Active heartbeat writes coalesce across tabs to once per minute;
the final disconnect writes the server UTC time again.

`GET /api/users/presence` returns server time and only existing conversation peers,
with `user_id`, `online`, and nullable ISO UTC `last_seen_at`. The public user
directory/auth responses do not expose these timestamps. New clients negotiate
`presence_version: 18` in the socket auth frame. Offline updates carry a detailed
timestamp only to authorized conversation peers with that capability. Legacy and
unapproved observers retain the original `{user_id,status}` event shape.

The frontend refreshes the scoped snapshot after socket snapshots/reconnects,
conversation opening and visibility changes. One 30-second clock serves all labels,
calibrated from server time. UTC parsing and viewer-local calendar formatting are
explicit. Typing overrides status only on authenticated remote events and expires
after four seconds. Relative minutes end strictly before one hour. Future/invalid
or unknown timestamps display `offline`.

Presence timestamps are recent estimates during a crash, not inferred disconnect
times. Multi-worker/host presence requires a shared TTL store and broadcast layer,
such as Redis, plus an explicit crash-expiry design.

## Presentation and interaction

The authenticated shell uses a fixed desktop sidebar and one flexible conversation
pane. Mobile list transitions retain the chat DOM/scroll position. Hidden mobile
chat panes acknowledge delivery, not read. The normal layout uses `100dvh` and safe
areas; `visualViewport` height is used only for a focused mobile input when the
layout viewport has not shrunk with the keyboard, and never during pinch zoom.

Date separators and five-minute sender groups do not modify message records.
Photo-only surfaces have zero bubble padding/background; authenticated image blobs
retain the bounded LRU and URL cleanup. Images reserve intrinsic aspect ratios.
The viewer handles Escape, focus, mobile browser back, and a vertical close swipe.

A bubble click, context click, or keyboard action opens a collision-aware portal
menu. Photo/quote/reaction controls retain their own actions. An unobtrusive menu
button appears on hover/focus for media and keyboard use. Sender-only edit/delete
choices and an accessible deletion confirmation remain enforced by the backend.
Edits and reply previews live above the composer. Menus trap focus and close on
Escape, outside click, back, scroll, resize, deletion and action completion.
Entrance/exit motion is 200/150ms and respects reduced motion. New live visible
incoming messages and new pending sends animate; pagination/recovery do not add
entrance animations. Reaction displays use personalized timeline payloads and
mutations request selective bounded recovery, with no row-level automatic GETs.

## Verification commands

Use Python 3.12+ and Node 22.12+:

```bash
cd smooth/backend
python -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
.venv/bin/python -m unittest discover -s tests -v
cd ../frontend
npm ci
npm test
npm run build
npm install --prefix /tmp/smooth-browser-check playwright@1.51.1
/tmp/smooth-browser-check/node_modules/.bin/playwright install --with-deps chromium
NODE_PATH=/tmp/smooth-browser-check/node_modules npm run test:browser
```

The browser runner starts Vite and runs Phase 8, 17 and 18 serially with isolated
backend databases. Ports 5173 and 8000 must be free. Individual existing scripts
still run against an already-started Vite server. `test:browser:phase18` limits the
runner to the new scenarios. The added GitHub Actions workflow runs these checks
on a suitable runner once the branch is published.

Phase 8 and 17 behavioral assertions remain; their UI interactions now open the
portal menu and accessible confirmation instead of permanent action rows/native
confirm. Presence assertions use the milestone's lowercase labels and durable
last-seen text. Permission assertions inspect the open menu. No backend baseline
tests were removed or changed.

## Evidence from this workspace (2026-10-17)

- `npm test`: **10/10 passed**, covering 59s/60s/59m/60m, invalid/future/unknown,
  yesterday, spring/fall DST, grouping boundaries, exactly-once overlay removal,
  and sender/conversation-scoped UUID reconciliation.
- Python compilation and Babel parsing of all frontend source: passed.
- `git diff --check`: passed.
- `npm run build`: blocked (`vite: not found`). `npm ci --offline` reports missing
  cache entries; network dependency installation fails DNS resolution. Available
  Node is 18.19.1, below the project minimum.
- Backend unittest discovery was attempted; modules cannot import missing
  FastAPI/SQLAlchemy/JWT/AnyIO dependencies. The Python environment also lacks pip
  and ensurepip; downloading bootstrap/installers is blocked by network DNS.
- Playwright/browser runtime is **not validated** here: dependency and browser
  installation are unavailable. New browser scripts parse, but a parsing check
  is not evidence that their runtime assertions pass.
- GitHub connector reports `push: false`; no remote branch/PR or CI run was created.

Before release, obtain passing backend, build, Phase 8/17/18 browser runs and
review physical Android keyboard behavior at 360/390px, safe-area behavior, screen
reader announcements, swipe close, text selection, and touch/menu ergonomics.
A clean browser error log and device acceptance cannot be claimed from this
workspace. There is no production-ready sign-off in this document.
