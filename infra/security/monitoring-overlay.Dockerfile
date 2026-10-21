ARG UPSTREAM_IMAGE
FROM ${UPSTREAM_IMAGE} AS node-exporter
COPY --chmod=0755 node_exporter /bin/node_exporter
LABEL org.opencontainers.image.description="HELIX same-release Node Exporter security rebuild; qualified source and module provenance required"

FROM ${UPSTREAM_IMAGE} AS prometheus
COPY --chmod=0755 prometheus /bin/prometheus
COPY --chmod=0755 promtool /bin/promtool
LABEL org.opencontainers.image.description="HELIX same-release Prometheus security rebuild; qualified source and module provenance required"

FROM ${UPSTREAM_IMAGE} AS grafana
# Only Prometheus is enabled by the reviewed Compose configuration.
# Keep the publisher-signed active plugin and original Grafana main binary.
# Removing an unused package does not repair vulnerabilities in retained code.
USER 0:0
RUN for plugin in elasticsearch grafana-postgresql-datasource grafana-pyroscope-datasource influxdb jaeger loki mssql mysql opentsdb stackdriver tempo zipkin; do \
      rm -rf "/usr/share/grafana/data/plugins-bundled/$plugin"; \
    done
USER 472:472
LABEL org.opencontainers.image.description="HELIX Grafana scope reduction; twelve disabled datasource packages removed; signed Prometheus plugin and original main binary retained"
