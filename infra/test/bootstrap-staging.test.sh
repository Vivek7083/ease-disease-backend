#!/usr/bin/env bash
# Tests infra/bootstrap-staging.sh against a fake `gcloud` (no cloud access, no cost). Run: bash infra/test/bootstrap-staging.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${HERE}/../bootstrap-staging.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export STUB_LOG="$WORK/gcloud.log"
FAILED=0

# ---- the fake gcloud: answers reads from STUB_* variables, accepts every change and records every call ----------------
cat >"$WORK/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  "config get-value project"*) echo "${STUB_PROJECT:-ease-disease-staging}" ;;
  "billing projects describe"*) echo "${STUB_BILLING:-True}" ;;
  "projects describe"*) echo "123456789012" ;;
  "iam service-accounts describe"*) exit 0 ;;
  "artifacts repositories describe"*) exit 0 ;;
  "iam workload-identity-pools providers describe"*--format*) echo "${STUB_CONDITION:-}" ;;
  "iam workload-identity-pools providers describe"*) [ "${STUB_PROVIDER:-}" = yes ] || exit 1 ;;
  "iam workload-identity-pools describe"*) [ "${STUB_POOL:-}" = yes ] || exit 1 ;;
  "secrets describe "*) name="${3}"; case " ${STUB_SECRETS:-} " in *" ${name} "*) exit 0 ;; *) exit 1 ;; esac ;;
  "iam service-accounts keys list"*) printf '%s' "${STUB_KEYS:-}" ;;
  "iam service-accounts get-iam-policy"*) printf '%s\n' "${STUB_WIF_MEMBERS:-}" ;;
  "projects get-iam-policy"*serviceAccount:deployer@*) printf '%s' "${STUB_ROLES_DEPLOYER:-}" ;;
  "projects get-iam-policy"*serviceAccount:api-runtime@*) printf '%s' "${STUB_ROLES_RUNTIME:-}" ;;
  "projects get-iam-policy"*serviceAccount:scheduler-tick@*) printf '%s' "${STUB_ROLES_SCHEDULER:-}" ;;
  "secrets get-iam-policy"*) printf '%s\n' "${STUB_SECRET_ACCESSORS:-}" ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$WORK/bin/gcloud"
export PATH="$WORK/bin:$PATH"

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
expect() { # expect "description" condition-command...
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}
# The log of calls that CHANGE something (everything except describe/list/get).
changes() { grep -E ' (create|create-oidc|update-oidc|add-iam-policy-binding)( |$)' "$STUB_LOG" || true; }
reset() { : >"$STUB_LOG"; unset STUB_PROJECT STUB_BILLING STUB_POOL STUB_PROVIDER STUB_SECRETS STUB_CONDITION STUB_KEYS STUB_WIF_MEMBERS \
  STUB_ROLES_DEPLOYER STUB_ROLES_RUNTIME STUB_ROLES_SCHEDULER STUB_SECRET_ACCESSORS; }

REPO="Vivek7083/ease-disease-backend"
POOL="projects/123456789012/locations/global/workloadIdentityPools/github-pool"
GOOD_CONDITION="assertion.repository == '${REPO}' && assertion.ref == 'refs/heads/develop'"
GOOD_MEMBER="principalSet://iam.googleapis.com/${POOL}/attribute.repository/${REPO}"

echo "== dry run on a fresh project =="
reset
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"; CODE=$?
expect "dry run exits 0" test "$CODE" = 0
expect "dry run changes nothing (no change call reached gcloud)" test -z "$(changes)"
expect "plans to create the pool and the provider" bash -c "grep -q 'workload-identity-pools create github-pool' <<<\"\$1\" && grep -q 'providers create-oidc github-provider' <<<\"\$1\"" _ "$OUT"
expect "provider trusts only this repository and only the develop branch" grep -qF -- "--attribute-condition ${GOOD_CONDITION}" <<<"$OUT"
expect "only this repository (not the whole pool) may act as the deployer" grep -qF -- "--member ${GOOD_MEMBER}" <<<"$OUT"
expect "deployer gets exactly run.developer at project level" bash -c "[ \$(grep -c 'projects add-iam-policy-binding' <<<\"\$1\") = 1 ] && grep -q 'roles/run.developer' <<<\"\$1\"" _ "$OUT"
expect "no secret is bound while none exists, and the script says so" bash -c "! grep -q 'secrets add-iam-policy-binding' <<<\"\$1\" && grep -q 'skip     secret PAYU_KEY' <<<\"\$1\"" _ "$OUT"
expect "prints the identifiers the GitHub environment needs" grep -q 'GCP_WORKLOAD_IDENTITY_PROVIDER   = projects/123456789012' <<<"$OUT"

echo "== apply, re-run, secrets =="
reset; export STUB_POOL=yes STUB_PROVIDER=yes STUB_SECRETS="PAYU_KEY DATABASE_URL"
OUT="$(bash "$SCRIPT" 2>&1)"; CODE=$?
expect "apply exits 0" test "$CODE" = 0
expect "second run updates the provider instead of failing or creating a duplicate" bash -c "grep -q 'update-oidc' '$STUB_LOG' && ! grep -q 'workload-identity-pools create' '$STUB_LOG' && ! grep -q 'providers create-oidc' '$STUB_LOG'"
expect "changes really reach gcloud when applying" test -n "$(changes)"
expect "only the secrets that exist get a binding (2 of 3)" test "$(grep -c 'secrets add-iam-policy-binding' "$STUB_LOG")" = 2
expect "PAYU_SALT (missing) is skipped with a message" grep -q 'skip     secret PAYU_SALT' <<<"$OUT"

echo "== guards =="
reset; export STUB_PROJECT=some-other-project
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"; CODE=$?
expect "refuses another active project (exit 2)" test "$CODE" = 2
expect "...and says so" grep -q "Refusing to run" <<<"$OUT"
expect "...and made no change" test -z "$(changes)"
reset; export STUB_BILLING=False
bash "$SCRIPT" --dry-run >/dev/null 2>&1; CODE=$?
expect "refuses when billing is off (exit 2)" test "$CODE" = 2
reset
bash "$SCRIPT" --bogus >/dev/null 2>&1; CODE=$?
expect "rejects an unknown option (exit 2)" test "$CODE" = 2

echo "== verify =="
good_env() {
  reset; export STUB_PROVIDER=yes STUB_SECRETS="PAYU_KEY PAYU_SALT DATABASE_URL" STUB_CONDITION="$GOOD_CONDITION" STUB_KEYS="" \
    STUB_WIF_MEMBERS="$GOOD_MEMBER" STUB_ROLES_DEPLOYER="roles/run.developer" STUB_ROLES_RUNTIME="" STUB_ROLES_SCHEDULER="" \
    STUB_SECRET_ACCESSORS="serviceAccount:api-runtime@ease-disease-staging.iam.gserviceaccount.com"
}
good_env
bash "$SCRIPT" --verify >/dev/null 2>&1; CODE=$?
expect "a correct setup verifies clean (exit 0)" test "$CODE" = 0
expect "verify changes nothing" test -z "$(changes)"

verify_fails() { # verify_fails "description"  (environment already modified)
  bash "$SCRIPT" --verify >/dev/null 2>&1; local code=$?
  expect "$1" test "$code" = 1
}
good_env; export STUB_KEYS="projects/p/serviceAccounts/x/keys/abc"; verify_fails "a downloaded key is flagged"
good_env; export STUB_ROLES_DEPLOYER=$'roles/run.developer\nroles/owner'; verify_fails "an extra owner role on the deployer is flagged"
good_env; export STUB_ROLES_RUNTIME="roles/editor"; verify_fails "any project role on the runtime account is flagged"
good_env; export STUB_CONDITION="assertion.repository == '${REPO}'"; verify_fails "a provider that trusts any branch is flagged"
good_env; export STUB_CONDITION=""; verify_fails "a provider with no condition is flagged"
good_env; export STUB_WIF_MEMBERS="principalSet://iam.googleapis.com/${POOL}/*"; verify_fails "letting the whole pool act as the deployer is flagged"
good_env; export STUB_SECRET_ACCESSORS=$'serviceAccount:api-runtime@ease-disease-staging.iam.gserviceaccount.com\nserviceAccount:deployer@ease-disease-staging.iam.gserviceaccount.com'
verify_fails "a second reader of a secret is flagged"
good_env; unset STUB_PROVIDER; verify_fails "a missing provider is flagged"

echo "== the script file itself =="
expect "never creates a service account key" bash -c "! grep -qE 'keys create|--key-file|GOOGLE_APPLICATION_CREDENTIALS' '$SCRIPT'"
expect "never grants owner, editor or admin roles" bash -c "! grep -qE 'roles/(owner|editor)|Admin' '$SCRIPT'"
expect "passes shellcheck-style strict mode" grep -q '^set -euo pipefail' "$SCRIPT"

echo
[ "$FAILED" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
