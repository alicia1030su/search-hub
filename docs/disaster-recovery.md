# Search Hub v0.1.15 disaster recovery

A complete recovery package (`.shbackup`) is an **age-encrypted tar stream** with exactly three members, in this order:

1. `manifest.json` — package identity, producer, database/key metadata, limits, encryption, origin guard, embedded schema contract and AES-GCM key proof;
2. `data/search-hub.db` — a consistent SQLite snapshot in `journal_mode=delete`;
3. `keys/master.key` — the 32-byte AES master key used for provider/model credentials.

The format is `age(tar)`, not `age(gzip(tar))`. Encryption uses `age-encryption` 0.3.1's default scrypt work factor **18**. Verification rejects a different work factor, a malformed header/MAC, a non-16-byte salt, additional recipients, non-canonical tar entries and any bytes after the two tar end blocks.

Passphrases must contain at least 12 Unicode code points after trimming for validation, but the **original untrimmed value** is used for encryption and decryption. CLI sources are `SEARCH_HUB_BACKUP_PASSPHRASE` or `--passphrase-stdin`; interactive TTY input is hidden. There is no argv password option, and passphrases/key material are never logged.

> A legacy `.db` download does **not** contain `master.key`. It remains available for compatibility and inspection, but a structurally valid `.db` is not proof that provider credentials can be decrypted or that the instance is recoverable.

## 1. Create a complete local package

`shub backup create` opens the source SQLite database read-only and uses `VACUUM INTO`. It never copies a live `db + WAL + SHM` set. The snapshot is verified before encryption; a fake, empty-shell or corrupt database cannot produce a successful package.

### Bash

```bash
export SEARCH_HUB_DATA_DIR=/var/lib/search-hub
export SEARCH_HUB_DB_PATH=/var/lib/search-hub/search-hub.db
read -rsp 'Backup passphrase: ' BACKUP_PASSPHRASE; echo
printf '%s\n' "$BACKUP_PASSPHRASE" | \
  shub backup create --output /var/backups/search-hub/search-hub.shbackup --passphrase-stdin
unset BACKUP_PASSPHRASE
```

### PowerShell

```powershell
$env:SEARCH_HUB_DATA_DIR = 'C:\ProgramData\SearchHub\data'
$env:SEARCH_HUB_DB_PATH = 'C:\ProgramData\SearchHub\data\search-hub.db'
$pass = Read-Host 'Backup passphrase'
$pass | shub backup create --output 'C:\Backups\SearchHub\search-hub.shbackup' --passphrase-stdin
Remove-Variable pass
```

Optional explicit paths are `--db <file>` and `--master-key-file <file>`. `SEARCH_HUB_ENCRYPTION_KEY` takes precedence over the key file; a missing file is not silently ignored when an env key is configured.

The command publishes the package and private JSON reports only after SQLite integrity, required schema, foreign keys, `user_version`, journal mode, database hash, key fingerprint, key proof and real AES-GCM sample checks pass. Reports contain duration and resource peaks, but no passphrase, key plaintext or production absolute paths.

## 2. Verify offline

Verification is streaming and has no 64 MiB API upload limit. Use the local command for large files.

```bash
printf '%s\n' "$BACKUP_PASSPHRASE" | \
  shub backup verify /var/backups/search-hub/search-hub.shbackup --passphrase-stdin
shub backup verify /var/backups/search-hub/legacy.db \
  --data-dir /var/lib/search-hub --master-key-file /var/lib/search-hub/master.key --legacy
```

```powershell
$pass | shub backup verify 'C:\Backups\SearchHub\search-hub.shbackup' --passphrase-stdin
shub backup verify 'C:\Backups\SearchHub\legacy.db' --data-dir 'C:\ProgramData\SearchHub\data' --legacy
```

The six independent boolean results are:

- `formatOk`
- `structuralOk`
- `schemaCompatible`
- `keyFingerprintMatch`
- `ciphertextSampleDecryptable`
- `restoreReadiness`

`keyReadiness` is one of `verified | unverified | missing | mismatch`; reports also include sample counts and key-proof validity. A package with no provider/model ciphertext rows can still be verified through its random AES-GCM key proof. A legacy DB with zero samples can only be `unverified`; a legacy DB without a key has `restoreReadiness=false` and the verify command exits non-zero.

Verification uses a private OS temporary directory by default and cleans it on success and failure. Only an explicit staging API returns a lease for restore. Cross-process locks cover KDF/verify/restore operations, and disk preflight happens before decryption.

## 3. Restore into a new or empty data directory

The web UI intentionally has no in-place restore button. Restore requires a target that does not exist or is empty. The target, every ancestor, the source data directory and the install directory are checked for symlink/junction/reparse-point and origin-guard violations. A second restore refuses to overwrite the first.

Running `restore` without `--dry-run` or `--apply` defaults to **dry-run** and does not create or modify the target.

```bash
shub backup restore /var/backups/search-hub/search-hub.shbackup \
  --data-dir /var/lib/search-hub-restored --passphrase-stdin
# Inspect the report, then explicitly apply:
shub backup restore /var/backups/search-hub/search-hub.shbackup \
  --data-dir /var/lib/search-hub-restored --apply --start-check --passphrase-stdin
```

```powershell
shub backup restore 'C:\Backups\SearchHub\search-hub.shbackup' `
  --data-dir 'C:\ProgramData\SearchHub\restored' --passphrase-stdin
shub backup restore 'C:\Backups\SearchHub\search-hub.shbackup' `
  --data-dir 'C:\ProgramData\SearchHub\restored' --apply --start-check --passphrase-stdin
```

`--apply` uses same-volume sibling staging, verifies before publication, applies explicit private permissions/ACL and atomically renames the ready directory into place. A failed post-publication `--start-check` quarantines the failed version and restores the target's original empty/absent state.

For packaged/SEA installations, `--start-check` uses the bundled Node runtime and the real `app/apps/api/dist/server.mjs`; it does not spawn the SEA executable as a second server. It requires an exact-version healthy response on a dynamic loopback port and terminates only the child it owns.

Restored databases use the standard `data/search-hub.db` layout. If a deployment requires a custom DB filename, set `SEARCH_HUB_DB_PATH` explicitly at service start.

## 4. Web and HTTP API

Open **Backup center** (`/backup`) to inspect status, create/download an encrypted package, download the legacy `.db`, or upload a backup for verification. The UI never returns `master.key` as a separate plaintext download.

- `GET /api/admin/backups/status` — read-only admin-session status; no key material.
- `POST /api/admin/backup/package` — JSON `{ "passphrase": "…" }`; streams a verified `.shbackup`. Requires admin session + CSRF, rate limiting, one generator at a time and a bounded temporary-disk quota.
- `POST /api/admin/backup/package/verify` — multipart package upload; rate limit → admin scope → CSRF → temporary quota reservation all complete before the body is consumed.
- `GET /api/admin/backup` — legacy unencrypted `.db`; never includes `master.key`.
- `POST /api/admin/backup/verify` — raw legacy `.db`, hard 64 MiB cap. Authentication and CSRF complete before any upload byte is written to disk.

Rejected anonymous, low-scope, missing-CSRF, oversized or over-quota uploads must write zero bytes and create zero temporary files/directories.

## 5. Deployment checklist

### Docker named volume

A container image does not include the named volume. Create packages through the API/CLI against the mounted data directory, then test restoration into a fresh volume. Never mount the production volume over a restored directory. Run recovery drills with a non-root container user and read-only root filesystem where practical.

### systemd

The service account needs write access only to its data directory and backup destination. Keep `master.key` at `0600` or an equivalent explicit Windows ACL. `systemctl stop search-hub` and the updater's independent stopped-state proof must succeed before replacement; stop failures are fatal, not warnings.

### nginx / reverse proxy

Package generation and verification can take longer than a default proxy timeout. Configure the admin location rather than disabling authentication:

```nginx
location /api/admin/backup/ {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_request_buffering off;
  proxy_read_timeout 600s;
  proxy_send_timeout 600s;
}
```

### Windows permissions

Staging directories are `0700` and files are `0600` on POSIX. On Windows the code applies a non-inherited ACL for the current user SID, SYSTEM and Administrators, then reads it back; failure to apply or prove the ACL aborts backup/restore. POSIX mode bits are not treated as proof of Windows ACL protection.

## 6. Operational safety

- Store the package and passphrase separately. A backup encrypted with a lost passphrase is unrecoverable.
- Never paste `master.key`, provider keys or passphrases into tickets, argv or logs.
- Restore drills must use temporary directories, isolated containers and dynamic ports, never production data.
- After restoring, verify admin login, provider/key decryption, REST search, MCP and CLI behavior before switching traffic.
- Keep the failed/previous data directory until the restored instance passes acceptance.
- Performance evidence must cover 10/64/256 MiB packages, warm-up, repeated and fresh-process rounds. Resource exhaustion is `BLOCKED`; it is never a reason to lower the KDF or invent an RSS threshold.
