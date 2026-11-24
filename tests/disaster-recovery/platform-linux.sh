#!/usr/bin/env bash
# Isolated Linux x64/arm64 packaged disaster-recovery drill.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
PACKAGE_ROOT=${1:?usage: platform-linux.sh <extracted-server-package> <packaged-shub> [evidence-dir]}
CLI=${2:?packaged shub path is required}
EVIDENCE=${3:-"$ROOT/artifacts/disaster-recovery/platform-linux-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sh-dr-linux-XXXXXX")
OWNER=$(realpath "$WORK")
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -d "$WORK" ]]; then
    CURRENT=$(realpath "$WORK")
    if [[ "$CURRENT" == "$OWNER" ]]; then
      rm -rf -- "$WORK"
    else
      echo "BLOCKED: owned Linux work path changed: $WORK" >&2
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$EVIDENCE" "$WORK/source-data" "$WORK/home"
PASS="$WORK/passphrase"
printf '%s\n' 'synthetic Linux platform passphrase 灾备' > "$PASS"
chmod 600 "$PASS"
RUNTIME="$PACKAGE_ROOT/runtime/bin/node"
APP_ROOT="$PACKAGE_ROOT"
[[ -f "$PACKAGE_ROOT/app/apps/api/dist/server.mjs" ]] && APP_ROOT="$PACKAGE_ROOT/app"
SERVER="$APP_ROOT/apps/api/dist/server.mjs"
MIGRATIONS="$APP_ROOT/packages/db/migrations"
[[ -x "$RUNTIME" && -f "$SERVER" && -d "$MIGRATIONS" && -x "$CLI" ]]

pick_port() {
  "$RUNTIME" -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

start_server() {
  local data=$1 port=$2 log=$3
  (cd "$PACKAGE_ROOT" && exec env \
    SEARCH_HUB_DATA_DIR="$data" \
    SEARCH_HUB_DB_PATH="$data/search-hub.db" \
    SEARCH_HUB_PORT="$port" SEARCH_HUB_HOST=127.0.0.1 \
    SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT" SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" \
    SEARCH_HUB_ENCRYPTION_KEY="" SEARCH_HUB_LOG_LEVEL=info \
    "$RUNTIME" "$SERVER") >"$log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then cat "$log" >&2; return 1; fi
    sleep 1
  done
  cat "$log" >&2
  return 1
}

stop_server() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID"
    wait "$SERVER_PID" || true
  fi
  SERVER_PID=""
}

SOURCE_PORT=$(pick_port)
start_server "$WORK/source-data" "$SOURCE_PORT" "$EVIDENCE/source-server.log"
"$RUNTIME" "$ROOT/tests/disaster-recovery/api-fixture.mjs" seed "http://127.0.0.1:$SOURCE_PORT" "$WORK/source-data" "$WORK/fixture.json" | tee "$EVIDENCE/seed.json"
stop_server

PACKAGE="$WORK/backup.shbackup"
printf '%s\n' 'synthetic Linux platform passphrase 灾备' | \
  env -i HOME="$WORK/home" PATH=/nonexistent \
  SEARCH_HUB_DATA_DIR="$WORK/source-data" SEARCH_HUB_DB_PATH="$WORK/source-data/search-hub.db" \
  SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT" SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" SEARCH_HUB_APP_ENTRY="$SERVER" \
  "$CLI" backup create --data-dir "$WORK/source-data" --output "$PACKAGE" --passphrase-stdin --json \
  | tee "$EVIDENCE/create.json"
printf '%s\n' 'synthetic Linux platform passphrase 灾备' | \
  env -i HOME="$WORK/home" PATH=/nonexistent SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT" SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" \
  "$CLI" backup verify "$PACKAGE" --passphrase-stdin --json | tee "$EVIDENCE/verify.json"

DRY="$WORK/restored-dry"
printf '%s\n' 'synthetic Linux platform passphrase 灾备' | \
  env -i HOME="$WORK/home" PATH=/nonexistent SEARCH_HUB_DATA_DIR="$WORK/source-data" SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT" SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" \
  "$CLI" backup restore "$PACKAGE" --data-dir "$DRY" --passphrase-stdin --json \
  | tee "$EVIDENCE/dry-run.json"
[[ ! -e "$DRY" ]]

RESTORED="$WORK/restored"
printf '%s\n' 'synthetic Linux platform passphrase 灾备' | \
  env -i HOME="$WORK/home" PATH=/nonexistent SEARCH_HUB_DATA_DIR="$WORK/source-data" SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT" SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" \
  SEARCH_HUB_APP_ENTRY="$SERVER" \
  "$CLI" backup restore "$PACKAGE" --data-dir "$RESTORED" --apply --start-check --passphrase-stdin --json \
  | tee "$EVIDENCE/apply.json"

RESTORED_PORT=$(pick_port)
start_server "$RESTORED" "$RESTORED_PORT" "$EVIDENCE/restored-server.log"
curl -fsS "http://127.0.0.1:$RESTORED_PORT/api/health" | tee "$EVIDENCE/health.json"
"$RUNTIME" "$ROOT/tests/disaster-recovery/api-fixture.mjs" verify "http://127.0.0.1:$RESTORED_PORT" "$RESTORED" "$WORK/fixture.json" | tee "$EVIDENCE/restored-verify.json"
stop_server

[[ "$(stat -c '%a' "$RESTORED")" == "700" ]]
[[ "$(stat -c '%a' "$RESTORED/master.key")" == "600" ]]
[[ "$(stat -c '%a' "$PACKAGE")" == "600" ]]
BEFORE=$(sha256sum "$RESTORED/search-hub.db" | awk '{print $1}')
set +e
printf '%s\n' 'synthetic Linux platform passphrase 灾备' | \
  env -i HOME="$WORK/home" PATH=/nonexistent SEARCH_HUB_DATA_DIR="$WORK/source-data" SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT" SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" \
  "$CLI" backup restore "$PACKAGE" --data-dir "$RESTORED" --apply --passphrase-stdin --json \
  > "$EVIDENCE/repeat-restore.json" 2>&1
REPEAT_CODE=$?
set -e
[[ "$REPEAT_CODE" != "0" ]]
AFTER=$(sha256sum "$RESTORED/search-hub.db" | awk '{print $1}')
[[ "$BEFORE" == "$AFTER" ]]

{
  sha256sum "$WORK/source-data/search-hub.db" "$PACKAGE" "$RESTORED/search-hub.db"
  stat -c '%a %n' "$RESTORED" "$RESTORED/master.key" "$PACKAGE"
} > "$EVIDENCE/hashes-and-modes.txt"
"$RUNTIME" "$ROOT/tests/disaster-recovery/write-platform-report.mjs" \
  --evidence-dir "$EVIDENCE" --kind search-hub-platform-linux --verdict PASS \
  --statuses '{"R02":"PASS","R12":"PASS","R13":"PASS","R14":"PASS","R17":"PASS","R18":"PASS","R19":"PASS","R21":"PASS","R27":"PASS","R30":"PASS","R38":"PASS"}' \
  --evidence-map '{"R02":["create.json","restored-verify.json"],"R12":["restored-verify.json"],"R13":["restored-verify.json"],"R14":["restored-verify.json"],"R17":["restored-verify.json"],"R18":["restored-verify.json"],"R19":["create.json","verify.json","apply.json"],"R21":["repeat-restore.json"],"R27":["hashes-and-modes.txt"],"R30":["health.json","restored-verify.json"],"R38":["repeat-restore.json"]}'
echo "PASS: Linux packaged DR drill evidence=$EVIDENCE"
