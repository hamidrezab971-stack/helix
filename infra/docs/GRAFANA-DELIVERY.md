# Grafana security delivery

Continue the retained Grafana 13.2.4 source patch on a disposable GitHub Actions
runner. `grafana-security.yml` builds only changes to its listed security inputs
on `monitoring/grafana-security-delivery`; documentation updates do not rebuild.
Production services, credentials, data and volumes are never CI build inputs.

`grafana-build-inputs.json` pins the upstream source, image, compiler, dependency,
publisher plugin archive and scanner. Verify the upstream GitHub commit signature
before applying the existing patch. The October 22 Prometheus 13.2.4 release uses
Go 1.27.3 and x/net 0.61.0; verify its complete PGP manifest against the key in the
verified upstream source, preserve every signed file, and require Grafana's own
runtime signature status to be `valid` / `grafana`. No plugin signing settings
are relaxed. A changed archive digest requires an explicit input review.

Qualification requires dependency regression tests, Grafana routing/signature
tests, verified Go modules, successful main compilation, inspection of every ELF,
kin-openapi 0.149.0 in the actual binary, and a complete fresh Trivy report with
zero HIGH/CRITICAL findings. The shared raw security gate is reused without
exceptions. Other HELIX services retain their separate existing release gates.
The database must be no older than 24 hours. Runtime health and authenticated
publisher plugin acceptance are also required.

The read-only build job uploads evidence and the image archive. Only a successful
qualification enables the separate publication job with `packages:write` and
OIDC. That job verifies evidence hashes, source commit and Docker image identity,
pushes GHCR, then signs and attests the immutable image with Cosign. Both the
signature and provenance must verify for the exact workflow identity and GitHub
OIDC issuer. `published-image.json` is produced only after verification.

Trust is stated precisely: the upstream base image is pinned by digest, but no
upstream OCI publisher signature is claimed. The final artifact is a tested HELIX
source rebuild with HELIX workflow signature/provenance and a Grafana-signed
Prometheus plugin. Do not describe the custom image as Grafana's official image.

After successful CI, review the PR, preserve its exact qualified commit in merge
history, verify the published signature/provenance independently on the host,
and deploy only the Grafana service with its existing volume. The existing
`grafana-reviewed` profile and private Nginx access controls remain mandatory.
Production acceptance still requires the authenticated HTTPS browser, Grafana
Live, all 26 panels / 30 queries and application/collection continuity. CI alone
never authorizes a `DEPLOYED` claim.
