# Metrics contract

The currently qualified application series belong to the isolated Docker
candidate; host series describe the actual VPS. They are not measurements of
the systemd production application. Before cutover, preserve the qualification
TSDB separately and initialize the reviewed production TSDB so unlabeled QA
history is not relabeled as production. Add only fixed environment labels to
future scrape series; Prometheus external_labels alone do not label local
PromQL data. See [current transaction plan](CUTOVER-21.2.1.md).

Dashboard inventory correction: 26 panels / 30 queries (application 10/12,
infrastructure 7/9, services 9/9). Query syntax validation is distinct from
live Grafana datasource values and browser rendering.

`GET /internal/metrics` uses Prometheus text exposition 0.0.4. It is disabled
(404) without `METRICS_TOKEN_FILE`. With a configured file (at least 32 bytes),
exactly one `Authorization: Bearer ...` header is required; wrong credentials,
other methods and internal paths return 404. Nginx blocks the entire internal
prefix independently of bearer authentication. Keep the backend loopback only.
The scrape endpoint is not listed in OpenAPI and excludes itself from metrics.

The collector uses the Python standard library, a lock and cumulative histogram
buckets. It creates no server thread, performs no external calls and requires no
new unresolvable package. It supports exactly one process, matching HELIX's
presence architecture. Run `promtool check metrics` on real exposition before
acceptance. Linux process collectors omit inaccessible /proc observations.

| Metric | Type | Labels / meaning |
| --- | --- | --- |
| `helix_http_requests_total` | counter | method, route template, numeric status; completed responses including static requests as `unmatched` |
| `helix_http_errors_total` | counter | same labels; 4xx and 5xx subset |
| `helix_http_request_duration_seconds` | histogram | method, route; elapsed time to final response body, excludes background work; buckets .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, +Inf |
| `helix_websocket_connections` | gauge | authenticated registered sockets; multiple tabs count separately |
| `helix_websocket_disconnects_total` | counter | authenticated sockets removed exactly once, including expiration/send failure |
| `helix_message_delivery_total` | counter | event from a fixed allowlist, outcome success/failure/expired; actual frame send attempts; success is not a read/delivery receipt |
| `helix_message_submissions_total` | counter | outcome success/failure for message POST API responses; includes idempotent replays |
| `helix_uploads_total` | counter | kind attachment/profile; outcome success/failure for upload responses; includes rejected auth/multipart/validation/storage attempts |
| `process_start_time_seconds` | gauge | collector initialization epoch |
| `process_cpu_seconds_total` | counter | process user + system CPU seconds |
| `process_resident_memory_bytes`, `process_virtual_memory_bytes` | gauge | Linux resident and virtual memory |
| `process_open_fds`, `process_max_fds` | gauge | current and maximum file descriptors |
| `helix_api_health` | gauge | host collector's real /api/health result (DB query); 1 healthy, 0 failed |
| `helix_container_running`, `helix_container_healthy` | gauge | fixed service label: app/prometheus/grafana/node-exporter |
| `helix_container_restart_count` | gauge | Docker RestartCount of current container; resets on recreation; not a lifetime counter |
| `helix_container_memory_bytes`, `helix_container_memory_limit_bytes` | gauge | actual Docker stats and configured cgroup limit |
| `helix_container_cpu_cores`, `helix_container_cpu_limit_cores` | gauge | observed CPU usage in cores and quota |
| `helix_host_collector_timestamp_seconds` | gauge | freshness of last complete host collection |
| `node_*` | exporter-specific | CPU, meminfo, filesystem, diskstats, netdev and textfile collectors only |
| `up`, `scrape_*`, `prometheus_*` | Prometheus built-in | real scrape and TSDB observations |

No usernames, IDs, JWTs, query strings, filenames, message text, remote IPs or
arbitrary request paths appear in labels. Methods outside a fixed set become
OTHER; unknown routes become unmatched. Router templates are captured from the
API routers, including FastAPI's lazy router registration behavior. HTTP errors
on static content and Nginx-rejected uploads are not application upload attempts.

Traffic-dependent counters remain absent until the first observation. Do not
replace missing data with invented zeros in acceptance evidence. Generate real
isolated requests for P50/P95/P99 and upload/delivery panels. A low-volume p99
is a bucket estimate, not an exact sample percentile.

Prometheus evaluates service outage, API DB health, sustained 5xx, low disk and
stale host collector rules. Alerts appear in Prometheus and the Service Health
Grafana dashboard. No external notification receiver is configured or claimed;
connect Alertmanager/contact routing in a separately reviewed change.

The HTTP error fraction displays a derived zero only when real HTTP observations
exist and there have been no 5xx responses. It remains absent when the entire
HTTP metric is absent. This is a ratio of observed traffic, not injected metrics.
