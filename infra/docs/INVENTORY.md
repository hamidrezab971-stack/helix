# Verified real-host inventory — 2026-10-20 UTC

> Historical host observations. The later [Phase 21.2.1 review](PHASE21.2.1.fa.md)
> could recheck files and archived images but could not access Docker/systemd,
> current production storage or network. Do not treat the PID/health below as
> freshly verified. Dashboard inventory is 26 panels / 30 queries.

This inventory supersedes the restricted-session findings retained in
[INVENTORY-PRE-HOST.md](INVENTORY-PRE-HOST.md). This qualification ran on the
actual systemd VPS with root, network and Docker access. No public cutover ran.

| Component | Actual observation |
| --- | --- |
| VPS | srv8467792069, 185.252.86.112; Ubuntu 24.04.5 LTS, amd64, kernel 6.8.0-147-generic |
| Capacity before / after | Root: 46 GiB / about 33 GiB available; 3.8 GiB RAM, about 2.4 GiB available at final check; no swap; root inodes 4% used initially |
| Reviewed application | e2a53c97e705cc1a4cea992c386e561765f5d8c7; application source unchanged by qualification fixes |
| Actual production process | helix.service, PID 261758, started 2026-10-19 13:33:36 UTC; no restarts during qualification |
| Active release proven | /proc/261758/cwd resolves into /opt/helix/releases/2aec7a584c18194a3e1c; full fingerprint 2aec7a584c18194a3e1c01acf7fd026a1e125e8b7c2811544c77ec77fe6c26c0 |
| Public asset identity | All 12 marker entries, including HTML and retained JS/CSS assets, matched disk and public HTTPS SHA256 |
| Production application | Single uvicorn/wsproto worker, UID 997 / GID 987 (helix), 127.0.0.1:8000 |
| Production storage | /var/lib/helix/smooth.db; uploads under /var/lib/helix/uploads; 20 tables, 13 accounts, 67 messages, 5 message attachments and 3 profile photos in baseline |
| Backup | Online SQLite backup, integrity/FK checks, every upload hashed; 8 files / 8,249,911 bytes; DB 245,760 bytes; root-only retained original plus second rehearsal copy |
| Signing secrets | Original /etc/helix/production.env remains root:root 0600 and byte-identical; actual container JWT/CAPTCHA values compared in memory and match; no values logged |
| Nginx | Existing public master and site routing preserved; production proxy remains 127.0.0.1:8000; final nginx -T passes and original site/unit/marker hashes match baseline |
| TLS | Let's Encrypt YE2, CN helix.localip.ir; 2026-10-17 to 2027-01-15; actual private key target root:root 0600; real CA/SNI TLS and authenticated WSS validated on separate loopback listener |
| Renewal | Existing certbot.timer active, webroot /var/www/helix-acme and renewal hook preserved; renewal dry-run not executed |
| Docker installation | Official signed Docker apt repository; key fingerprint 9DC858229FC7DD38854AE2D88D81803C0EBFCD88; 5 new packages, no general system upgrade |
| Engine / tooling | Docker CE 29.9.1, containerd 2.4.2, Buildx 0.38.0, Compose 5.6.0; daemon active; overlayfs and cgroup v2 |
| Private stack | Project helix212-rehearsal-20261020; app + Prometheus + Grafana + Node Exporter running/healthy |
| Docker networks | Monitoring internal 172.30.212.0/24, gateway .1; app/Grafana ingress 172.30.213.0/24, gateway .1; no pre-existing overlap found |
| Exposed listeners | App 127.0.0.1:18000; Grafana 127.0.0.1:13000; private proxy 127.0.0.1:18443; exporter 172.30.212.1:19100; Prometheus un-published |
| Firewall | UFW originally inactive, original iptables/nft captured; Docker-managed bridge/NAT rules installed; all qualification ports refused via host public IPv4; no remote external vantage is claimed |
| Rehearsal data | /var/lib/helix212-qualification/rehearsal/data; UID 997/GID 987, separate from production; raw app.env root-only; original keys retained |
| Monitoring persistence | Existing named Grafana/Prometheus volumes retained; collector timer every 30s, root-only host Docker access, no container Docker socket |
| Extra services | helix212-qualification-collector.timer and helix212-qualification-proxy.service enabled; rollback rehearsal unit inactive; temporary TLS listener stopped after testing |
| GitHub | Shell push rejected for absent HTTPS credential; connected GitHub repository permissions independently show pull=true, push=false |

Private evidence, configs, backups, credentials and logs are under
`/root/helix-qualification-20261020/` (root-only). Container security checks
verified non-root IDs, read-only roots, all capabilities dropped,
no-new-privileges, bounded CPU/RAM/PIDs, no production bind and no Docker socket.
A real filesystem probe verified root writes fail and only isolated data/tmp
writes succeed. Neither production storage nor its ownership was replaced.
