#!/usr/bin/env bash
# Disposable real-systemd disaster-recovery and updater drill.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
PACKAGE_ROOT=${1:?usage: platform-systemd.sh <extracted-server-package> <packaged-shub> <candidate-v0.1.15-archive> [evidence-dir]}
CLI=${2:?packaged shub path is required}
CANDIDATE=${3:?v0.1.15 candidate archive is required}
EVIDENCE=${4:-"$ROOT/artifacts/disaster-recovery/platform-systemd-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
[[ "$(ps -p 1 -o comm=)" == "systemd" ]] || { echo "BLOCKED: PID 1 is not systemd" >&2; exit 75; }
[[ "$(id -u)" == "0" ]] || { echo "BLOCKED: disposable systemd drill requires root" >&2; exit 75; }
RUN="sh-v0115-$$"
BASE="/opt/search-hub-$RUN"
DATA="/var/lib/$RUN-source"
RESTORED="/var/lib/$RUN-restored"
SOURCE_UNIT="$RUN-source"
RESTORED_UNIT="$RUN-restored"
WORK=$(mktemp -d /tmp/sh-dr-systemd-XXXXXX)
OWNER=$(realpath "$WORK")
RUNTIME="$PACKAGE_ROOT/runtime/bin/node"
APP_ROOT="$PACKAGE_ROOT"
[[ -f "$PACKAGE_ROOT/app/apps/api/dist/server.mjs" ]] && APP_ROOT="$PACKAGE_ROOT/app"
SERVER="$APP_ROOT/apps/api/dist/server.mjs"
MIGRATIONS="$APP_ROOT/packages/db/migrations"
PASS="$WORK/passphrase"
PACKAGE="$WORK/backup.shbackup"
FIXTURE="$WORK/fixture.json"

cleanup() {
  systemctl stop "$SOURCE_UNIT" "$RESTORED_UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$SOURCE_UNIT.service" "/etc/systemd/system/$RESTORED_UNIT.service"
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ -d "$WORK" ]]; then
    CURRENT=$(realpath "$WORK")
    if [[ "$CURRENT" == "$OWNER" ]]; then rm -rf -- "$WORK"; else echo "BLOCKED: owned systemd work path changed: $WORK" >&2; fi
  fi
}
trap cleanup EXIT

pick_port() { "$RUNTIME" -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'; }
wait_health() { local port=$1; for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
make_unit() {
  local unit=$1 data=$2 port=$3
  cat > "/etc/systemd/system/$unit.service" <<EOF
[Unit]
Description=Disposable Search Hub DR acceptance $unit
After=network.target
[Service]
User=search-hub
Group=search-hub
WorkingDirectory=$BASE
Environment=SEARCH_HUB_DATA_DIR=$data
Environment=SEARCH_HUB_DB_PATH=$data/search-hub.db
Environment=SEARCH_HUB_PORT=$port
Environment=SEARCH_HUB_HOST=127.0.0.1
Environment=SEARCH_HUB_MIGRATIONS_DIR=$MIGRATIONS
Environment=SEARCH_HUB_ENCRYPTION_KEY=
ExecStart=$RUNTIME $SERVER
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$data
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
}

mkdir -p "$EVIDENCE"
printf '%s\n' 'synthetic systemd platform passphrase 灾备' > "$PASS"; chmod 600 "$PASS"
id search-hub >/dev/null 2>&1 || useradd --system --home /var/lib/search-hub --shell /usr/sbin/nologin search-hub
cp -a "$PACKAGE_ROOT" "$BASE"
install -d -o search-hub -g search-hub -m 0700 "$DATA" "$RESTORED"
PORT=$(pick_port); RESTORED_PORT=$(pick_port)
make_unit "$SOURCE_UNIT" "$DATA" "$PORT"
make_unit "$RESTORED_UNIT" "$RESTORED" "$RESTORED_PORT"
systemctl daemon-reload
systemctl start "$SOURCE_UNIT"
wait_health "$PORT"
"$RUNTIME" "$ROOT/tests/disaster-recovery/api-fixture.mjs" seed "http://127.0.0.1:$PORT" "$DATA" "$FIXTURE" | tee "$EVIDENCE/seed.json"
systemctl stop "$SOURCE_UNIT"
export SEARCH_HUB_INSTALL_DIR="$BASE"

SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" "$CLI" backup create --data-dir "$DATA" --output "$PACKAGE" --passphrase-stdin --json < "$PASS" | tee "$EVIDENCE/create.json"
SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" "$CLI" backup verify "$PACKAGE" --passphrase-stdin --json < "$PASS" | tee "$EVIDENCE/verify.json"
SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" "$CLI" backup restore "$PACKAGE" --data-dir "$RESTORED" --passphrase-stdin --json < "$PASS" | tee "$EVIDENCE/dry-run.json"
[[ -z "$(find "$RESTORED" -mindepth 1 -print -quit)" ]]
SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" SEARCH_HUB_APP_ENTRY="$SERVER" "$CLI" backup restore "$PACKAGE" --data-dir "$RESTORED" --apply --start-check --passphrase-stdin --json < "$PASS" | tee "$EVIDENCE/apply.json"
systemctl start "$RESTORED_UNIT"
wait_health "$RESTORED_PORT"
curl -fsS "http://127.0.0.1:$RESTORED_PORT/api/health" | tee "$EVIDENCE/health.json"
"$RUNTIME" "$ROOT/tests/disaster-recovery/api-fixture.mjs" verify "http://127.0.0.1:$RESTORED_PORT" "$RESTORED" "$FIXTURE" | tee "$EVIDENCE/restored-verify.json"
systemctl stop "$RESTORED_UNIT"

BEFORE=$(sha256sum "$RESTORED/search-hub.db" | awk '{print $1}')
set +e
SEARCH_HUB_MIGRATIONS_DIR="$MIGRATIONS" "$CLI" backup restore "$PACKAGE" --data-dir "$RESTORED" --apply --passphrase-stdin --json < "$PASS" > "$EVIDENCE/repeat-restore.json" 2>&1
REPEAT_CODE=$?
set -e
[[ "$REPEAT_CODE" != "0" ]]
[[ "$BEFORE" == "$(sha256sum "$RESTORED/search-hub.db" | awk '{print $1}')" ]]

BROKEN_ROOT="$WORK/broken"
mkdir -p "$BROKEN_ROOT/app/apps/api/dist"
printf 'import { createServer } from "node:http";\nsetTimeout(() => {}, 600000);\n' > "$BROKEN_ROOT/app/apps/api/dist/server.mjs"
printf '0.1.16\n' > "$BROKEN_ROOT/app/apps/api/dist/version.txt"
BROKEN_PKG="$WORK/search-hub-v0.1.16-linux-x64.tar.gz"
tar -czf "$BROKEN_PKG" -C "$BROKEN_ROOT" app
SHA=$(sha256sum "$BROKEN_PKG" | awk '{print $1}'); SIZE=$(stat -c%s "$BROKEN_PKG")
set +e
SEARCH_HUB_SYSTEMD_UNIT="$SOURCE_UNIT" "$BASE/bin/update" --package "$BROKEN_PKG" --version 0.1.16 --sha256 "$SHA" --size "$SIZE" --root "$BASE" --data "$DATA" --db-path "$DATA/search-hub.db" --port "$PORT" > "$EVIDENCE/updater-rollback.log" 2>&1
ROLLBACK_CODE=$?
set -e
[[ "$ROLLBACK_CODE" == "3" ]]
systemctl start "$SOURCE_UNIT"
wait_health "$PORT"
"$RUNTIME" "$ROOT/tests/disaster-recovery/api-fixture.mjs" verify "http://127.0.0.1:$PORT" "$DATA" "$FIXTURE" | tee "$EVIDENCE/rollback-verify.json"
[[ ! -e "$DATA/search-hub.db-wal" && ! -e "$DATA/search-hub.db-shm" ]]
stat -c '%a %U:%G %n' "$DATA" "$RESTORED" "$RESTORED/master.key" > "$EVIDENCE/modes.txt"
systemctl stop "$SOURCE_UNIT"

"$RUNTIME" "$ROOT/packaging/launcher/updater-test.mjs" > "$EVIDENCE/updater-test.log" 2>&1
"$RUNTIME" "$ROOT/packaging/launcher/updater-faults.mjs" > "$EVIDENCE/updater-faults.log" 2>&1
"$RUNTIME" "$ROOT/packaging/upgrade-matrix.mjs" --from v0.1.14 --to "$CANDIDATE" > "$EVIDENCE/upgrade-matrix.log" 2>&1

"$RUNTIME" "$ROOT/tests/disaster-recovery/write-platform-report.mjs" \
  --evidence-dir "$EVIDENCE" --kind search-hub-platform-systemd --verdict PASS \
  --statuses '{"R02":"PASS","R12":"PASS","R13":"PASS","R14":"PASS","R17":"PASS","R18":"PASS","R19":"PASS","R21":"PASS","R29":"PASS","R30":"PASS","R31":"PASS","R32":"PASS","R33":"PASS","R38":"PASS"}' \
  --evidence-map '{"R02":["create.json","restored-verify.json"],"R12":["restored-verify.json","rollback-verify.json"],"R13":["restored-verify.json"],"R14":["restored-verify.json"],"R17":["restored-verify.json"],"R18":["restored-verify.json"],"R19":["create.json","verify.json","apply.json"],"R21":["repeat-restore.json"],"R29":["health.json","modes.txt"],"R30":["health.json","restored-verify.json"],"R31":["upgrade-matrix.log"],"R32":["updater-rollback.log","updater-faults.log"],"R33":["rollback-verify.json"],"R38":["repeat-restore.json"]}'
echo "PASS: systemd packaged DR drill evidence=$EVIDENCE"
