#!/usr/bin/env bash
# Isolated Docker linux/amd64 packaged disaster-recovery drill.
set -euo pipefail
if [[ "${SEARCH_HUB_DR_TRACE:-0}" == "1" ]]; then set -x; fi

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=${1:?usage: platform-docker.sh <image> <packaged-shub> [evidence-dir]}
CLI=${2:?packaged shub path is required}
EVIDENCE=${3:-"$ROOT/artifacts/disaster-recovery/platform-docker-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
PROJECT="sh-dr-$RANDOM-$$"
NET="$PROJECT-net"
PROD_VOL="$PROJECT-production"
PACKAGE_VOL="$PROJECT-packages"
RESTORE_VOL="$PROJECT-restore"
PROD_CONTAINER="$PROJECT-prod"
RESTORED_CONTAINER="$PROJECT-restored"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sh-dr-docker-XXXXXX")
OWNER=$(realpath "$WORK")

cleanup() {
  docker rm -f "$PROD_CONTAINER" "$RESTORED_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$PROD_VOL" "$PACKAGE_VOL" "$RESTORE_VOL" >/dev/null 2>&1 || true
  if [[ -d "$WORK" ]]; then
    CURRENT=$(realpath "$WORK")
    if [[ "$CURRENT" == "$OWNER" ]]; then
      rm -rf -- "$WORK"
    else
      echo "BLOCKED: owned Docker work path changed: $WORK" >&2
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$EVIDENCE" "$WORK/home"
printf '%s\n' 'synthetic Docker platform passphrase 灾备' > "$WORK/passphrase"
chmod 600 "$WORK/passphrase"
docker network create "$NET" >/dev/null
for volume in "$PROD_VOL" "$PACKAGE_VOL" "$RESTORE_VOL"; do docker volume create "$volume" >/dev/null; done
docker run --rm --user 0 --entrypoint chown \
  -v "$PROD_VOL:/data" -v "$PACKAGE_VOL:/packages" -v "$RESTORE_VOL:/restore" \
  "$IMAGE" -R 1001:1001 /data /packages /restore >/dev/null

docker run -d --name "$PROD_CONTAINER" --network "$NET" --user 1001:1001 \
  --read-only --tmpfs /tmp:rw,nosuid,noexec,size=512m \
  -p 127.0.0.1::8787 -v "$PROD_VOL:/app/data" "$IMAGE" >/dev/null
SOURCE_PORT=$(docker port "$PROD_CONTAINER" 8787/tcp | sed 's/.*://')
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$SOURCE_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$SOURCE_PORT/api/health" > "$EVIDENCE/source-health.json"
mkdir -p "$WORK/source-data"
docker cp "$PROD_CONTAINER:/app/data/setup-token" "$WORK/source-data/setup-token" >/dev/null
node "$ROOT/tests/disaster-recovery/api-fixture.mjs" seed "http://127.0.0.1:$SOURCE_PORT" "$WORK/source-data" "$WORK/fixture.json" | tee "$EVIDENCE/seed.json"
docker stop "$PROD_CONTAINER" >/dev/null

volume_hashes() {
  local volume=$1
  docker run --rm --user 1001 --read-only --entrypoint sh -v "$volume:/data:ro" "$IMAGE" \
    -c 'find /data -type f -print0 | sort -z | xargs -0 sha256sum' | sed 's#/data/##' | sort
}
volume_hashes "$PROD_VOL" > "$WORK/production-before.sha256"

docker run -i --rm --network none --user 1001:1001 --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=2g \
  -v "$CLI:/usr/local/bin/shub:ro" -v "$WORK/passphrase:/run/secrets/passphrase:ro" \
  -v "$PROD_VOL:/data:rw" -v "$PACKAGE_VOL:/packages:rw" \
  -e HOME=/tmp -e SEARCH_HUB_DATA_DIR=/data -e SEARCH_HUB_DB_PATH=/data/search-hub.db \
  -e SEARCH_HUB_INSTALL_DIR=/app -e SEARCH_HUB_MIGRATIONS_DIR=/app/apps/api/migrations \
  -e SEARCH_HUB_APP_ENTRY=/app/apps/api/dist/server.mjs \
  "$IMAGE" /usr/local/bin/shub backup create --data-dir /data --output /packages/backup.shbackup \
  --passphrase-stdin --json < "$WORK/passphrase" | tee "$EVIDENCE/create.json"

docker run -i --rm --network none --user 1001:1001 --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=2g \
  -v "$CLI:/usr/local/bin/shub:ro" -v "$WORK/passphrase:/run/secrets/passphrase:ro" \
  -v "$PACKAGE_VOL:/packages:rw" -v "$RESTORE_VOL:/restore:rw" \
  -e HOME=/tmp -e SEARCH_HUB_INSTALL_DIR=/app -e SEARCH_HUB_MIGRATIONS_DIR=/app/apps/api/migrations \
  "$IMAGE" /usr/local/bin/shub backup verify /packages/backup.shbackup --passphrase-stdin --json \
  < "$WORK/passphrase" | tee "$EVIDENCE/verify.json"

docker run -i --rm --network none --user 1001:1001 --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=2g \
  -v "$CLI:/usr/local/bin/shub:ro" -v "$WORK/passphrase:/run/secrets/passphrase:ro" \
  -v "$PACKAGE_VOL:/packages:rw" -v "$RESTORE_VOL:/restore:rw" \
  -e HOME=/tmp -e SEARCH_HUB_DATA_DIR=/data -e SEARCH_HUB_INSTALL_DIR=/app -e SEARCH_HUB_MIGRATIONS_DIR=/app/apps/api/migrations \
  "$IMAGE" /usr/local/bin/shub backup restore /packages/backup.shbackup --data-dir /restore/target \
  --passphrase-stdin --json < "$WORK/passphrase" | tee "$EVIDENCE/dry-run.json"
DRY_FILES=$(docker run --rm --user 1001 --entrypoint sh -v "$RESTORE_VOL:/restore:ro" "$IMAGE" -c 'find /restore -mindepth 1 -print | wc -l')
[[ "$DRY_FILES" == "0" ]]

docker run -i --rm --network none --user 1001:1001 --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=2g \
  -v "$CLI:/usr/local/bin/shub:ro" -v "$WORK/passphrase:/run/secrets/passphrase:ro" \
  -v "$PACKAGE_VOL:/packages:rw" -v "$RESTORE_VOL:/restore:rw" \
  -e HOME=/tmp -e SEARCH_HUB_DATA_DIR=/data -e SEARCH_HUB_INSTALL_DIR=/app -e SEARCH_HUB_MIGRATIONS_DIR=/app/apps/api/migrations \
  -e SEARCH_HUB_APP_ENTRY=/app/apps/api/dist/server.mjs -e SEARCH_HUB_START_CHECK_NODE=/usr/local/bin/node \
  "$IMAGE" /usr/local/bin/shub backup restore /packages/backup.shbackup --data-dir /restore/target \
  --apply --start-check --passphrase-stdin --json < "$WORK/passphrase" | tee "$EVIDENCE/apply.json"

volume_hashes "$RESTORE_VOL" > "$EVIDENCE/restored-volume.sha256"

docker run -d --name "$RESTORED_CONTAINER" --network "$NET" --user 1001:1001 \
  --read-only --tmpfs /tmp:rw,nosuid,noexec,size=512m \
  -p 127.0.0.1::8787 -v "$RESTORE_VOL:/app/data" \
  -e SEARCH_HUB_DATA_DIR=/app/data/target -e SEARCH_HUB_DB_PATH=/app/data/target/search-hub.db \
  "$IMAGE" >/dev/null
RESTORED_PORT=$(docker port "$RESTORED_CONTAINER" 8787/tcp | sed 's/.*://')
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$RESTORED_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$RESTORED_PORT/api/health" | tee "$EVIDENCE/health.json"
node "$ROOT/tests/disaster-recovery/api-fixture.mjs" verify "http://127.0.0.1:$RESTORED_PORT" "$WORK/restored" "$WORK/fixture.json" | tee "$EVIDENCE/restored-verify.json"
docker stop "$RESTORED_CONTAINER" >/dev/null
volume_hashes "$PROD_VOL" > "$WORK/production-after.sha256"
cmp "$WORK/production-before.sha256" "$WORK/production-after.sha256"
cp "$WORK/production-before.sha256" "$EVIDENCE/production-volume-unchanged.sha256"
volume_hashes "$RESTORE_VOL" > "$WORK/restore-before-repeat.sha256"
set +e
docker run -i --rm --network none --user 1001:1001 --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=2g \
  -v "$CLI:/usr/local/bin/shub:ro" -v "$WORK/passphrase:/run/secrets/passphrase:ro" \
  -v "$PACKAGE_VOL:/packages:rw" -v "$RESTORE_VOL:/restore:rw" \
  -e HOME=/tmp -e SEARCH_HUB_DATA_DIR=/data -e SEARCH_HUB_INSTALL_DIR=/app -e SEARCH_HUB_MIGRATIONS_DIR=/app/apps/api/migrations \
  "$IMAGE" /usr/local/bin/shub backup restore /packages/backup.shbackup --data-dir /restore/target \
  --apply --passphrase-stdin --json < "$WORK/passphrase" > "$EVIDENCE/repeat-restore.json" 2>&1
REPEAT_CODE=$?
set -e
[[ "$REPEAT_CODE" != "0" ]]
volume_hashes "$RESTORE_VOL" > "$WORK/restore-after-repeat.sha256"
cmp "$WORK/restore-before-repeat.sha256" "$WORK/restore-after-repeat.sha256"
node "$ROOT/tests/disaster-recovery/write-platform-report.mjs" \
  --evidence-dir "$EVIDENCE" --kind search-hub-platform-docker --verdict PASS \
  --statuses '{"R02":"PASS","R12":"PASS","R13":"PASS","R14":"PASS","R17":"PASS","R18":"PASS","R19":"PASS","R21":"PASS","R28":"PASS","R30":"PASS","R38":"PASS"}' \
  --evidence-map '{"R02":["create.json","restored-verify.json"],"R12":["restored-verify.json"],"R13":["restored-verify.json"],"R14":["restored-verify.json"],"R17":["restored-verify.json"],"R18":["restored-verify.json"],"R19":["create.json","verify.json","apply.json"],"R21":["repeat-restore.json"],"R28":["production-volume-unchanged.sha256","restored-volume.sha256","health.json"],"R30":["health.json","restored-verify.json"],"R38":["repeat-restore.json"]}'
echo "PASS: Docker packaged DR drill evidence=$EVIDENCE"
