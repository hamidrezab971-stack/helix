ARG UPSTREAM_IMAGE
FROM ${UPSTREAM_IMAGE}
USER 0:0
RUN apk add --no-cache --upgrade brotli-libs=1.2.1-r0 musl=1.2.6-r3 musl-utils=1.2.6-r3 zlib=1.3.2-r1
# Retain the digest-pinned publisher frontend and runtime files. Replace the
# backend with the tested same-release build and the complete signed plugin.
RUN rm -rf /usr/share/grafana/data/plugins-bundled/*
COPY --chmod=0755 grafana /usr/share/grafana/bin/grafana
COPY prometheus/ /usr/share/grafana/data/plugins-bundled/prometheus/
RUN chmod 0755 /usr/share/grafana/data/plugins-bundled/prometheus/gpx_grafana-prometheus-datasource_linux_amd64
USER 472:472
ARG HELIX_COMMIT
LABEL org.opencontainers.image.source="https://github.com/hamidrezab971-stack/helix" \
      org.opencontainers.image.revision="${HELIX_COMMIT}" \
      org.opencontainers.image.description="HELIX Grafana 13.2.4 security rebuild; publisher-signed Prometheus 13.2.4; no unsigned plugins"
