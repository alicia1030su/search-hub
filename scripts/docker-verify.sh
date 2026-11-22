#!/usr/bin/env bash
# Search Hub — Docker production verification (10 acceptance items).
#
# One command; host prerequisites are Docker + bash + curl (+ sed/awk/grep).
# It never touches an existing deployment: it uses its own image tag, a
# throw-away compose project name and a namespaced volume, and removes both on
# exit (also on failure).
#
#   bash scripts/docker-verify.sh
#
# Environment (all optional):
#   SEARCH_HUB_VERIFY_SKIP_BUILD=1          reuse an existing image (CI builds with cache)
#   SEARCH_HUB_VERIFY_IMAGE=tag             image tag (default search-hub:verify)
#   SEARCH_HUB_VERIFY_PROJECT=name          compose project (default shverify-<timestamp>)
#   SEARCH_HUB_VERIFY_PORT=n                host port (default: first free from 18100)
#   SEARCH_HUB_VERIFY_ALLOW_SKIP_NETWORK=1  downgrade the live-network item to SKIP (never in CI)
#   SEARCH_HUB_VERIFY_REQUIRE_SCAN=1        fail when no vulnerability scanner exists
#   SEARCH_HUB_VERIFY_MAX_HIGH / _MAX_CRITICAL   tolerated HIGH/CRITICAL counts (default 0)
#   TRIVY_IGNORE_UNFIXED=0                  count unfixed CVEs as well (default 1: actionable only)
#   SEARCH_HUB_VERIFY_LOAD_SEARCHES=n       load-test searches in item 8 (default 50)
#   SEARCH_HUB_VERIFY_PROXY=url             run the stack behind an egress proxy
#   SEARCH_HUB_VERIFY_NO_PROXY=list         proxy bypass list (with _PROXY)
#   SEARCH_HUB_VERIFY_PROXY_TRUST=level     untrusted | trusted-networks
#     By default the stack runs in DIRECT mode even if the shell exports a proxy:
#     the verification result must not depend on the caller's egress setup.
#   SEARCH_HUB_VERIFY_REPORT_DIR=dir        where log/results/json artifacts are written
#   SEARCH_HUB_VERIFY_KEEP=1                leave the stack running for inspection (CI cleans up itself)
#
# Exit code 0 only when every executed item PASSED. SKIP is always printed with
# its reason and never counts as a pass.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || { printf 'FAIL: cannot cd to %s\n' "$ROOT"; exit 1; }

IMAGE=${SEARCH_HUB_VERIFY_IMAGE:-search-hub:verify}
PROJECT=${SEARCH_HUB_VERIFY_PROJECT:-shverify-$(date +%Y%m%d%H%M%S)}
CONTAINER="${PROJECT}-app"
NETWORK_STRICT=1
[ "${SEARCH_HUB_VERIFY_ALLOW_SKIP_NETWORK:-0}" = "1" ] && NETWORK_STRICT=0
REQUIRE_SCAN=${SEARCH_HUB_VERIFY_REQUIRE_SCAN:-0}
MAX_HIGH=${SEARCH_HUB_VERIFY_MAX_HIGH:-0}
MAX_CRITICAL=${SEARCH_HUB_VERIFY_MAX_CRITICAL:-0}
TRIVY_IGNORE_UNFIXED=${TRIVY_IGNORE_UNFIXED:-1}
# Number of load-test searches in item 8 (lower it for a quick smoke run).
LOAD_SEARCHES=${SEARCH_HUB_VERIFY_LOAD_SEARCHES:-50}

STAMP=$(date +%Y%m%d%H%M%S)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sh-verify-XXXXXX")
# Artifacts outlive the run; scratch files (cookie jar, response bodies) do not.
REPORT_DIR=${SEARCH_HUB_VERIFY_REPORT_DIR:-${TMPDIR:-/tmp}/search-hub-docker-verify}
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/docker-verify-$STAMP.log"
RESULTS_FILE="$REPORT_DIR/docker-verify-$STAMP.results"
: > "$REPORT"; : > "$RESULTS_FILE"

FAILURES=0
ITEMS_RUN=0
ITEMS_SKIP=0
BUILT_HERE=0
PORT=""
ENC_KEY=""
BASE=""

# ---------------------------------------------------------------- utilities
log()  { printf '%s\n' "$*" | tee -a "$REPORT"; }
line() { log "------------------------------------------------------------"; }

record() { # record <PASS|FAIL|SKIP> <item> <detail>
  local status=$1 item=$2 detail=${3:-}
  printf '%s\t%s\t%s\n' "$status" "$item" "$detail" >> "$RESULTS_FILE"
  ITEMS_RUN=$((ITEMS_RUN + 1))
  case "$status" in
    PASS) log "PASS  $item  $detail" ;;
    SKIP) ITEMS_SKIP=$((ITEMS_SKIP + 1)); log "SKIP  $item  $detail" ;;
    FAIL) FAILURES=$((FAILURES + 1)); log "FAIL  $item  $detail" ;;
  esac
}

hex32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

compose() {
  env \
    SEARCH_HUB_IMAGE="$IMAGE" \
    SEARCH_HUB_CONTAINER_NAME="$CONTAINER" \
    SEARCH_HUB_HOST_PORT="${PORT:-18787}" \
    SEARCH_HUB_ENCRYPTION_KEY="${ENC_KEY:-}" \
    SEARCH_HUB_SETUP_TOKEN="" \
    SEARCH_HUB_ALLOWED_HOSTS="" \
    SEARCH_HUB_PUBLIC_URL="" \
    SEARCH_HUB_COOKIE_SECURE="false" \
    SEARCH_HUB_TRUST_PROXY="false" \
    SEARCH_HUB_PROXY="${SEARCH_HUB_VERIFY_PROXY:-}" \
    SEARCH_HUB_NO_PROXY="${SEARCH_HUB_VERIFY_NO_PROXY:-}" \
    SEARCH_HUB_PROXY_TRUST="${SEARCH_HUB_VERIFY_PROXY_TRUST:-}" \
    docker compose -p "$PROJECT" --project-directory "$ROOT" -f "$ROOT/compose.yaml" "$@"
}

port_free() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && { exec 3<&-; return 1; } || return 0
}

pick_port() {
  local base=${1:-18100} offset
  for offset in $(seq 0 40); do
    if port_free $((base + offset)); then printf '%s' $((base + offset)); return 0; fi
  done
  return 1
}

wait_health() {
  local i code
  for i in $(seq 1 45); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/health" 2>/dev/null || true)
    if [ "$code" = "200" ]; then log "  /api/health 200 (${i}x2s)"; return 0; fi
    sleep 2
  done
  return 1
}

JSON_EVAL='
let raw="";
process.stdin.on("data",(c)=>raw+=c).on("end",()=>{
  try{
    const keys=process.argv[1].split(".");
    let cur=JSON.parse(raw);
    for(const key of keys){
      if(cur===null||cur===undefined){cur="";break}
      if(key==="length"&&Array.isArray(cur)){cur=cur.length;break}
      cur=cur[key];
    }
    process.stdout.write(String(cur===null||cur===undefined?"":cur));
  }catch(e){process.stdout.write("")}
});'

# Parses JSON with the host Node when present, otherwise with the container's
# Node. Keeps the script free of jq/python requirements.
jget() { # jget <file> <dot.path>
  local file=$1 path=$2
  if command -v node >/dev/null 2>&1; then
    node -e "$JSON_EVAL" "$path" < "$file" 2>/dev/null || printf ''
  elif [ -n "$CONTAINER" ] && docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker exec -i "$CONTAINER" node -e "$JSON_EVAL" "$path" < "$file" 2>/dev/null || printf ''
  else
    printf ''
  fi
}

cleanup() {
  [ "${CLEANED:-0}" = "1" ] && return 0
  CLEANED=1
  line
  if [ "${SEARCH_HUB_VERIFY_KEEP:-0}" = "1" ]; then
    log "cleanup skipped (SEARCH_HUB_VERIFY_KEEP=1): project $PROJECT left in place for inspection"
  else
    log "cleanup: removing compose project $PROJECT (container + volume + network)"
    compose down -v --remove-orphans >>"$REPORT" 2>&1 || true
    if [ "$BUILT_HERE" = "1" ]; then
      docker image rm -f "$IMAGE" >>"$REPORT" 2>&1 || true
    fi
  fi
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  log "artifacts kept in $REPORT_DIR"
  return 0
}
trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# ---------------------------------------------------------------- preflight
line
log "Search Hub — Docker production verification"
log "repo=$ROOT"
log "image=$IMAGE  project=$PROJECT  container=$CONTAINER"
log "report=$REPORT"

if ! command -v docker >/dev/null 2>&1; then
  record FAIL "0. toolchain" "docker CLI not found"
  log "RESULT: FAIL (no docker CLI)"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  record FAIL "0. toolchain" "docker daemon unreachable: $(docker info 2>&1 | tail -1)"
  log "RESULT: FAIL (daemon unreachable)"
  exit 1
fi
docker version --format 'client={{.Client.Version}} server={{.Server.Version}} api={{.Server.APIVersion}}' 2>&1 | tee -a "$REPORT"
docker compose version 2>&1 | tee -a "$REPORT"
record PASS "0a. toolchain" "docker daemon reachable"

if [ -n "${SEARCH_HUB_VERIFY_PORT:-}" ]; then
  PORT=$SEARCH_HUB_VERIFY_PORT
  if ! port_free "$PORT"; then
    record FAIL "0c. host port" "requested port $PORT is already in use"
    log "RESULT: FAIL (port busy)"
    exit 1
  fi
else
  PORT=$(pick_port 18100) || PORT=18100
fi
BASE="http://127.0.0.1:$PORT"
ENC_KEY=$(hex32)
COOKIES="$WORK/cookies.txt"
BODY="$WORK/body.json"
log "host port=$PORT (container port 8787)"

if compose config --quiet; then
  record PASS "0b. compose config" "docker compose config --quiet exit 0"
else
  record FAIL "0b. compose config" "invalid compose.yaml (see log)"
  log "RESULT: FAIL (compose config)"
  exit 1
fi

# ------------------------------------------------------------------ 1. build
line
log "=== item 1: image build ==="
if [ "${SEARCH_HUB_VERIFY_SKIP_BUILD:-0}" = "1" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "reusing pre-built image $IMAGE (SEARCH_HUB_VERIFY_SKIP_BUILD=1)"
  BUILD_OK=1
else
  BUILD_OK=0
  if docker build -t "$IMAGE" "$ROOT" 2>&1 | tee -a "$REPORT"; then BUILD_OK=1; BUILT_HERE=1; fi
fi
if [ "$BUILD_OK" = "1" ]; then
  SIZE=$(docker images --format '{{.Size}}' "$IMAGE" | head -1)
  IMG_ID=$(docker images --format '{{.ID}}' "$IMAGE" | head -1)
  record PASS "1. build" "image=$IMAGE id=$IMG_ID size=$SIZE"
else
  record FAIL "1. build" "docker build failed"
  log "RESULT: FAIL (build)"
  exit 1
fi

# --------------------------------------------------------------------- 2. up
line
log "=== item 2: compose up on a fresh named volume ==="
compose down -v --remove-orphans >>"$REPORT" 2>&1 || true
compose up -d --no-build >>"$REPORT" 2>&1 || true
CID=$(compose ps -q search-hub 2>/dev/null | head -1)
if [ -z "$CID" ]; then
  record FAIL "2. compose up" "no container id; see log"
  log "RESULT: FAIL (compose up)"
  exit 1
fi
if wait_health; then
  UID_IN=$(docker exec "$CONTAINER" id -u 2>/dev/null || echo "?")
  VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$CID" 2>/dev/null || echo "?")
  HC=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo "?")
  log "  container uid=$UID_IN volume=$VOL health=$HC"
  record PASS "2a. compose up" "container=${CID:0:12} health=$HC volume=$VOL"
  if [ "$UID_IN" = "1001" ]; then
    record PASS "2b. non-root" "process runs as uid 1001 (searchhub)"
  else
    record FAIL "2b. non-root" "container runs as uid $UID_IN (expected 1001)"
  fi
else
  record FAIL "2. compose up" "health never returned 200"
  docker logs "$CONTAINER" >>"$REPORT" 2>&1 || true
  log "RESULT: FAIL (health)"
  exit 1
fi

# --------------------------------------------------------------- 3. http front
line
log "=== item 3: web bundle + health endpoint ==="
ROOT_CODE=$(curl -s -o "$WORK/index.html" -w '%{http_code}' --max-time 10 "$BASE/")
ROOT_TYPE=$(curl -s -o /dev/null -w '%{content_type}' --max-time 10 "$BASE/")
HEALTH_CODE=$(curl -s -o "$WORK/health.json" -w '%{http_code}' --max-time 10 "$BASE/api/health")
log "  GET /            -> $ROOT_CODE ($ROOT_TYPE)"
log "  GET /api/health  -> $HEALTH_CODE $(cat "$WORK/health.json" 2>/dev/null | head -c 200)"
if [ "$ROOT_CODE" = "200" ] && grep -qi '<html' "$WORK/index.html" 2>/dev/null; then
  record PASS "3a. web bundle" "GET / = 200 $ROOT_TYPE with an HTML document"
else
  record FAIL "3a. web bundle" "GET / = $ROOT_CODE $ROOT_TYPE (static bundle missing?)"
fi
if [ "$HEALTH_CODE" = "200" ] && grep -q '"status":"ok"' "$WORK/health.json"; then
  STATUS_FLD=$(jget "$WORK/health.json" status)
  OUT_MODE=$(jget "$WORK/health.json" outbound.mode)
  OUT_TRUST=$(jget "$WORK/health.json" outbound.proxyTrust)
  OUT_DECL=$(jget "$WORK/health.json" outbound.proxyTrustDeclared)
  log "  outbound: mode=${OUT_MODE:-n/a} trust=${OUT_TRUST:-n/a} trustDeclared=${OUT_DECL:-n/a}"
  record PASS "3b. health" "GET /api/health = 200 status=$STATUS_FLD outbound.mode=${OUT_MODE:-n/a} trust=${OUT_TRUST:-n/a}"
else
  record FAIL "3b. health" "GET /api/health = $HEALTH_CODE"
fi

# -------------------------------------------------------------- 4. setup token
line
log "=== item 4: one-time setup token + /api/setup ==="
docker exec "$CONTAINER" cat /app/data/setup-token > "$WORK/token" 2>/dev/null || true
TOKEN_LEN=$(wc -c < "$WORK/token" 2>/dev/null | tr -d ' ')
MODE=$(docker exec "$CONTAINER" stat -c '%a' /app/data/setup-token 2>/dev/null || echo "?")
log "  /app/data/setup-token length=$TOKEN_LEN mode=$MODE (value never printed)"
if [ "${TOKEN_LEN:-0}" -ge 16 ]; then
  record PASS "4a. setup-token file" "length=$TOKEN_LEN mode=$MODE"
else
  record FAIL "4a. setup-token file" "missing or too short (length=$TOKEN_LEN)"
fi

SETUP_TOKEN=$(tr -d '\r\n' < "$WORK/token" 2>/dev/null)
ADMIN_PASS="Verify-Pass-$(hex32 | cut -c1-20)"
setup_code=$(curl -s -c "$COOKIES" -o "$BODY" -w '%{http_code}' --max-time 20 \
  -H 'content-type: application/json' \
  -d "{\"email\":\"verify@example.com\",\"password\":\"$ADMIN_PASS\",\"name\":\"Verify\",\"setupToken\":\"$SETUP_TOKEN\"}" \
  "$BASE/api/setup")
CSRF=$(grep -o '"csrfToken":"[^"]*"' "$BODY" | head -1 | cut -d'"' -f4)
log "  POST /api/setup -> $setup_code (csrf length=${#CSRF})"
if [ "$setup_code" = "200" ] && [ -n "$CSRF" ]; then
  record PASS "4b. setup" "POST /api/setup = 200, session cookie + csrf issued"
else
  record FAIL "4b. setup" "POST /api/setup = $setup_code"
fi
if docker exec "$CONTAINER" test -f /app/data/setup-token 2>/dev/null; then
  record FAIL "4c. token cleanup" "/app/data/setup-token still exists after initialization"
else
  record PASS "4c. token cleanup" "setup-token removed after the administrator was created"
fi

# -------------------------------------------- 5. live provider + real search
line
log "=== item 5: Hacker News provider (keyless) + a real network search ==="
prov_code=$(curl -s -b "$COOKIES" -o "$BODY" -w '%{http_code}' --max-time 20 \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"hn-live","type":"hackernews","enabled":true,"timeoutMs":15000,"resultsPerPage":10}' \
  "$BASE/api/admin/providers")
PRV_ID=$(grep -o '"provider":{"id":"[^"]*"' "$BODY" | head -1 | cut -d'"' -f6)
log "  POST /api/admin/providers -> $prov_code provider=${PRV_ID:-none}"
if [ "$prov_code" = "200" ] && [ -n "$PRV_ID" ]; then
  record PASS "5a. provider create" "type=hackernews id=$PRV_ID (no API key required)"
else
  record FAIL "5a. provider create" "returned $prov_code"
fi

# A deterministic local provider keeps the load measurement (item 8) off the
# vendor API; the live check below stays the only network dependency. Its RPM
# limit is raised so the provider scheduler never throttles the load test.
mock_code=$(curl -s -b "$COOKIES" -o "$BODY" -w '%{http_code}' --max-time 20 \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"mock-load","type":"mock","enabled":true,"rpmLimit":100000,"maxConcurrency":16,"config":{"resultCount":8,"latencyMs":5,"namespace":"load"}}' \
  "$BASE/api/admin/providers")
MOCK_ID=$(grep -o '"provider":{"id":"[^"]*"' "$BODY" | head -1 | cut -d'"' -f6)
log "  POST /api/admin/providers (mock) -> $mock_code provider=${MOCK_ID:-none}"

search_body() { # search_body <providers-json-array> <query>
  printf '{"query":"%s","providers":%s,"mode":"rrf","limit":5,"skipCache":true}' "$2" "$1"
}

SEARCH_OK=0
HIT_COUNT=0
STATUS=""
attempt=1
while [ $attempt -le 3 ]; do
  log "  live search attempt $attempt/3 against hn.algolia.com"
  code=$(curl -s -b "$COOKIES" -o "$BODY" -w '%{http_code}' --max-time 60 \
    -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
    -d "$(search_body "[\"$PRV_ID\"]" "typescript monorepo")" "$BASE/api/search")
  HIT_COUNT=$(jget "$BODY" results.length)
  STATUS=$(jget "$BODY" status)
  log "  POST /api/search -> $code status=${STATUS:-n/a} results=${HIT_COUNT:-0}"
  if [ "$code" = "200" ] && [ "${HIT_COUNT:-0}" -ge 1 ] 2>/dev/null; then SEARCH_OK=1; break; fi
  attempt=$((attempt + 1))
  [ $attempt -le 3 ] && sleep 5
done

if [ "$SEARCH_OK" = "1" ]; then
  FIRST_URL=$(grep -o '"url":"https\?://[^"]*"' "$BODY" | head -1 | cut -d'"' -f4)
  record PASS "5b. live search" "200, ${HIT_COUNT} real results (status=${STATUS}); first url=${FIRST_URL:-n/a}"
elif [ "$NETWORK_STRICT" = "1" ]; then
  cp "$BODY" "$REPORT_DIR/search-failure-$STAMP.json" 2>/dev/null || true
  record FAIL "5b. live search" "no non-empty 200 after 3 attempts; body saved as search-failure-$STAMP.json"
else
  record SKIP "5b. live search" "ALLOW_SKIP_NETWORK=1: outbound network unavailable, vendor call not proven"
fi


# ------------------------------------------- 5c. provider key encryption/mask
line
log "=== item 5c: a provider key is stored encrypted and only ever masked ==="
KEY_PLAIN="sk-VERIFY-FINGERPRINT-1234"
key_code=$(curl -s -b "$COOKIES" -o "$BODY" -w '%{http_code}' --max-time 20 \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d "{\"label\":\"verify-key\",\"key\":\"$KEY_PLAIN\",\"weight\":100,\"enabled\":true}" \
  "$BASE/api/admin/providers/$PRV_ID/keys")
KEY_MASK=$(jget "$BODY" maskedKey)
log "  POST /api/admin/providers/{id}/keys -> $key_code maskedKey=${KEY_MASK:-none}"
if [ "$key_code" = "200" ] && [ -n "$KEY_MASK" ] && ! grep -q "$KEY_PLAIN" "$BODY"; then
  record PASS "5c. key mask" "create returned maskedKey=$KEY_MASK and no plaintext"
else
  record FAIL "5c. key mask" "status=$key_code maskedKey=${KEY_MASK:-none} (plaintext leak or missing mask)"
fi

# ------------------------------------------------- 6. restart -> consistency
line
log "=== item 6: docker compose restart keeps config, session and statistics ==="
PROV_BEFORE=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/providers" > "$WORK/prov1.json"; \
  grep -c '"name":"hn-live"' "$WORK/prov1.json" 2>/dev/null || true)
# The key was created in item 5c; its mask must survive the restart unchanged.
curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/providers/$PRV_ID/keys" > "$WORK/keys1.json" || true
KEY_BEFORE=$(jget "$WORK/keys1.json" 0.maskedKey)
SESS_BEFORE=$(curl -s -b "$COOKIES" -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/auth/session")
SEARCH_BEFORE=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/dashboard?range=24h" > "$WORK/dash1.json"; \
  jget "$WORK/dash1.json" totals.searches)
log "  before: hn-live entries=${PROV_BEFORE:-?} session=$SESS_BEFORE dashboard.searches=${SEARCH_BEFORE:-0}"

compose restart >>"$REPORT" 2>&1 || true
if wait_health; then
  PROV_AFTER=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/providers" > "$WORK/prov2.json"; \
    grep -c '"name":"hn-live"' "$WORK/prov2.json" 2>/dev/null || true)
  curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/providers/$PRV_ID/keys" > "$WORK/keys2.json" || true
  KEY_AFTER=$(jget "$WORK/keys2.json" 0.maskedKey)
  SESS_AFTER=$(curl -s -b "$COOKIES" -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/auth/session")
  SEARCH_AFTER=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/dashboard?range=24h" > "$WORK/dash2.json"; \
    jget "$WORK/dash2.json" totals.searches)
  log "  after:  hn-live entries=${PROV_AFTER:-?} session=$SESS_AFTER dashboard.searches=${SEARCH_AFTER:-0}"
  if [ "$PROV_AFTER" = "$PROV_BEFORE" ] && [ "${SEARCH_AFTER:-x}" = "${SEARCH_BEFORE:-y}" ] \
     && [ "$SESS_AFTER" = "200" ] && [ -n "$KEY_AFTER" ] && [ "$KEY_AFTER" = "$KEY_BEFORE" ]; then
    record PASS "6. restart consistency" "providers=${PROV_AFTER} searches=${SEARCH_AFTER} key=${KEY_AFTER} session=200 (unchanged)"
  else
    record FAIL "6. restart consistency" "providers ${PROV_BEFORE:-?}->${PROV_AFTER:-?} searches ${SEARCH_BEFORE:-0}->${SEARCH_AFTER:-0} key ${KEY_BEFORE:-none}->${KEY_AFTER:-none} session=$SESS_AFTER"
  fi
else
  record FAIL "6. restart consistency" "health did not recover after restart"
fi

# ------------------------------------------------------------- 7. persistence
line
log "=== item 7: compose down (volume kept) -> compose up, data still present ==="
PROV_BEFORE=${PROV_AFTER:-0}

# Warm the persistent cache before the container is destroyed. The check after
# `up` only proves something if there was an entry to survive — and only a
# completed response is cached, so the probe must run against the deterministic
# mock source alone. Mixing in the live source would make the response partial
# (and therefore correctly uncached) whenever the vendor is slow.
CACHE_QUERY="cache-persistence-${STAMP}"
CACHE_TARGET_JSON="[\"$MOCK_ID\"]"
if [ -z "$MOCK_ID" ]; then
  log "  WARN: no mock provider, the cache persistence probe cannot run deterministically"
fi
cache_on_code=$(curl -s -b "$COOKIES" -o /dev/null -w '%{http_code}' --max-time 15 \
  -X PUT \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"cache":{"enabled":true,"ttlSeconds":86400}}' "$BASE/api/admin/settings")
curl -s -b "$COOKIES" -o "$WORK/cache-warm.json" --max-time 30 \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d "$(printf '{"query":"%s","providers":%s,"mode":"rrf","limit":5}' "$CACHE_QUERY" "$CACHE_TARGET_JSON")" \
  "$BASE/api/search" || true
CACHE_WARM_STATUS=$(jget "$WORK/cache-warm.json" status)
CACHE_ENTRIES_BEFORE=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/cache" > "$WORK/cache1.json"; \
  jget "$WORK/cache1.json" entries)

# Health state and the probe budget must survive too: both are rows in the same
# database, so a container that loses them has lost more than a cache.
#
# The deterministic mock adapter deliberately issues no physical request. Since
# v0.1.11 refunds a provably unused reservation, it cannot prove budget
# persistence. Use a dedicated keyless Hacker News provider for a real HTTP
# probe, and disable the background scheduler so no unrelated tick can move the
# baseline between the two reads.
curl -s -b "$COOKIES" -o "$WORK/health-policy.json" --max-time 15 \
  -X PUT -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"scheduledEnabled":false}' "$BASE/api/admin/provider-health/settings" || true
health_probe_create=$(curl -s -b "$COOKIES" -o "$BODY" -w '%{http_code}' --max-time 20 \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"hn-health-probe","type":"hackernews","enabled":true,"timeoutMs":15000,"resultsPerPage":1}' \
  "$BASE/api/admin/providers")
HEALTH_PROBE_ID=$(jget "$BODY" provider.id)
PROBE_HTTP=""
PROBE_STATUS=""
PROBE_CAUSE=""
PROBE_REQUESTS=0
PROBE_CHECKED_AT=""
if [ "$health_probe_create" = "200" ] && [ -n "$HEALTH_PROBE_ID" ]; then
  for attempt in 1 2 3; do
    PROBE_HTTP=$(curl -s -b "$COOKIES" -o "$WORK/probe-before.json" -w '%{http_code}' --max-time 30 \
      -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
      -d '{"kind":"connect"}' "$BASE/api/admin/provider-health/$HEALTH_PROBE_ID/probe" || true)
    PROBE_STATUS=$(jget "$WORK/probe-before.json" result.status)
    PROBE_CAUSE=$(jget "$WORK/probe-before.json" result.cause)
    PROBE_REQUESTS=$(jget "$WORK/probe-before.json" result.requests)
    PROBE_CHECKED_AT=$(jget "$WORK/probe-before.json" result.checkedAt)
    PROBE_REQUESTS=${PROBE_REQUESTS:-0}
    if [ "$PROBE_HTTP" = "200" ] && [ "${PROBE_REQUESTS:-0}" -ge 1 ] 2>/dev/null; then break; fi
    [ "$attempt" -lt 3 ] && sleep 3
  done
fi
HEALTH_BEFORE=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/provider-health" > "$WORK/health1.json"; \
  jget "$WORK/health1.json" budget.connectUsedToday)
HEALTH_DAY_BEFORE=$(jget "$WORK/health1.json" budget.day)
log "  health: provider_create=$health_probe_create probe_http=${PROBE_HTTP:-none} status=${PROBE_STATUS:-none} cause=${PROBE_CAUSE:-none} requests=${PROBE_REQUESTS:-0} connect_probes_before=${HEALTH_BEFORE:-0} day=${HEALTH_DAY_BEFORE:-n/a}"
# The baseline is read *after* the warm-up search, because that search is itself
# one more task: comparing against a count taken before it would fail on the
# probe's own side effect rather than on persistence.
DASH_BEFORE=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/dashboard?range=24h" > "$WORK/dash-warm.json"; \
  jget "$WORK/dash-warm.json" totals.searches)
log "  cache: enable=$cache_on_code warm_status=${CACHE_WARM_STATUS:-none} entries_before_down=${CACHE_ENTRIES_BEFORE:-0} searches_before_down=${DASH_BEFORE:-0}"

compose down >>"$REPORT" 2>&1 || true
VOLUME_AFTER_DOWN=$(docker volume ls --format '{{.Name}}' | grep -c "^${PROJECT}_search-hub-data$" || true)
compose up -d --no-build >>"$REPORT" 2>&1 || true
if wait_health; then
  PROV_AFTER2=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/providers" > "$WORK/prov3.json"; \
    grep -c '"name":"hn-live"' "$WORK/prov3.json" 2>/dev/null || true)
  SEARCH_AFTER2=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/dashboard?range=24h" > "$WORK/dash3.json"; \
    jget "$WORK/dash3.json" totals.searches)
  SETUP_STATE=$(curl -s --max-time 15 "$BASE/api/setup/status" > "$WORK/setup2.json"; \
    jget "$WORK/setup2.json" initialized)
  # Replay the exact query: a container that was really recreated has no memory
  # of it, so a hit can only come from the volume.
  curl -s -b "$COOKIES" -o "$WORK/cache2.json" --max-time 30 \
    -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
    -d "$(printf '{"query":"%s","providers":%s,"mode":"rrf","limit":5}' "$CACHE_QUERY" "$CACHE_TARGET_JSON")" \
    "$BASE/api/search" || true
  CACHE_HIT=$(jget "$WORK/cache2.json" stats.cached)
  CACHE_ENTRIES_AFTER=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/cache" > "$WORK/cache2stats.json"; \
    jget "$WORK/cache2stats.json" entries)
  HEALTH_AFTER=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/provider-health" > "$WORK/health2.json"; \
    jget "$WORK/health2.json" budget.connectUsedToday)
  HEALTH_DAY_AFTER=$(jget "$WORK/health2.json" budget.day)
  HEALTH_CHECK_AFTER=""
  HEALTH_REQUESTS_AFTER=0
  if [ -n "$HEALTH_PROBE_ID" ]; then
    curl -s -b "$COOKIES" --max-time 15 \
      "$BASE/api/admin/provider-health/history?providerId=$HEALTH_PROBE_ID&limit=1" \
      > "$WORK/health-history-after.json" || true
    HEALTH_CHECK_AFTER=$(jget "$WORK/health-history-after.json" checks.0.checkedAt)
    HEALTH_REQUESTS_AFTER=$(jget "$WORK/health-history-after.json" checks.0.requests)
    HEALTH_REQUESTS_AFTER=${HEALTH_REQUESTS_AFTER:-0}
  fi
  log "  after down/up: volume survived=$VOLUME_AFTER_DOWN hn-live=${PROV_AFTER2:-?} searches=${SEARCH_AFTER2:-0} initialized=$SETUP_STATE cache_hit=${CACHE_HIT:-no} entries=${CACHE_ENTRIES_AFTER:-0}"
  log "  health after down/up: connect_probes=${HEALTH_AFTER:-0} day=${HEALTH_DAY_AFTER:-n/a} checked_at=${HEALTH_CHECK_AFTER:-none} requests=${HEALTH_REQUESTS_AFTER:-0}"
  if [ "${VOLUME_AFTER_DOWN:-0}" -ge 1 ] && [ "$PROV_AFTER2" = "$PROV_BEFORE" ] \
     && [ "${SEARCH_AFTER2:-x}" = "${DASH_BEFORE:-y}" ] && [ "$SETUP_STATE" = "true" ] \
     && [ "${CACHE_ENTRIES_BEFORE:-0}" -ge 1 ] \
     && [ "${CACHE_HIT:-false}" = "true" ] && [ "${CACHE_ENTRIES_AFTER:-0}" -ge 1 ] \
     && [ "$health_probe_create" = "200" ] && [ "$PROBE_HTTP" = "200" ] \
     && [ "${PROBE_REQUESTS:-0}" -ge 1 ] 2>/dev/null \
     && [ "${HEALTH_BEFORE:-0}" -ge 1 ] && [ "${HEALTH_AFTER:-0}" = "${HEALTH_BEFORE}" ] \
     && [ "$HEALTH_DAY_AFTER" = "$HEALTH_DAY_BEFORE" ] \
     && [ "$HEALTH_CHECK_AFTER" = "$PROBE_CHECKED_AT" ] \
     && [ "${HEALTH_REQUESTS_AFTER:-0}" = "${PROBE_REQUESTS:-0}" ]; then
    record PASS "7. persistence" "volume kept across down/up; providers=$PROV_AFTER2 searches=$SEARCH_AFTER2 initialized=true cache_entries=${CACHE_ENTRIES_BEFORE}->${CACHE_ENTRIES_AFTER} cache_hit=true connect_probes=${HEALTH_BEFORE}->${HEALTH_AFTER} probe_requests=${PROBE_REQUESTS} checked_at=${PROBE_CHECKED_AT}"
  else
    record FAIL "7. persistence" "volume=$VOLUME_AFTER_DOWN providers ${PROV_BEFORE:-?}->${PROV_AFTER2:-?} searches ${DASH_BEFORE:-0}->${SEARCH_AFTER2:-0} initialized=$SETUP_STATE warm_status=${CACHE_WARM_STATUS:-none} entries ${CACHE_ENTRIES_BEFORE:-0}->${CACHE_ENTRIES_AFTER:-0} cache_hit=${CACHE_HIT:-false} health_create=$health_probe_create probe_http=${PROBE_HTTP:-none} probe_requests=${PROBE_REQUESTS:-0} connect_probes ${HEALTH_BEFORE:-0}->${HEALTH_AFTER:-0} day ${HEALTH_DAY_BEFORE:-n/a}->${HEALTH_DAY_AFTER:-n/a} checked_at ${PROBE_CHECKED_AT:-none}->${HEALTH_CHECK_AFTER:-none} history_requests=${HEALTH_REQUESTS_AFTER:-0}"
  fi
else
  record FAIL "7. persistence" "health did not recover after down/up"
fi

# ---------------------------------------------------------------- 8. resources
line
log "=== item 8: footprint, idle vs. after ${LOAD_SEARCHES} searches (mock provider) ==="
stats_line() { docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' "$1" 2>/dev/null; }
MEM_IDLE=$(stats_line "$CONTAINER")
log "  idle:       cpu|mem|mem% = ${MEM_IDLE:-n/a}"

OK_COUNT=0
FAIL_COUNT=0
START_TS=$(date +%s)
if [ -n "$MOCK_ID" ]; then
  for i in $(seq 1 "$LOAD_SEARCHES"); do
    code=$(curl -s -b "$COOKIES" -o "$WORK/s50.json" -w '%{http_code}' --max-time 30 \
      -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
      -d "$(search_body "[\"$MOCK_ID\"]" "load probe $i")" "$BASE/api/search")
    results=$(jget "$WORK/s50.json" results.length)
    if [ "$code" = "200" ] && [ "${results:-0}" -ge 1 ] 2>/dev/null; then
      OK_COUNT=$((OK_COUNT + 1))
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  done
fi
ELAPSED=$(( $(date +%s) - START_TS ))
MEM_LOAD=$(stats_line "$CONTAINER")
log "  ${LOAD_SEARCHES} searches: ok=$OK_COUNT failed=$FAIL_COUNT wall=${ELAPSED}s"
log "  under load: cpu|mem|mem% = ${MEM_LOAD:-n/a}"
if [ "$OK_COUNT" -eq "$LOAD_SEARCHES" ]; then
  record PASS "8. resources" "$OK_COUNT/$LOAD_SEARCHES searches ok in ${ELAPSED}s; idle=${MEM_IDLE:-n/a} loaded=${MEM_LOAD:-n/a}"
elif [ -z "$MOCK_ID" ]; then
  record SKIP "8. resources" "mock provider was not created, load not measured"
else
  record FAIL "8. resources" "$FAIL_COUNT/$LOAD_SEARCHES searches failed; idle=${MEM_IDLE:-n/a} loaded=${MEM_LOAD:-n/a}"
fi

# ------------------------------------------------------------ 9. crash recovery
line
log "=== item 9: in-container process kill -> restart policy -> health and data intact ==="
RESTART_BEFORE=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 0)
# `docker kill` is an explicit stop from Docker's point of view, so the
# `unless-stopped` policy deliberately does NOT restart the container. Crash
# recovery has to kill the application process from inside the container: the
# container then exits as a failure and the restart policy applies.
# `/proc` scanning avoids relying on pgrep/ps being present in the slim image.
docker exec "$CONTAINER" sh -c '
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    [ "$pid" = "$$" ] && continue
    if grep -qa "apps/api/dist/server.mjs" "$p/cmdline" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
' >>"$REPORT" 2>&1 || true
RECOVERED=0
STATE="?"
for i in $(seq 1 45); do
  STATE=$(docker inspect -f '{{.State.Status}}|{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo "missing|0")
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/health" 2>/dev/null || true)
  if [ "$code" = "200" ] && [ "${STATE%%|*}" = "running" ]; then
    RECOVERED=1; log "  recovered after ${i}x2s (state=$STATE)"; break
  fi
  sleep 2
done
RESTART_AFTER=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 0)

if [ "$RECOVERED" = "1" ]; then
  # This endpoint runs wal_checkpoint(TRUNCATE): 200 proves SQLite reopened the
  # database after SIGKILL and can still write to the volume.
  ck_code=$(curl -s -b "$COOKIES" -o "$WORK/ck.json" -w '%{http_code}' --max-time 25 \
    -H "x-csrf-token: $CSRF" -X POST "$BASE/api/admin/maintenance/checkpoint")
  sess_kill=$(curl -s -b "$COOKIES" -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/auth/session")
  PROV_KILL=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/providers" > "$WORK/prov4.json"; \
    grep -c '"name":"hn-live"' "$WORK/prov4.json" 2>/dev/null || true)
  SEARCH_KILL=$(curl -s -b "$COOKIES" --max-time 15 "$BASE/api/admin/dashboard?range=24h" > "$WORK/dash4.json"; \
    jget "$WORK/dash4.json" totals.searches)
  log "  after kill: restartCount=$RESTART_BEFORE->$RESTART_AFTER checkpoint=$ck_code session=$sess_kill providers=${PROV_KILL:-?} searches=${SEARCH_KILL:-0}"
  if [ "$ck_code" = "200" ] && [ "$sess_kill" = "200" ] \
     && [ "${PROV_KILL:-0}" -ge 1 ] 2>/dev/null \
     && [ "${PROV_KILL:-0}" = "${PROV_AFTER2:-${PROV_KILL:-0}}" ] \
     && [ "${SEARCH_KILL:-0}" -ge "${SEARCH_AFTER2:-0}" ] 2>/dev/null; then
    record PASS "9. crash recovery" "auto-restarted ($RESTART_BEFORE->$RESTART_AFTER), checkpoint 200, session 200, providers=${PROV_KILL} searches=${SEARCH_KILL} intact"
  else
    record FAIL "9. crash recovery" "checkpoint=$ck_code session=$sess_kill providers=${PROV_KILL:-?} (expected ${PROV_AFTER2:-?}) searches=${SEARCH_KILL:-0}"
  fi
else
  record FAIL "9. crash recovery" "container did not come back after docker kill (state=$STATE)"
  docker logs --tail 50 "$CONTAINER" >>"$REPORT" 2>&1 || true
fi

# ------------------------------------------------------------ 10. vulnerability
line
log "=== item 10: image vulnerability scan (HIGH/CRITICAL gate) ==="
SCAN_FILE="$REPORT_DIR/vulnerabilities-$STAMP.txt"
: > "$SCAN_FILE"
HIGH=0
CRITICAL=0
SCANNER=""

if command -v trivy >/dev/null 2>&1; then
  SCANNER="trivy"
  TRIVY_FLAGS=""
  [ "$TRIVY_IGNORE_UNFIXED" = "1" ] && TRIVY_FLAGS="--ignore-unfixed"
  log "  trivy image --no-progress --scanners vuln --severity HIGH,CRITICAL $TRIVY_FLAGS $IMAGE"
  trivy image --no-progress --scanners vuln --severity HIGH,CRITICAL $TRIVY_FLAGS "$IMAGE" 2>&1 \
    | tee "$SCAN_FILE" | tail -30 | tee -a "$REPORT"
  HIGH=$(grep -o 'HIGH: [0-9]*' "$SCAN_FILE" | awk '{total += $2} END {print total + 0}')
  CRITICAL=$(grep -o 'CRITICAL: [0-9]*' "$SCAN_FILE" | awk '{total += $2} END {print total + 0}')
  log "  parsed: CRITICAL=$CRITICAL HIGH=$HIGH"
  if [ "$CRITICAL" -le "$MAX_CRITICAL" ] && [ "$HIGH" -le "$MAX_HIGH" ]; then
    record PASS "10. vulnerability scan" "trivy: CRITICAL=$CRITICAL HIGH=$HIGH (max $MAX_CRITICAL/$MAX_HIGH, ignore-unfixed=$TRIVY_IGNORE_UNFIXED)"
  else
    record FAIL "10. vulnerability scan" "trivy: CRITICAL=$CRITICAL HIGH=$HIGH exceeds max $MAX_CRITICAL/$MAX_HIGH"
  fi
elif docker scout version >/dev/null 2>&1; then
  SCANNER="docker scout"
  log "  docker scout cves --exit-code --only-severity critical,high $IMAGE"
  if docker scout cves --exit-code --only-severity critical,high "$IMAGE" 2>&1 | tee "$SCAN_FILE" | tail -30 | tee -a "$REPORT"; then
    record PASS "10. vulnerability scan" "docker scout: no HIGH/CRITICAL above the gate (exit 0)"
  else
    record FAIL "10. vulnerability scan" "docker scout reported HIGH/CRITICAL (non-zero exit); see $SCAN_FILE"
  fi
fi

if [ -z "$SCANNER" ]; then
  if [ "$REQUIRE_SCAN" = "1" ]; then
    record FAIL "10. vulnerability scan" "neither trivy nor docker scout is available (REQUIRE_SCAN=1)"
  else
    record SKIP "10. vulnerability scan" "neither trivy nor docker scout on this host; install trivy (https://trivy.dev) and re-run"
  fi
fi

# ------------------------------------------------------- 11. MCP over HTTP
line
log "=== item 11: MCP Streamable HTTP (initialize -> tools/list -> tools/call) ==="
tok_code=$(curl -s -b "$COOKIES" -o "$BODY" -w '%{http_code}' --max-time 20 \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"verify-mcp","scopes":["search","mcp:use","sources:read"],"rateLimitPerMin":120}' \
  "$BASE/api/admin/tokens")
MCP_TOKEN=$(jget "$BODY" token)
log "  POST /api/admin/tokens -> $tok_code token=${MCP_TOKEN:+issued}"
if [ "$tok_code" = "200" ] && [ -n "$MCP_TOKEN" ]; then
  record PASS "11a. mcp token" "token with search+mcp:use issued (value never printed)"
else
  record FAIL "11a. mcp token" "POST /api/admin/tokens = $tok_code"
fi

resources_code=$(curl -s -b "$COOKIES" -o "$WORK/resources.json" -w '%{http_code}' --max-time 15 "$BASE/api/admin/resources")
RESOURCES_SCHEMA=$(jget "$WORK/resources.json" schemaVersion)
RESOURCES_SCOPE=$(jget "$WORK/resources.json" cache.diskScope)
if [ "$resources_code" = "200" ] && [ "$RESOURCES_SCHEMA" = "1" ] && [ "$RESOURCES_SCOPE" = "whole_sqlite_database" ]; then
  record PASS "11g. resources session" "session GET 200, schemaVersion=1, whole SQLite disk scope"
else
  record FAIL "11g. resources session" "HTTP=$resources_code schema=${RESOURCES_SCHEMA:-none} scope=${RESOURCES_SCOPE:-none}"
fi
if [ -n "$MCP_TOKEN" ]; then
  resources_bearer_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "authorization: Bearer $MCP_TOKEN" "$BASE/api/admin/resources")
  if [ "$resources_bearer_code" = "403" ]; then
    record PASS "11h. resources bearer rejected" "Bearer GET 403 before token verification"
  else
    record FAIL "11h. resources bearer rejected" "HTTP=$resources_bearer_code (expected 403)"
  fi
fi

mcp_rpc() { # mcp_rpc <outfile> <payload>
  curl -s --max-time 60 -o "$1" \
    -H "authorization: Bearer $MCP_TOKEN" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "$2" "$BASE/mcp"
}

if [ -n "$MCP_TOKEN" ]; then
  mcp_rpc "$WORK/mcp-init.raw" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"docker-verify","version":"1"}}}'
  sed -n 's/^data: //p' "$WORK/mcp-init.raw" > "$WORK/mcp-init.json" 2>/dev/null || true
  [ -s "$WORK/mcp-init.json" ] || cp "$WORK/mcp-init.raw" "$WORK/mcp-init.json"
  MCP_SERVER=$(jget "$WORK/mcp-init.json" result.serverInfo.name)
  MCP_PROTO=$(jget "$WORK/mcp-init.json" result.protocolVersion)
  log "  initialize -> server=${MCP_SERVER:-none} protocol=${MCP_PROTO:-none}"
  if [ "$MCP_SERVER" = "search-hub" ]; then
    record PASS "11b. mcp initialize" "serverInfo.name=search-hub protocol=${MCP_PROTO:-n/a}"
  else
    record FAIL "11b. mcp initialize" "unexpected initialize response (see $WORK/mcp-init.raw)"
  fi

  mcp_rpc "$WORK/mcp-tools.raw" '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sed -n 's/^data: //p' "$WORK/mcp-tools.raw" > "$WORK/mcp-tools.json" 2>/dev/null || true
  [ -s "$WORK/mcp-tools.json" ] || cp "$WORK/mcp-tools.raw" "$WORK/mcp-tools.json"
  MCP_TOOLS=$(jget "$WORK/mcp-tools.json" result.tools.length)
  log "  tools/list -> ${MCP_TOOLS:-0} tool(s)"
  if [ "${MCP_TOOLS:-0}" -ge 9 ] 2>/dev/null; then
    record PASS "11c. mcp tools/list" "$MCP_TOOLS tools exposed (>=9)"
  else
    record FAIL "11c. mcp tools/list" "expected >=9 tools, got ${MCP_TOOLS:-0}"
  fi

  MCP_QUERY="typescript monorepo"
  mcp_rpc "$WORK/mcp-call.raw" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"search_web\",\"arguments\":{\"query\":\"$MCP_QUERY\",\"limit\":3}}}"
  sed -n 's/^data: //p' "$WORK/mcp-call.raw" > "$WORK/mcp-call.json" 2>/dev/null || true
  [ -s "$WORK/mcp-call.json" ] || cp "$WORK/mcp-call.raw" "$WORK/mcp-call.json"
  # tools/call returns MCP content blocks: the search payload is JSON encoded
  # inside result.content[0].text, so a plain grep for "url":"https" does not
  # match (slashes are escaped). Parse the outer JSON, then the inner payload.
  MCP_FIELDS=$(node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    let out = { isError: "parseerror", url: "", provider: "" };
    try {
      const envelope = JSON.parse(raw);
      const result = envelope.result || {};
      const text = (result.content || []).find((c) => c.type === "text")?.text || "";
      let payload = {};
      try { payload = JSON.parse(text); } catch {}
      const first = (payload.results || [])[0] || {};
      out = {
        isError: result.isError === true ? "true" : "false",
        url: first.url || "",
        provider: first.provider || first.providerName || "",
      };
    } catch {}
    process.stdout.write([out.isError, out.url, out.provider].join("|"));
  ' "$WORK/mcp-call.json")
  MCP_IS_ERROR=${MCP_FIELDS%%|*}
  MCP_REST=${MCP_FIELDS#*|}
  MCP_URL=${MCP_REST%%|*}
  MCP_PROVIDER=${MCP_REST#*|}
  log "  tools/call search_web -> isError=${MCP_IS_ERROR:-false} firstUrl=${MCP_URL:-none} provider=${MCP_PROVIDER:-none}"
  if [ "$MCP_IS_ERROR" != "true" ] && [ -n "$MCP_URL" ] && [ -n "$MCP_PROVIDER" ]; then
    record PASS "11d. mcp tools/call" "search_web returned a real URL with provider attribution (${MCP_PROVIDER})"
  else
    record FAIL "11d. mcp tools/call" "isError=${MCP_IS_ERROR:-?} url=${MCP_URL:-none} provider=${MCP_PROVIDER:-none}"
  fi

  # Same query over REST must agree with MCP on at least the first URL.
  rest_code=$(curl -s -b "$COOKIES" -o "$WORK/rest-parity.json" -w '%{http_code}' --max-time 60 \
    -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
    -d "{\"query\":\"$MCP_QUERY\",\"mode\":\"rrf\",\"limit\":3,\"skipCache\":true}" "$BASE/api/search")
  REST_HAS_URL=0
  if [ -n "$MCP_URL" ] && grep -qF "$MCP_URL" "$WORK/rest-parity.json" 2>/dev/null; then REST_HAS_URL=1; fi
  if [ "$rest_code" = "200" ] && [ "$REST_HAS_URL" = "1" ]; then
    record PASS "11e. rest/mcp parity" "REST 200 and contains the MCP first URL"
  else
    record FAIL "11e. rest/mcp parity" "REST=$rest_code mcpUrl=${MCP_URL:-none} present=$REST_HAS_URL"
  fi

  BAD_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H 'authorization: Bearer sh_invalid_token_for_verify' \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$BASE/mcp")
  if [ "$BAD_CODE" = "401" ] || [ "$BAD_CODE" = "403" ]; then
    record PASS "11f. mcp auth" "invalid token rejected with HTTP $BAD_CODE"
  else
    record FAIL "11f. mcp auth" "invalid token returned HTTP $BAD_CODE (expected 401/403)"
  fi
else
  record FAIL "11b. mcp initialize" "no token, MCP checks not executed"
fi

# ------------------------------------------------------------------- summary
line
log "SUMMARY"
printf '%-6s %-24s %s\n' STATUS ITEM DETAIL | tee -a "$REPORT"
while IFS=$'\t' read -r status item detail; do
  printf '%-6s %-24s %s\n' "$status" "$item" "$detail" | tee -a "$REPORT"
done < "$RESULTS_FILE"
line
log "items=$ITEMS_RUN skipped=$ITEMS_SKIP failed=$FAILURES"
if [ "$FAILURES" -eq 0 ]; then
  log "RESULT: PASS$([ "$ITEMS_SKIP" -gt 0 ] && printf ' (with %s skipped item(s) — read the reasons above)' "$ITEMS_SKIP")"
  exit 0
fi
log "RESULT: FAIL ($FAILURES item(s) failed)"
exit 1
