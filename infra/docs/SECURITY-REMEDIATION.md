# Phase 21.2.1 security remediation — release remains NO-GO

Historical review from 2026-10-20. The subsequent real-host builds, scans and
runtime findings are recorded in [the current host report](HOST-QUALIFICATION-21.2.1.fa.md)
and [current security assessment](SECURITY-HOST-21.2.1.fa.md).

Review date: 2026-10-20 UTC. Findings are from the retained real image scans,
not from a rebuild in this restricted session. **No High finding is accepted
for production by this document.** The new security gate still returns 1.

## Provenance and before/after

Original scanner: Trivy 0.76.0,
`aquasec/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222`.
DB schema 2; UpdatedAt `2026-10-20T19:12:26.430296739Z`, downloaded
`2026-10-20T20:57:36.70483235Z`, NextUpdate `2026-10-21T19:12:26.430296358Z`.
Sources include Debian Security Tracker, Go Vulnerability Database and reviewed
GitHub advisories. The app scan was created at 21:01:20 UTC; monitoring scans
followed that evening. The monitoring script reused that DB with
`--skip-db-update`; its metadata establishes its age, not the word “fresh” in
a historical report.

| Image | Original Critical / High | Unique High CVEs | High findings with library/package fixes | Verified after remediation |
| --- | --- | --- | --- | --- |
| HELIX | 0 / 44 | 8 | 0 in Trixie | No rebuilt image or fresh scan; 44 remain the last observed count |
| Prometheus | 0 / 10 | 4 | 10 | No rebuilt image or fresh scan; last observed 10 |
| Grafana | 0 / 61 | 12 | 61 | No rebuilt image or fresh scan; last observed 61 |
| Node Exporter | 0 / 14 | 13 | 14 | No rebuilt image or fresh scan; last observed 14 |

The 129 High package/binary findings represent 30 unique CVEs across all images.
[Full installed/fixed versions, binary targets and CVE links](SECURITY-FINDINGS.md)
are preserved. Raw descriptions and report SHA256 hashes are in the private
`/root/helix-phase21.2.1/evidence/security-inventory.json`.
[Archived image identities](archived-image-identities.json) distinguish index
digest, amd64 manifest digest and image config ID; they are different objects.

## HELIX: reachability assessment

The actual retained image layers were read in order, including whiteouts.
This proves archived filesystem contents, not the current running container.
The source contains no invocation of the affected administrative tools.

| CVE | Evidence / prerequisites | Assessment and action |
| --- | --- | --- |
| CVE-2026-76642 | `mount` exists with mode 04755; fstab contains only an unconfigured comment. Needs privileged mount helper/post-hook operations. Nine source-package matches. | Local privilege path constrained by non-root, no-new-privileges, no capabilities and read-only root. Source hardening removes all SUID/SGID bits. Rebuild and actual runtime checks still required. |
| CVE-2026-78408 | `nsenter` exists, mode 0755. Needs an operator to open root cgroup authority with `--join-cgroup`. Nine matches. | No such application operation found; do not run privileged diagnostic helpers inside the container. Not a remotely reachable HELIX API path established by this review. |
| CVE-2026-78409 | Needs fstab-authorized X-mount.subdir and Linux >=6.15 detached-tree path. Nine matches; fstab has no entries. | Configuration prerequisite absent in archived image. Historical kernel 6.8 alone is not used to certify the present host. Keep mount restrictions; rescan when Debian fixes are published. |
| CVE-2026-78410 | Needs restricted privileged bind mount and writable source/fstab ancestry. Nine matches. | No configured bind-mount entry inside image; production data mount is created by Docker outside the app. Remove SUID bits at build and reverify dropped capabilities at runtime. |
| CVE-2026-54369 | libacl1 2.3.2-2+b1 is installed; issue requires privileged pathname ACL operations on attacker-controlled ancestry. | Library is present. No application ACL caller identified. Treat as conditional/unproven reachability, not a blanket false positive. Do not mix Debian unstable libraries into stable to reduce the count. |
| CVE-2025-69720 | `/usr/bin/infocmp` really exists. Four ncurses source-package matches; vulnerable implementation is the CLI parser. | Actual vulnerable tool present, though no upload/API invocation was found. Dockerfile removes that tool; keep ncurses/readline libraries and package metadata. Mitigation is staged, not yet built. |
| CVE-2026-16742 | libsystemd0/libudev1 are present; **systemd-homed executable is absent**. | Component-level overmatch for this homed-specific flaw in the archived image. No homed account manager exists there. Raw findings remain reported; no ignore rule added. |
| CVE-2026-9538 | perl-base exists; **no Archive/Tar.pm exists** in the merged archived filesystem. | Component-level overmatch: affected Archive::Tar parser is absent. HELIX does not process Perl tar archives. Preserve raw finding and recheck the next image rather than suppressing it globally. |

Debian currently reports no fixed Trixie packages for these findings. Upstream
fixes in unstable are not stable upgrade instructions. See the primary records
for [util-linux](https://security-tracker.debian.org/tracker/CVE-2026-78408),
[ACL and its ABI implications](https://security-tracker.debian.org/tracker/CVE-2026-54369),
[infocmp](https://security-tracker.debian.org/tracker/CVE-2025-69720),
[homed](https://security-tracker.debian.org/tracker/CVE-2026-16742), and
[Archive::Tar](https://security-tracker.debian.org/tracker/CVE-2026-9538).

## Monitoring: priority and fixes

P1 means resolve before release; P2 means conditional exposure needs runtime
evidence. Neither category grants an exception. No exploit was attempted on
production. Library presence alone is not proof of exploitability or absence.

| Group / CVEs | Priority, exposure and impact | Remediation / required evidence |
| --- | --- | --- |
| Grafana kin-openapi: CVE-2026-100349, -100351, -100352, -100353, -100354 | P1: includes authentication bypass and process-ending validation failures. Backend module present; affected call paths not yet proven unreachable. Loopback reduces exposure but is not a fix. | 0.144.0 -> at least 0.149.0 addresses this group. Obtain a supported patched Grafana build or reproduce a reviewed same-release source build; test real auth/datasource/dashboard APIs. |
| HTTP/2 SETTINGS: CVE-2026-78669 | P2 under the checked-in HTTP/1-only scrape/datasource configuration; potential client/server CPU DoS if HTTP/2 paths are enabled. Shared stdlib/x/net matches and plugin binaries explain duplicates. | Go >=1.26.9 or >=1.27.2 in the corresponding supported branch, x/net >=0.60.0. Verify the compiler embedded in **each** binary, including the Prometheus plugin; changing the OS layer cannot fix static Go binaries. |
| HTTP Range: CVE-2026-78667 | P1 pending call-path analysis: HTTP/1 remains in use; asset-serving handlers can be affected. Private networking limits the attacker set. | Same Go fixed branches. Check ServeContent/FileServer reachability and actual HTTP behavior; loopback is not sufficient to close the finding. |
| TLS ECH: CVE-2026-97031 | P2: requires Go TLS server path; checked-in monitoring uses plaintext private HTTP and Nginx terminates public TLS. | Same Go fixed branches; prove no independently enabled plugin TLS listeners. |
| gRPC xDS: CVE-2026-84445 | P2: requires xds.NewGRPCServer server routing. Present in Prometheus/promtool and Grafana stackdriver modules; no xDS service is configured here. | grpc 1.83.1/1.83.0 -> 1.83.2 on the existing branch (1.82.2 is a separate backport, not an instruction to downgrade). Binary call-path analysis remains required. |
| gRPC fragmentation: CVE-2026-84304 | P2: stackdriver backend plugin is unused in the sole-Prometheus datasource setup. Could exhaust memory on an exposed gRPC server. | grpc >=1.83.1; prefer >=1.83.2 for both gRPC findings. Disable unused backend plugins and verify none starts after recreation. |
| Tempo: CVE-2026-21728, CVE-2026-28377 | P2 / possible component overmatch: a Tempo client plugin contains module metadata, but no Tempo server, Tempo datasource or S3 SSE-C server endpoint is configured. Server large-query DoS/key disclosure does not follow merely from this dependency. | Do not claim fixed based on the pseudo-version. Confirm symbols/call paths with govulncheck and verify plugin disablement; keep raw findings until that evidence exists. |
| Exporter SSH: CVE-2026-56854 | P2: requires an SSH authentication callback/source-address policy; exporter is configured only as an HTTP metrics service. | x/crypto 0.54.0 -> >=0.55.0; verify binary reachability rather than assuming that importing the module creates an SSH server. |
| Exporter text: CVE-2026-56851 | P2: requires crafted Nickname transform/buffer path, not a documented metrics input. | x/text 0.40.0 -> >=0.41.0; confirm call graph with exact enabled collectors. |
| Exporter stdlib: CVE-2026-33818, -39821, -46600, -56853, -56858, -56859, -56860, -56862 | P2 conditional parser/DNS/h2c/template/XML/path/TLS paths. Current collectors are CPU, meminfo, filesystem, diskstats, netdev and textfile; no public input path to each affected function is established. | Original Go 1.26.5; the group has fixes in 1.26.6 (or 1.25.13 where stated), but use >=1.26.9 on that branch to include the later HTTP/TLS fixes. Still retain per-CVE evidence in the full inventory. |

[Go's HTTP/2 advisory](https://pkg.go.dev/vuln/GO-2026-6611) supports the branch
version floors. At review, official pages still list
[Prometheus 3.13.4 LTS / 3.15.0](https://prometheus.io/download/),
[Grafana 13.2.4](https://grafana.com/grafana/download), and
[Node Exporter 1.12.1](https://github.com/prometheus/node_exporter/releases).
An upstream fixed **module** is not evidence of a published fixed **image**.
No invented patch tag, unverified digest, major upgrade or binary replacement
was applied. The Sept. 24 Prometheus minor release predates the October Go
advisories and cannot be assumed to resolve them.

## Changes implemented in source

- Docker runtime build removes SUID/SGID bits (11 files in the archived image)
  and infocmp. Package database and scanning stay intact. No count reduction
  is claimed before a new build/scan.
- Grafana Compose disables the twelve unused bundled datasource IDs and
  automatic plugin preinstallation. The Prometheus datasource remains enabled.
  This is a pending recreation change; do not call existing plugin processes
  disabled until the host verifier confirms it.
- `scan-images.py` scans all four immutable images using a newly downloaded DB,
  rejects DB age >24h, checks image identity, retains all severities/unfixed
  findings, and uses a non-root, resource-bounded scanner without a Docker socket.
  `security-gate.py` collects all reports and fails on **every** High/Critical,
  including findings with no fix. Risk review is not a suppression list.
- The existing runtime security settings, image locks and dependency locks remain
  intact. Python/npm build stages are distinct from the shipped app. No app
  Python-package High was reported in the retained scan. Promtool is a shipped
  administrative CLI, not a running daemon or an npm build dependency.

## Mandatory next host gates

Build a new tagged candidate from this commit, resolve its immutable reference,
run the scanner, verify hardening and compatibility on fresh isolated production
data, and retest all four containers and real Grafana queries. Current scanner
and runtime access were denied. If reachable Highs remain, do not release them;
produce a tested fixed build or obtain an explicit bounded risk decision with
evidence. This report itself accepts none.
