# HELIX Phase 21.3 — browser monitoring operations

The active production design replaces the historical localhost source ACL with
HTTPS Basic authentication using separate named administrator and stakeholder
credentials. Grafana also requires its native session. This is layered password
authentication, **not MFA**. Anonymous access and sign-up remain disabled.

- `/grafana/`: both named edge users, followed by native Grafana login.
- `/prometheus/`: a separate administrator-only password file; the Viewer is
  rejected even with valid Grafana credentials. Only GET/HEAD are proxied.
- `/monitoring/`: protected navigation, without public operational details.
- Exporters, application metrics, Prometheus metrics/federation, lifecycle,
  remote write/read and administrative mutation APIs remain unavailable publicly.

Grafana retains its qualified image, internal `http://prometheus:9090` datasource,
secure/HttpOnly/SameSite=Lax session cookie and allowed Live origin. Nginx keeps
`/grafana/`, strips `/prometheus/`, discards client Authorization before proxying,
overwrites forwarding headers using the socket peer and supports Live upgrades.
Prometheus uses external URL `https://helix.localip.ir/prometheus/` with route
prefix `/`; collection and datasource paths stay private and unchanged.

`infra/nginx/helix-docker.conf` records the complete active TLS site. The three
monitoring snippets/templates are installed by `deploy-monitoring-browser.py`.
Login POSTs have a 6/minute per-peer limit with a 12-request burst; other monitoring
requests have a 20/second limit and 100-request burst, avoiding asset failures.
The isolated real-Nginx integration test verifies a real 429 response as well.
Datasource proxy/resource paths additionally allow only metric-query/metadata APIs;
config, runtime, targets, federation and raw metrics cannot bypass the admin edge.
Encoded or noncanonical proxy paths are rejected before reaching the upstream.

Deployment and rollback:

```sh
python3 infra/scripts/deploy-monitoring-browser.py
python3 infra/scripts/deploy-monitoring-browser.py --rollback
```

Activation checks the exact Grafana runtime image and security environment,
backs up configuration, provisions independent strong random credentials,
recreates **only Prometheus** to change its web flags, validates Nginx and reloads
it, then runs the production security contract. A failed activation restores the
previous private routes. The application, Node Exporter and Grafana containers
are neither recreated nor rebuilt. Existing rollback directories are preserved.

The immutable original rollback is `/root/helix-phase21.3/rollback/`; its manifest
covers Nginx, authentication files, Prometheus rules/overlay, landing page and
journald retention. Keep it protected. Native Viewer provisioning is additive;
closing the edge is sufficient to revoke browser exposure during rollback.

Credential handoff: `/etc/helix/monitoring-handoff/stakeholder.json` is root-only
(0600 under a 0700 directory). It contains the independent edge and Viewer login.
The operator delivers **only this file's contents**, using an approved private
channel or password manager; the stakeholder subsequently uses a normal browser
and needs no SSH or tunnel. The administrator file must never be delivered to
the stakeholder. Handoff to the person is a human operational step; do not put
credentials in issues, PRs, CI logs, screenshots or chat.

External acceptance uses temporary encrypted GitHub repository secrets, read
into mode-0600 files in a GitHub-hosted runner. Only reviewed acceptance scripts
receive them; browser sessions, HAR, traces, login screenshots and secrets are
never uploaded. Delete these temporary repository secrets after acceptance.
The authenticated workflow is restricted to this delivery branch and relevant
configuration/test paths; ordinary anonymous external regression runs remain.

Storage: Prometheus retains 15 days or 2GB, whichever threshold is reached first
(with normal WAL/head overhead). Existing per-container local log rotation is
10MB x 3. Journald is capped at 256MB/30 days with 2GB keep-free; no historical
journals were vacuumed. Root-filesystem available/size metrics drive a warning
below 20% and critical below 15%, sustained for ten minutes.

The October 21 and 23 reports are historical evidence. Current results and the
full panel/query inventory are in `PHASE21.3.fa.md`; never infer current service
health from those earlier reports.
