# HELIX monitoring subpaths — 2026-10-21

Production explicitly returns 404 for `/grafana`, `/grafana/`, `/prometheus`
and `/prometheus/`, including descendant paths. These requests cannot fall
through to the application SPA. The active Nginx site was syntax checked,
backed up and reloaded without restarting the application. The optional
administrator Prometheus UI remains disabled.

Grafana remains stopped. The current official 13.2.4 binary contains
`github.com/getkin/kin-openapi v0.144.0`; CVE-2026-100354 requires >=0.149.0.
A fresh scan of the complete publisher image reports 75 High findings,
13 distinct High CVEs and zero Critical. This includes CVE-2026-111943,
requiring Go 1.26.10 or 1.27.3; the main binary embeds Go 1.26.9.
The historical 11 High count describes a different, pruned local image.
Neither artifact is qualified for public exposure.

Official image identity:

| Object | SHA256 |
| --- | --- |
| Reference | `dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f` |
| amd64 manifest | `7b22f3edf947329d75eba7a62d9f6ea1ac1e786736813ef7a98cfb275a52e49b` |
| OCI configuration | `45900b2eda7da0cbda80b9025e446147d9085fee71675ba86a48a1cad34e4c8a` |
| Extracted main binary | `91040ca83733197346a586b79b102a408b269d0d63af72fb78f6f5055ea0df15` |

The manifest/config/layer chain and binary were independently inspected.
Publisher image signature verification is **not claimed**. No custom binary
was deployed; no plugin signature setting was relaxed.

The checked-in Grafana configuration prepares HTTPS root URL
`https://helix.localip.ir/grafana/`, subpath handling, secure session cookies
and the permitted Live origin. It is not applied to a running Grafana service.
The existing `grafana-reviewed` Compose profile remains mandatory.

`nginx/monitoring-routes.conf.example`, `monitoring-http.conf.example` and
`monitoring-access.conf.example` are uninstalled templates. The access template
requires both a loopback connection and an administrator password. Remote
administrators must use an approved SSH tunnel or replace the loopback ACL
with a verified VPN administrator range. Do not trust client-supplied
forwarded headers for access control. Keep `satisfy all`, the Nginx default.
Provision the password file outside Git, with only root/Nginx access.
Grafana keeps its own login and RBAC; edge Basic credentials are stripped
before proxying, so Grafana uses its authenticated session cookie.

The Grafana proxy retains `/grafana/`, forwards the real HTTPS/host headers
and supports `/grafana/api/live/ws`. The optional Prometheus overlay sets
`--web.external-url=https://helix.localip.ir/prometheus/` and
`--web.route-prefix=/`. Its proxy removes the external prefix, preserving
private API, health and scrape URLs. The overlay publishes only
`127.0.0.1:19090`; it is not used by active production. No lifecycle/admin
API flags are enabled; Nginx additionally denies these endpoints and metrics.

To enable in a future reviewed release:

1. Qualify a supported publisher image with fixed embedded dependencies,
   verify the immutable artifact/signature using the publisher's documented
   signing identity, rescan all binaries/plugins and pass its release gates.
2. Provision the approved administrator access mechanism. Validate anonymous,
   wrong-password and non-VPN clients are denied, including Live connections.
3. Install the HTTP map and protected access snippet, then replace the four
   monitoring deny locations with the reviewed route template. Do not keep
   duplicate locations. Back up the current site and run `nginx -t` first.
4. If the optional Prometheus UI is approved, use its Compose overlay and
   recreate **only Prometheus**, preserving its existing volume. Do not run
   a broad Compose recreation or restart the application.
5. Start Grafana only after its own gate passes. Test authenticated redirects,
   static assets, cookie scope/security, Live upgrades, all 26 rendered panels
   and all 30 queries from an external administrator browser. Restore explicit
   deny locations if any access/security test fails.

The current read-only `public-https-check.cjs` tests public denial and HELIX
assets, not an enabled Grafana interface. `verify-production-metrics.py`
matches the actual production process start time against its Prometheus
series and checks all dashboard expressions for fresh finite observations.
An empty Active alerts result is valid; Grafana rendering remains unverified.

Primary references: [Grafana releases](https://github.com/grafana/grafana/releases),
[kin-openapi advisory](https://github.com/getkin/kin-openapi/security/advisories/GHSA-g8cf-rcjf-c8cf),
[Grafana proxy configuration](https://grafana.com/tutorials/run-grafana-behind-a-proxy/),
[Prometheus command-line flags](https://prometheus.io/docs/prometheus/latest/command-line/prometheus/).
