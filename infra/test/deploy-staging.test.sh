#!/usr/bin/env bash
# Tests infra/deploy-staging.sh against a fake `gcloud` and a fake `curl` (no cloud access, no cost).
# Run: bash infra/test/deploy-staging.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${HERE}/../deploy-staging.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export STUB_LOG="$WORK/calls.log"
FAILED=0

# ---- fake gcloud: answers reads from STUB_* variables, accepts every change and records every call -------------------------
cat >"$WORK/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
echo "gcloud $*" >>"$STUB_LOG"
case "$*" in
  "config get-value project"*) echo "${STUB_PROJECT:-ease-disease-staging}" ;;
  "artifacts docker images describe"*--format*) echo "sha256:abc123" ;;
  "artifacts docker images describe"*) [[ -n "${STUB_MISSING_IMAGE:-}" && "$*" == *"${STUB_MISSING_IMAGE}"* ]] && exit 1; exit 0 ;;
  "secrets describe "*) name="${3}"; case " ${STUB_MISSING_SECRETS:-} " in *" ${name} "*) exit 1 ;; *) exit 0 ;; esac ;;
  "run jobs deploy"*) exit 0 ;;
  "run jobs execute"*) [ -z "${STUB_MIGRATION_FAIL:-}" ] || exit 1 ;;
  "run services describe"*"metadata.name"*) [ -z "${STUB_NO_SERVICE:-}" ] || exit 1; echo api ;;
  "run services describe"*"percent=100"*) echo "${STUB_PREVIOUS:-api-00001-aaa}" ;;
  "run services describe"*"tag=candidate"*) echo "https://candidate---api-xyz.a.run.app" ;;
  "run services describe"*"status.url"*) echo "https://api-xyz.a.run.app" ;;
  "run services describe"*"latestReadyRevisionName"*) echo "api-00002-bbb" ;;
  "run deploy"*) [ -z "${STUB_DEPLOY_FAIL:-}" ] || exit 1 ;;
  "run services update-traffic"*) exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$WORK/bin/gcloud"

# ---- fake curl: answers by URL path, method and Origin header ---------------------------------------------------------------
cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
args=("$@"); url="${args[${#args[@]}-1]}"; method=GET; origin=""; headers=0; status=0
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    -X) method="${args[$((i + 1))]}" ;;
    -D) headers=1 ;;
    -w) status=1 ;;
    -H) case "${args[$((i + 1))]}" in Origin:*) origin="${args[$((i + 1))]#Origin: }" ;; esac ;;
  esac
done
echo "curl $method $url origin=$origin" >>"$STUB_LOG"
path="/${url#https://*/}"; host="${url#https://}"; host="${host%%/*}"
if [ "$headers" = 1 ]; then
  echo "HTTP/2 204"
  if [ "$origin" = "https://staging.example" ] && [ -z "${STUB_CORS_BAD:-}" ]; then echo "Access-Control-Allow-Origin: $origin"; fi
  if [ "$origin" = "https://evil.example" ] && [ -n "${STUB_CORS_OPEN:-}" ]; then echo "Access-Control-Allow-Origin: $origin"; fi
  exit 0
fi
if [ "$status" = 1 ]; then
  case "$path" in
    /v1/me) printf '%s' "${STUB_ME_STATUS:-401}" ;;
    /dev/tick) printf '%s' "${STUB_DEV_STATUS:-404}" ;;
    *) printf '200' ;;
  esac
  exit 0
fi
case "$path" in
  /healthz)
    if [[ "$host" == api-xyz* ]]; then printf '%s' "${STUB_LIVE_HEALTH:-{\"status\":\"ok\",\"version\":\"0.0.1\",\"db\":\"ok\"}}"
    else printf '%s' "${STUB_HEALTH:-{\"status\":\"ok\",\"version\":\"0.0.1\",\"db\":\"ok\"}}"; fi ;;
  /v1/packages) printf '%s' "${STUB_PACKAGES:-{\"packages\":[{\"id\":\"1\",\"title\":\"T\",\"description\":[],\"pricePaise\":100,\"originalPricePaise\":null,\"currency\":\"INR\",\"durationMinutes\":30}]}}" ;;
  *) printf '{}' ;;
esac
STUB
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
expect() { local description="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi; }
# Calls that CHANGE something.
changes() { grep -E '^gcloud run (jobs deploy|jobs execute|deploy|services update-traffic)' "$STUB_LOG" || true; }
logline() { grep -n "$1" "$STUB_LOG" | head -1 | cut -d: -f1; }
reset() {
  : >"$STUB_LOG"
  unset STUB_PROJECT STUB_MISSING_IMAGE STUB_MISSING_SECRETS STUB_MIGRATION_FAIL STUB_NO_SERVICE STUB_PREVIOUS STUB_DEPLOY_FAIL \
    STUB_CORS_BAD STUB_CORS_OPEN STUB_ME_STATUS STUB_DEV_STATUS STUB_LIVE_HEALTH STUB_HEALTH STUB_PACKAGES CORS_EXTRA_ORIGINS
  export FIREBASE_PROJECT_ID=ease-disease-staging FRONTEND_BASE_URL=https://staging.example API_PUBLIC_URL=https://api-xyz.a.run.app \
    TICK_AUDIENCE=https://api-xyz.a.run.app TICK_SERVICE_ACCOUNT_EMAIL=scheduler-tick@ease-disease-staging.iam.gserviceaccount.com \
    TRUST_PROXY_HOPS=0 SLEEP_SECONDS=0 CHECK_ATTEMPTS=2
}
TAG="abc1234def"

echo "== dry run =="
reset
OUT="$(bash "$SCRIPT" --dry-run "$TAG" 2>&1)"; CODE=$?
expect "dry run exits 0" test "$CODE" = 0
expect "dry run changes nothing" test -z "$(changes)"
expect "the new version starts without traffic on its own tag" grep -q -- '--no-traffic --tag candidate' <<<"$OUT"
expect "at most one instance (rate limits live in memory)" grep -q -- '--max-instances 1' <<<"$OUT"
expect "public without an allUsers grant (the organization forbids it)" bash -c "grep -q -- '--no-invoker-iam-check' <<<\"\$1\" && ! grep -qiE 'allUsers|allow-unauthenticated' <<<\"\$1\"" _ "$OUT"
expect "the migration job reads the DIRECT database secret" grep -q 'DATABASE_URL=DATABASE_URL_DIRECT:latest' <<<"$OUT"
expect "the service reads the pooled database secret and the PayU secrets" grep -q 'PAYU_KEY=PAYU_KEY:latest,PAYU_SALT=PAYU_SALT:latest,DATABASE_URL=DATABASE_URL:latest' <<<"$OUT"
expect "staging settings are fixed (NODE_ENV, App Check, PayU test)" bash -c "grep -q 'NODE_ENV=staging' <<<\"\$1\" && grep -q 'APP_CHECK_MODE=enforce' <<<\"\$1\" && grep -q 'PAYU_ENV=test' <<<\"\$1\"" _ "$OUT"
expect "the migration runs before the service is deployed" bash -c "[ \$(grep -n 'jobs execute' <<<\"\$1\" | head -1 | cut -d: -f1) -lt \$(grep -n 'run deploy api' <<<\"\$1\" | head -1 | cut -d: -f1) ]" _ "$OUT"

reset; export CORS_EXTRA_ORIGINS="https://preview.example,https://other.example"
OUT="$(bash "$SCRIPT" --dry-run "$TAG" 2>&1)"
expect "extra CORS origins (with a comma) are passed through intact" grep -qF 'CORS_EXTRA_ORIGINS=https://preview.example,https://other.example' <<<"$OUT"

echo "== a normal deploy =="
reset
OUT="$(bash "$SCRIPT" "$TAG" 2>&1)"; CODE=$?
expect "exits 0 and reports the revision and digest" bash -c "[ $CODE = 0 ] && grep -q 'DEPLOYED  revision api-00002-bbb' <<<\"\$1\" && grep -q 'sha256:abc123' <<<\"\$1\"" _ "$OUT"
J=$(logline "run jobs execute"); D=$(logline "gcloud run deploy"); T=$(logline "update-traffic.*--to-latest"); R=$(logline "remove-tags candidate")
expect "order: migrate, deploy, checks, switch traffic, drop the tag" test "$J" -lt "$D" -a "$D" -lt "$T" -a "$T" -lt "$R"
expect "the candidate address was checked before traffic moved" bash -c "[ \$(grep -n 'curl GET https://candidate---api-xyz.a.run.app/healthz' '$STUB_LOG' | head -1 | cut -d: -f1) -lt $T ]"
expect "prints how to go back to the previous revision" grep -q 'to-revisions api-00001-aaa=100' <<<"$OUT"

echo "== a failed migration =="
reset; export STUB_MIGRATION_FAIL=1
OUT="$(bash "$SCRIPT" "$TAG" 2>&1)"; CODE=$?
expect "exits 1 and says the service was not touched" bash -c "[ $CODE = 1 ] && grep -q 'service was NOT touched' <<<\"\$1\"" _ "$OUT"
expect "the service is never deployed after a failed migration" bash -c "! grep -q '^gcloud run deploy' '$STUB_LOG' && ! grep -q 'update-traffic' '$STUB_LOG'"

echo "== a failed check keeps the old version serving =="
check_blocks() { # check_blocks "description"   (environment already set)
  local out code
  out="$(bash "$SCRIPT" "$TAG" 2>&1)"; code=$?
  expect "$1" bash -c "[ $code = 1 ] && ! grep -q 'update-traffic' '$STUB_LOG' && grep -q 'FAIL    ' <<<\"\$1\"" _ "$out"
}
reset; export STUB_HEALTH='{"status":"ok","version":"0.0.1","db":"down"}'; check_blocks "database down blocks the switch"
reset; export STUB_PACKAGES='{"packages":[]}'; check_blocks "an empty package list blocks the switch"
reset; export STUB_PACKAGES='{"packages":[{"id":"1","title":"T","description":[],"pricePaise":1,"originalPricePaise":null,"currency":"INR","durationMinutes":30,"isActive":true}]}'; check_blocks "a leaked internal field blocks the switch"
reset; export STUB_ME_STATUS=200; check_blocks "login not required on /v1/me blocks the switch"
reset; export STUB_DEV_STATUS=200; check_blocks "a reachable development route blocks the switch"
reset; export STUB_CORS_BAD=1; check_blocks "CORS refusing the website blocks the switch"
reset; export STUB_CORS_OPEN=1; check_blocks "CORS allowing a foreign origin blocks the switch"

echo "== a failure after the switch goes back =="
reset; export STUB_LIVE_HEALTH='{"status":"ok","db":"down"}'
OUT="$(bash "$SCRIPT" "$TAG" 2>&1)"; CODE=$?
expect "exits 1 and sends traffic back to the previous revision" bash -c "[ $CODE = 1 ] && grep -q 'update-traffic.*--to-revisions api-00001-aaa=100' '$STUB_LOG' && grep -q 'sent back to api-00001-aaa' <<<\"\$1\"" _ "$OUT"

echo "== first deploy of a new service =="
reset; export STUB_NO_SERVICE=1
OUT="$(bash "$SCRIPT" "$TAG" 2>&1)"; CODE=$?
expect "no --no-traffic flag (a new service must take traffic) and no traffic switching" bash -c "[ $CODE = 0 ] && ! grep -q -- '--no-traffic' '$STUB_LOG' && ! grep -q 'update-traffic' '$STUB_LOG'"
expect "the first deploy is still checked, on the service address" grep -q 'curl GET https://api-xyz.a.run.app/healthz' "$STUB_LOG"
reset; export STUB_NO_SERVICE=1 STUB_LIVE_HEALTH='{"status":"ok","db":"down"}'
OUT="$(bash "$SCRIPT" "$TAG" 2>&1)"; CODE=$?
expect "a failing first deploy exits 1 and says so" bash -c "[ $CODE = 1 ] && grep -q 'FIRST deploy' <<<\"\$1\"" _ "$OUT"

echo "== guards =="
guard() { # guard "description" args...   (expects exit 2 and no change)
  local description="$1"; shift
  bash "$SCRIPT" "$@" >/dev/null 2>&1; local code=$?
  expect "$description" bash -c "[ $code = 2 ] && [ -z \"\$(grep -E '^gcloud run (jobs|deploy|services update)' '$STUB_LOG')\" ]"
}
reset; export STUB_PROJECT=some-other-project; guard "refuses another active project" "$TAG"
reset; guard "refuses a missing image tag"
reset; guard "refuses a malformed image tag" 'x;rm -rf'
reset; guard "refuses two image tags" "$TAG" otherTag123
reset; guard "refuses an unknown option" --bogus "$TAG"
reset; unset FRONTEND_BASE_URL; guard "refuses a missing setting" "$TAG"
reset; export API_PUBLIC_URL=http://api-xyz.a.run.app; guard "refuses a non-https address" "$TAG"
reset; export TRUST_PROXY_HOPS=9; guard "refuses an impossible proxy hop count" "$TAG"
reset; export STUB_MISSING_IMAGE="-migrate"; guard "refuses when the migrate image is missing" "$TAG"

echo "== the script file itself =="
expect "never makes the service public with allUsers or allow-unauthenticated" bash -c "! grep -qiE 'allUsers|--allow-unauthenticated' '$SCRIPT'"
expect "never reads or writes a secret value" bash -c "! grep -qE 'versions access|secrets versions|--data-file' '$SCRIPT'"
expect "does not look secrets up (the deployer has no Secret Manager role, so a lookup fails and wrongly says missing)" bash -c "! grep -qE 'gcloud secrets' '$SCRIPT'"
expect "strict mode" grep -q '^set -euo pipefail' "$SCRIPT"

echo
if [ "$FAILED" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
