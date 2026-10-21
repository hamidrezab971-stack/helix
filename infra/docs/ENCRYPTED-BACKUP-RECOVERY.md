# HELIX encrypted backup and recovery — 2026-10-21

Current verified artifact on the production host:

`/var/backups/helix-encrypted-20261021/helix-production.tar.gz.gpg`

SHA256: `0a7cd3badaa947b4e0946af0838f964890ec0492e4028428d3bc896ce2c7bd48`

Size: 171,986,165 bytes. Both its directory and the separate recovery-key
directory are mode 0700; artifact/key files are mode 0600. The random recovery
secret is stored at `/root/.config/helix-backup/recovery-passphrase`. Its value
must never be printed in chat, committed, or stored beside the offsite artifact.

The backup uses GnuPG AES256 symmetric encryption, SHA512 iterated/salted S2K
and encrypted-message integrity protection. The random secret has 512 bits
of source entropy. Plaintext staging and restore-test directories were removed
after successful verification. Encryption is not an offsite transfer.

Included recovery materials:

- Current production SQLite snapshot through the online backup API and all
  uploads; attachment/profile references and immutable file hashes checked.
- Protected HELIX runtime configuration, signing/monitoring credentials,
  Nginx/TLS configuration and certificates, deployment files and systemd guards.
- Source archive of the synchronized baseline, current local application and
  Node Exporter image archives, and image identity inventory. Prometheus is a
  retrievable official immutable image recorded in the Compose configuration.
- The preserved legacy rollback archive, suspended Grafana data archive and
  original release manifest. Legacy data stays separate from current data.

The real encrypted artifact was decrypted into an isolated temporary directory.
All 135 regular files matched the internal checksum manifest exactly. SQLite
integrity and foreign keys passed, and table counts matched the snapshot.
No restore, container recreation or database reset was performed on production.
This proves archive/database restore integrity; it does not claim a full
disaster-recovery application launch on another host.

Repeatable preparation, using a new output directory each time:

```sh
python3 infra/scripts/encrypted-backup.py \
  --output /var/backups/helix-encrypted-YYYYMMDDTHHMMSSZ \
  --passphrase-file /root/.config/helix-backup/recovery-passphrase
```

The script never uploads. Its `verification.json`, checksum file and raw logs
stay private outside Git. Do not copy production data into the public repository.
SQLite is transactionally consistent at snapshot time. Uploads are copied and
their hashes rechecked; a concurrent deletion/replacement or missing referenced
file fails the backup, requiring a retry. The process does not stop the app.

For recovery on a clean isolated host:

1. Retrieve the ciphertext through the approved destination and retrieve its
   recovery secret through a separate authorized secure channel. Compare
   SHA256 against the trusted `SHA256SUMS` and this delivery record.
2. Create a mode 0700 recovery directory and decrypt without printing the key:

   ```sh
   umask 077
   gpg --batch --pinentry-mode loopback \
     --passphrase-file /secure/separate/recovery-passphrase \
     --output /secure/restore/payload.tar.gz \
     --decrypt /secure/restore/helix-production.tar.gz.gpg
   ```

3. Extract with Python `tarfile`'s `filter='data'` into that isolated directory.
   Check every regular file against `helix-recovery/MANIFEST.json`; reject
   extra/missing files. Run SQLite `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check` before using the snapshot.
4. Load the application/exporter image archives and independently check their
   OCI manifest/configuration identities. Verify official Prometheus by the
   recorded immutable digest. Restore configuration/keys with their original
   restrictive permissions. Check storage UID/GID 10001, single-writer guards,
   network isolation and loopback bindings. Keep Grafana stopped.
5. Start the restored application with **separate** isolated data/ports and
   validate authentication, upload retrieval, WSS, asset fingerprints and real
   metrics. Production replacement requires a deliberate reviewed cutover;
   never restore over a live database, merge legacy/current databases or run
   two writers against the same storage.

Offsite status is **BLOCKED**: no destination or credential binding is
authorized/configured. Required owner action is to name an approved SFTP/SSH
host/path or bucket/prefix, identify the existing protected access mechanism
and arrange separate recovery-key custody (preferably provide only an offline
recipient's public encryption key). Never paste private credentials into chat.
After transfer, verify the checksum **at the destination**, download a test copy
and repeat the restore integrity check before marking offsite VERIFIED.

Retention currently preserves this verified local copy indefinitely; no pruning
or scheduled deletion is enabled. Proposed remote retention is 30 daily,
12 weekly and 12 monthly verified copies, with provider versioning/immutability
where supported. Approval and destination-side enforcement/verification remain
pending. No retention, offsite schedule or object-lock guarantee is claimed.
