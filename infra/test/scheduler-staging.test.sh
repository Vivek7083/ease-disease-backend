#!/usr/bin/env bash
# Tests infra/scheduler-staging.sh and the API Hosting configuration against a fake `gcloud` (no cloud access).
# Run: bash infra/test/scheduler-staging.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="${HERE}/.."
SCRIPT="${INFRA}/scheduler-staging.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export STUB_LOG="$WORK/calls.log"
FAILED=0

cat >"$WORK/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
echo "gcloud $*" >>"$STUB_LOG"
if [ -n "${STUB_FAIL_ON:-}" ] && [[ "$*" == *"${STUB_FAIL_ON}"* ]]; then exit 1; fi
case "$*" in
  "config get-value project"*) echo "${STUB_PROJECT:-ease-disease-staging}" ;;
  "scheduler jobs describe"*"--format=value(state)"*) echo "${STUB_STATE:-ENABLED}" ;;
  "scheduler jobs describe"*"--format=value(schedule)"*) echo "${STUB_SCHEDULE:-*/5 * * * *}" ;;
  "scheduler jobs describe"*"httpTarget.uri"*) echo "${STUB_URI:-https://api-xyz.a.run.app/v1/internal/tick}" ;;
  "scheduler jobs describe"*"httpTarget.httpMethod"*) echo "${STUB_METHOD:-POST}" ;;
  "scheduler jobs describe"*"oidcToken.serviceAccountEmail"*) echo "${STUB_SA:-scheduler-tick@ease-disease-staging.iam.gserviceaccount.com}" ;;
  "scheduler jobs describe"*"oidcToken.audience"*) echo "${STUB_AUD:-https://api-xyz.a.run.app}" ;;
  "scheduler jobs describe"*"oauthToken"*) echo "${STUB_OAUTH:-}" ;;
  "scheduler jobs describe"*"attemptDeadline"*) echo "60s" ;;
  "scheduler jobs describe"*) [ -n "${STUB_JOB_EXISTS:-}" ] || exit 1 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$WORK/bin/gcloud"
export PATH="$WORK/bin:$PATH"

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
expect() { local description="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi; }
changes() { grep -E '^gcloud scheduler jobs (create|update)' "$STUB_LOG" || true; }
reset() {
  : >"$STUB_LOG"
  unset STUB_PROJECT STUB_JOB_EXISTS STUB_STATE STUB_SCHEDULE STUB_URI STUB_METHOD STUB_SA STUB_AUD STUB_OAUTH STUB_FAIL_ON
  export API_PUBLIC_URL=https://api-xyz.a.run.app TICK_AUDIENCE=https://api-xyz.a.run.app
}

echo "== dry run and apply =="
reset
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"; CODE=$?
expect "dry run exits 0 and changes nothing" bash -c "[ $CODE = 0 ] && [ -z \"\$(grep -E '^gcloud scheduler jobs (create|update)' '$STUB_LOG')\" ]"
expect "creates the job when it does not exist" grep -q 'scheduler jobs create http tick' <<<"$OUT"
expect "every five minutes, POST to the tick address" bash -c "grep -qF -- '--schedule */5 * * * *' <<<\"\$1\" && grep -q -- '--uri https://api-xyz.a.run.app/v1/internal/tick --http-method POST' <<<\"\$1\"" _ "$OUT"
expect "signed as the scheduler-tick account with the exact audience" bash -c "grep -q -- '--oidc-service-account-email scheduler-tick@ease-disease-staging.iam.gserviceaccount.com' <<<\"\$1\" && grep -q -- '--oidc-token-audience https://api-xyz.a.run.app ' <<<\"\$1\"" _ "$OUT"
expect "no OAuth token or password is used" bash -c "! grep -qiE 'oauth|password|--headers|--message-body' <<<\"\$1\"" _ "$OUT"
reset; export STUB_JOB_EXISTS=1
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"
expect "updates the job when it already exists" grep -q 'scheduler jobs update http tick' <<<"$OUT"
reset; export API_PUBLIC_URL=https://api-xyz.a.run.app/ TICK_AUDIENCE=https://api-xyz.a.run.app/
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"
expect "a trailing slash is removed so the audience matches the API's" bash -c "grep -q -- '--oidc-token-audience https://api-xyz.a.run.app ' <<<\"\$1\" && grep -q 'https://api-xyz.a.run.app/v1/internal/tick' <<<\"\$1\"" _ "$OUT"
reset
bash "$SCRIPT" >/dev/null 2>&1; CODE=$?
expect "apply really calls gcloud to create the job" bash -c "[ $CODE = 0 ] && grep -q '^gcloud scheduler jobs create http tick' '$STUB_LOG'"

echo "== guards =="
guard() {
  local description="$1"; shift
  bash "$SCRIPT" "$@" >/dev/null 2>&1; local code=$?
  expect "$description" bash -c "[ $code = 2 ] && [ -z \"\$(grep -E '^gcloud scheduler jobs (create|update)' '$STUB_LOG')\" ]"
}
reset; export STUB_PROJECT=other-project; guard "refuses another active project"
reset; export API_PUBLIC_URL=http://api-xyz.a.run.app; guard "refuses a non-https address"
reset; unset TICK_AUDIENCE; guard "refuses a missing audience"
reset; guard "refuses an unknown option" --bogus

echo "== verify =="
good() { reset; export STUB_JOB_EXISTS=1; }
good; bash "$SCRIPT" --verify >/dev/null 2>&1; expect "a correct job verifies clean" test "$?" = 0
bad() { bash "$SCRIPT" --verify >/dev/null 2>&1; local code=$?; expect "$1" test "$code" = 1; }
reset; bad "a missing job is flagged"
good; export STUB_STATE=PAUSED; bad "a paused job is flagged"
good; export STUB_SCHEDULE="0 * * * *"; bad "a wrong schedule is flagged"
good; export STUB_URI="https://other.example/v1/internal/tick"; bad "a wrong address is flagged"
good; export STUB_METHOD=GET; bad "a wrong method is flagged"
good; export STUB_SA="someone@ease-disease-staging.iam.gserviceaccount.com"; bad "a wrong signing account is flagged"
good; export STUB_AUD="https://api-xyz.a.run.app/"; bad "an audience that differs by a slash is flagged"
good; export STUB_OAUTH="x@y.iam.gserviceaccount.com"; bad "an extra OAuth credential is flagged"
good; export STUB_FAIL_ON="--format=value(state)"; bad "an unreadable field is reported and the report finishes"

echo "== API Hosting configuration =="
expect "firebase.json: the API site rewrites everything to the Cloud Run service api in asia-south1" python3 - "$INFRA/firebase.json" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))["hosting"]
assert h["site"] == "ease-disease-staging-api"
assert h["rewrites"] == [{"source": "**", "run": {"serviceId": "api", "region": "asia-south1"}}], h["rewrites"]
PY
expect "the public folder exists and has no index.html (so even / goes to the API)" bash -c "[ -f '$INFRA/hosting-api-public/robots.txt' ] && [ ! -f '$INFRA/hosting-api-public/index.html' ]"
expect "robots.txt keeps search engines away from the API" grep -q 'Disallow: /' "$INFRA/hosting-api-public/robots.txt"
expect ".firebaserc points at the staging project only" bash -c "grep -q 'ease-disease-staging' '$INFRA/.firebaserc' && ! grep -qi 'prod' '$INFRA/.firebaserc'"

echo "== the script file itself =="
expect "never handles a password or key" bash -c "! grep -qiE 'password|--key-file|keys create' '$SCRIPT'"
expect "strict mode" grep -q '^set -euo pipefail' "$SCRIPT"

echo
if [ "$FAILED" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
