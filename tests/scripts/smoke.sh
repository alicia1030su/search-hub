#!/usr/bin/env bash
# End-to-end smoke test against a running Search Hub instance.
# Usage: tests/scripts/smoke.sh [BASE_URL]
# Requires: a FRESH data directory (the script creates the first administrator).
set -euo pipefail

BASE="${1:-http://127.0.0.1:8799}"
COOKIE_JAR=".smoke-cookies.txt"
TMP_JSON=".smoke-response.json"

cleanup() { rm -f "$COOKIE_JAR" "$TMP_JSON" "$TMP_JSON.headers"; }
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$1"; exit 1; }
step() { printf '\n=== %s ===\n' "$1"; }
jget() {
  node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const o=JSON.parse(d);const p='$1'.split('.');let v=o;for(const k of p){v=v?.[k]}console.log(v??'')}
  catch(e){console.log('')}
});"
}

step "1. health"
curl -sS "$BASE/api/health" | tee "$TMP_JSON"
grep -q '"status":"ok"' "$TMP_JSON" || fail "health status"

step "2. first-run setup (requires the one-time token)"
SETUP_TOKEN="${SEARCH_HUB_SETUP_TOKEN:-}"
if [ -z "$SETUP_TOKEN" ]; then
  for candidate in "${SEARCH_HUB_DATA_DIR:-./data}/setup-token" "${SEARCH_HUB_DATA_DIR:-./data}/../setup-token"; do
    if [ -f "$candidate" ]; then SETUP_TOKEN=$(cat "$candidate"); break; fi
  done
fi
[ -n "$SETUP_TOKEN" ] || fail "setup token not found; pass SEARCH_HUB_SETUP_TOKEN or point SEARCH_HUB_DATA_DIR at the instance data dir"

# A fresh instance must reject a setup call without the token (admin preemption guard).
NO_TOKEN_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"email":"attacker@example.com","password":"Attacker-Password-1","name":"Attacker"}' \
  "$BASE/api/setup")
[ "$NO_TOKEN_CODE" = "403" ] || fail "setup without token returned $NO_TOKEN_CODE (expected 403)"

curl -sS -c "$COOKIE_JAR" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@example.com\",\"password\":\"Initial-Admin-Pass-1\",\"name\":\"Admin\",\"setupToken\":\"$SETUP_TOKEN\"}" \
  "$BASE/api/setup" | tee "$TMP_JSON"
CSRF=$(jget csrfToken < "$TMP_JSON")
[ -n "$CSRF" ] || fail "setup did not return a session"

step "3. session"
curl -sS -b "$COOKIE_JAR" "$BASE/api/auth/session" | tee "$TMP_JSON"
grep -q 'admin@example.com' "$TMP_JSON" || fail "session user"

step "4. add two mock providers"
curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"mock-a","type":"mock","enabled":true,"config":{"resultCount":6,"latencyMs":40,"namespace":"a"}}' \
  "$BASE/api/admin/providers" | tee "$TMP_JSON"
PROVIDER_ID=$(jget provider.id < "$TMP_JSON")
[ -n "$PROVIDER_ID" ] || fail "provider create"

curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"mock-b","type":"mock","enabled":true,"config":{"resultCount":5,"latencyMs":30,"namespace":"b"}}' \
  "$BASE/api/admin/providers" > /dev/null

step "5. provider test"
curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{}' "$BASE/api/admin/providers/$PROVIDER_ID/test" | tee "$TMP_JSON"
grep -q '"ok":true' "$TMP_JSON" || fail "provider self-test"

step "6. add a key (must be masked everywhere)"
curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"label":"k1","key":"sk-SMOKE-FINGERPRINT-1","weight":100,"enabled":true}' \
  "$BASE/api/admin/providers/$PROVIDER_ID/keys" > /dev/null
curl -sS -b "$COOKIE_JAR" "$BASE/api/admin/providers/$PROVIDER_ID/keys" | tee "$TMP_JSON"
grep -q 'sk-SMOKE-FINGERPRINT-1' "$TMP_JSON" && fail "key leaked in key list"
grep -q '…' "$TMP_JSON" || fail "masked key missing"

step "7. multi-source search (RRF)"
curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"query":"typescript monorepo","mode":"rrf","limit":10}' "$BASE/api/search" | tee "$TMP_JSON"
node -e "
const fs=require('fs');const o=JSON.parse(fs.readFileSync('$TMP_JSON','utf8'));
if(!o.results||o.results.length===0){console.error('FAIL: no results');process.exit(1)}
console.log('results:',o.results.length,'raw:',o.stats.rawCount,'deduped:',o.stats.dedupedCount,'providers ok:',o.stats.providers.filter(p=>p.ok).length,'/',o.stats.providers.length);
const leaks=[];const walk=(v,k)=>{if(typeof v==='string'&&v.includes('sk-SMOKE-FINGERPRINT'))leaks.push(k);else if(Array.isArray(v))v.forEach((x,i)=>walk(x,k+'['+i+']'));else if(v&&typeof v==='object')for(const [a,b] of Object.entries(v))walk(b,k+'.'+a)};
walk(o,'response');
if(leaks.length){console.error('FAIL: key leaked at',leaks.join(','));process.exit(1)}
console.log('secret scan: clean');
"

step "8. fault isolation: break one provider, expect partial success"
curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -X PATCH -d '{"config":{"failMode":"server_error","resultCount":5,"latencyMs":10}}' \
  "$BASE/api/admin/providers/$PROVIDER_ID" > /dev/null
sleep 1
curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"query":"fault isolation","mode":"rrf","limit":10}' "$BASE/api/search" | tee "$TMP_JSON"
node -e "
const fs=require('fs');const o=JSON.parse(fs.readFileSync('$TMP_JSON','utf8'));
console.log('status:',o.status,'errors:',o.errors.length,'results:',o.results.length);
if(o.results.length===0){console.error('FAIL: healthy source results lost');process.exit(1)}
if(o.errors.length===0){console.error('FAIL: failing source not reported');process.exit(1)}
"

step "9. token auth for REST"
curl -sS -b "$COOKIE_JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"smoke","scopes":["search","mcp:use"],"rateLimitPerMin":120}' \
  "$BASE/api/admin/tokens" | tee "$TMP_JSON"
TOKEN=$(jget token < "$TMP_JSON")
[ -n "$TOKEN" ] || fail "token create"
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"token auth","mode":"rrf","limit":5}' "$BASE/api/search" | tee "$TMP_JSON"
grep -q '"results"' "$TMP_JSON" || fail "bearer search"

step "10. MCP initialize over Streamable HTTP"
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  "$BASE/mcp" | tee "$TMP_JSON"
node -e "
const fs=require('fs');const raw=fs.readFileSync('$TMP_JSON','utf8').trim();
const body=raw.includes('data:')?raw.split('data:').pop().trim():raw;
let o;try{o=JSON.parse(body)}catch(e){console.error('FAIL: MCP response not JSON:',raw.slice(0,300));process.exit(1)}
if(!o.result){console.error('FAIL: MCP initialize failed:',JSON.stringify(o).slice(0,400));process.exit(1)}
const v=o.result.protocolVersion||o.result.protocol_version||'';
console.log('MCP server:',o.result.serverInfo?.name,'protocol:',v);
"

printf '\nSMOKE TEST PASSED\n'
