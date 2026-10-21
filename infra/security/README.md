# گیت‌های مستقل انتشار

انتشار برنامه و رفع امنیت Grafana مستقل‌اند. شمارش خام همهٔ findingها در
`security-gate.py` همچنان High/Critical را شکست می‌دهد و هیچ finding مخفی نمی‌شود.
`application-security-gate.py` فقط image و گزارش دقیق دارای review تک‌تک ردیف‌ها
را با کنترل‌های واقعی runtime ارزیابی می‌کند؛ ریسک پذیرفته‌شده، ناشناخته یا
قابل دسترسی، گیت برنامه را عبور نمی‌دهد. ارزیابی این انتشار در
`application-review-20261021.json` است. Grafana با profile جدا معلق می‌ماند تا
artifact رسمی اصلاح‌شده از گیت مستقل خود عبور کند.

# Reviewed monitoring security inputs

The [real-host report](../docs/HOST-QUALIFICATION-21.2.1.fa.md) names the images
actually selected and scanned. `qualified-inputs.json` distinguishes successful
runtime changes from source patches whose builds failed. These patches do not
authorize production activation or qualify an unbuilt binary.

For reproduction, fetch each upstream repository at the exact commit in the
input manifest and apply its matching patch with `git apply --check --unidiff-zero` followed
by `git apply --unidiff-zero`. Zero context keeps original Go tab indentation out of patch-file whitespace checks;
verify the exact base commit before applying. Preserve `go.mod`, `go.sum` and Grafana's workspace files. Use
the pinned compiler image; never disable Go checksum verification. The private
qualification archive retains build commands, logs, module verification and
`go version -m` output for successful binaries.

The Node Exporter build used `CGO_ENABLED=0`, `GOFLAGS=-p=1`, the upstream
`make collector/fixtures/sys/.unpacked collector/fixtures/udev/.unpacked`
targets and `go test ./collector ./...`. Its build command was:

```sh
go mod verify
go build -trimpath -buildvcs=false \
  -ldflags '-X github.com/prometheus/common/version.Version=1.12.1-helix-security2 -X github.com/prometheus/common/version.Revision=6044da783597cc3b57aef7580ddcdcff58a4ee99' \
  -o /out/node_exporter .
go version -m /out/node_exporter
```

The final build used `GOTOOLCHAIN=go1.26.10` inside the pinned Go 1.26.9
compiler container. Go's standard checksum verification authenticated the
downloaded `golang.org/toolchain` module; its module and go.mod h1 sums are
recorded in `qualified-inputs.json`. The new compiler is required by the later
X509 advisory. The direct Go 1.26.10 image pull failed with a CDN 403 and was
not treated as a successful compiler input.

`monitoring-overlay.Dockerfile` takes a reviewed immutable upstream reference
as `UPSTREAM_IMAGE`. Build its Node Exporter target using a context containing
the verified `node_exporter` binary. The Grafana target needs no replacement
binary: it removes twelve complete disabled datasource packages. It preserves
the official main executable and the active publisher-signed Prometheus plugin.
Recheck signature status, module/package scans and all 26 panels/30 queries
after building. Do not use a missing or partially built binary as build input.

Prometheus and Grafana main source patches are **unqualified**: the final bounded
host builds failed in the Go linker with cgroup OOM. Prometheus UI assets were
built with frozen locks, and its web/rules tests passed, but no patched runtime
image was selected. A successful independently verified build with adequate
resources and fresh runtime qualification is required. The optional Prometheus
overlay target is for that future verified build.

The local Prometheus plugin SDK build passed tests and Mage Linux packaging.
Its checksum is outside the publisher's signed manifest, so it was retained
only as private evidence. Do not enable unsigned plugins or replace signature
metadata to deploy it.

HELIX additionally upgrades Pillow to 13.0.0. Its CPython 3.12 amd64 wheel hash
in `requirements.lock` was verified against official PyPI JSON over HTTPS;
the downloaded mirror bytes matched exactly. The wheelhouse remains private
and outside Git. Rebuild through the existing Compose/Dockerfile with locked
Node/Python bases and `pip --require-hashes`; never put production data or env
files in any build context.
