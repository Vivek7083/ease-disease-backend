#!/usr/bin/env bash
# Tests infra/bootstrap-staging.sh against a fake `gcloud` (no cloud access, no cost). Run: bash infra/test/bootstrap-staging.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REAL_SCRIPT="${HERE}/../bootstrap-staging.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
# The tests must not depend on the real repository id: they run a copy with the id forced empty (the pinned case is tested
# separately with a made-up id).
SCRIPT="${WORK}/bootstrap-staging.sh"
sed 's/^GITHUB_REPOSITORY_ID=.*/GITHUB_REPOSITORY_ID=""/' "$REAL_SCRIPT" >"$SCRIPT"
export STUB_LOG="$WORK/gcloud.log"
FAILED=0

# ---- the fake gcloud: answers reads from STUB_* variables, accepts every change and records every call ----------------
cat >"$WORK/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
if [ -n "${STUB_FAIL_ON:-}" ] && [[ "$*" == *"${STUB_FAIL_ON}"* ]]; then echo "ERROR: simulated failure" >&2; exit 1; fi
case "$*" in
  "billing projects describe"*) [ -z "${STUB_BILLING_FAIL:-}" ] || exit 1; echo "${STUB_BILLING:-True}" ;;
  "services list"*) printf '%s\n' ${STUB_SERVICES:-iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com} ;;
  "artifacts repositories get-iam-policy"*) printf '%s\n' "${STUB_AR_WRITERS:-}" ;;
  "iam service-accounts get-iam-policy"*api-runtime@*) printf '%s\n' "${STUB_RUNTIME_USERS:-}" ;;
  "projects get-iam-policy"*secretAccessor*) printf '%s\n' "${STUB_PROJECT_SECRET_READERS:-}" ;;
  "config get-value project"*) echo "${STUB_PROJECT:-ease-disease-staging}" ;;
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
reset() { : >"$STUB_LOG"; unset STUB_FAIL_ON STUB_BILLING_FAIL STUB_SERVICES STUB_AR_WRITERS STUB_RUNTIME_USERS STUB_PROJECT_SECRET_READERS STUB_PROJECT STUB_BILLING STUB_POOL STUB_PROVIDER STUB_SECRETS STUB_CONDITION STUB_KEYS STUB_WIF_MEMBERS \
  STUB_ROLES_DEPLOYER STUB_ROLES_RUNTIME STUB_ROLES_SCHEDULER STUB_SECRET_ACCESSORS; }

REPO="Vivek7083/ease-disease-backend"
POOL="projects/123456789012/locations/global/workloadIdentityPools/github-pool"
GOOD_CONDITION="assertion.repository == '${REPO}' && assertion.ref == 'refs/heads/develop' && assertion.event_name == 'workflow_dispatch'"
DEPLOYER_SA="serviceAccount:deployer@ease-disease-staging.iam.gserviceaccount.com"
GOOD_MEMBER="principalSet://iam.googleapis.com/${POOL}/attribute.repository/${REPO}"

echo "== dry run on a fresh project =="
reset
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"; CODE=$?
expect "dry run exits 0" test "$CODE" = 0
expect "dry run changes nothing (no change call reached gcloud)" test -z "$(changes)"
expect "plans to create the pool and the provider" bash -c "grep -q 'workload-identity-pools create github-pool' <<<\"\$1\" && grep -q 'providers create-oidc github-provider' <<<\"\$1\"" _ "$OUT"
expect "provider trusts only this repository and only the develop branch" grep -qF -- "--attribute-condition ${GOOD_CONDITION}" <<<"$OUT"
expect "only this repository (not the whole pool) may act as the deployer" grep -qF -- "--member ${GOOD_MEMBER}" <<<"$OUT"
expect "deployer gets exactly run.developer at project level" bash -c "[ \$(grep 'projects add-iam-policy-binding' <<<\"\$1\" | grep -c 'serviceAccount:deployer@') = 1 ] && grep 'projects add-iam-policy-binding' <<<\"\$1\" | grep 'serviceAccount:deployer@' | grep -q -- '--role roles/run.developer'" _ "$OUT"
expect "the API account gets exactly firebaseauth.viewer at project level (reads Firebase users for the revocation check)" bash -c "[ \$(grep 'projects add-iam-policy-binding' <<<\"\$1\" | grep -c 'serviceAccount:api-runtime@') = 1 ] && grep 'projects add-iam-policy-binding' <<<\"\$1\" | grep 'serviceAccount:api-runtime@' | grep -q -- '--role roles/firebaseauth.viewer'" _ "$OUT"
expect "no secret is bound while none exists, and the script says so" bash -c "! grep -q 'secrets add-iam-policy-binding' <<<\"\$1\" && grep -q 'skip     secret PAYU_KEY' <<<\"\$1\"" _ "$OUT"
expect "enables the APIs workload identity needs (sts, iamcredentials) first" bash -c "grep -q 'services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com' <<<\"\$1\"" _ "$OUT"
expect "the deploy is limited to the manual (workflow_dispatch) event" grep -qF "assertion.event_name == 'workflow_dispatch'" <<<"$OUT"
expect "warns that the trust is pinned by name only while no repository id is set" grep -q 'WARN' <<<"$OUT"
expect "prints the identifiers the GitHub environment needs" grep -q 'GCP_WORKLOAD_IDENTITY_PROVIDER   = projects/123456789012' <<<"$OUT"

echo "== apply, re-run, secrets =="
reset; export STUB_POOL=yes STUB_PROVIDER=yes STUB_SECRETS="PAYU_KEY DATABASE_URL"
OUT="$(bash "$SCRIPT" 2>&1)"; CODE=$?
expect "apply exits 0" test "$CODE" = 0
expect "second run updates the provider instead of failing or creating a duplicate" bash -c "grep -q 'update-oidc' '$STUB_LOG' && ! grep -q 'workload-identity-pools create' '$STUB_LOG' && ! grep -q 'providers create-oidc' '$STUB_LOG'"
expect "changes really reach gcloud when applying" test -n "$(changes)"
expect "only the secrets that exist get a binding (2 of 4)" test "$(grep -c 'secrets add-iam-policy-binding' "$STUB_LOG")" = 2
expect "PAYU_SALT (missing) is skipped with a message" grep -q 'skip     secret PAYU_SALT' <<<"$OUT"
expect "each secret binding gives read access to api-runtime and to nobody else" bash -c "grep -c 'secrets add-iam-policy-binding' '$STUB_LOG' | grep -q '^2$' && ! grep 'secrets add-iam-policy-binding' '$STUB_LOG' | grep -v -- '--member serviceAccount:api-runtime@ease-disease-staging.iam.gserviceaccount.com' | grep -q ." 

echo "== stale trust and settings =="
reset; export STUB_POOL=yes STUB_PROVIDER=yes STUB_WIF_MEMBERS="principalSet://iam.googleapis.com/${POOL}/attribute.repository/old-owner/old-name"
bash "$SCRIPT" >/dev/null 2>&1
expect "an old repository trust is removed when the repository changes" grep -q "remove-iam-policy-binding deployer@.* --member principalSet://.*old-owner/old-name" "$STUB_LOG"
reset; export STUB_POOL=yes STUB_PROVIDER=yes STUB_WIF_MEMBERS="$GOOD_MEMBER"
bash "$SCRIPT" >/dev/null 2>&1
expect "the current trust is not removed" bash -c "! grep -q 'remove-iam-policy-binding' '$STUB_LOG'"
reset
OUT="$(GITHUB_REPOSITORY=evil/repo bash "$SCRIPT" --dry-run 2>&1)"
expect "an exported GITHUB_REPOSITORY cannot change who is trusted" bash -c "grep -qF 'attribute.repository/Vivek7083/ease-disease-backend' <<<\"\$1\" && ! grep -q 'evil/repo' <<<\"\$1\"" _ "$OUT"
sed 's/^GITHUB_REPOSITORY_ID=""/GITHUB_REPOSITORY_ID="987654"/' "$SCRIPT" >"$WORK/pinned.sh"
OUT="$(bash "$WORK/pinned.sh" --dry-run 2>&1)"
expect "with a repository id set, the condition and the trust use the id" bash -c "grep -qF \"assertion.repository_id == '987654'\" <<<\"\$1\" && grep -qF 'attribute.repository_id/987654' <<<\"\$1\" && ! grep -q WARN <<<\"\$1\"" _ "$OUT"
expect "with a repository id set, the provider maps the id claim (otherwise the trust matches nobody)" grep -qF 'attribute.repository_id=assertion.repository_id' <<<"$OUT"
OUT="$(bash "$SCRIPT" --help 2>&1)"
expect "--help prints the usage comment only (not code)" bash -c "! grep -q 'set -euo' <<<\"\$1\" && grep -q 'dry-run' <<<\"\$1\"" _ "$OUT"

echo "== guards =="
reset; export STUB_PROJECT=some-other-project
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"; CODE=$?
expect "refuses another active project (exit 2)" test "$CODE" = 2
expect "...and says so" grep -q "Refusing to run" <<<"$OUT"
expect "...and made no change" test -z "$(changes)"
reset; export STUB_BILLING=False
bash "$SCRIPT" --dry-run >/dev/null 2>&1; CODE=$?
expect "refuses when billing is off (exit 2)" test "$CODE" = 2
reset; export STUB_BILLING_FAIL=1
OUT="$(bash "$SCRIPT" --dry-run 2>&1)"; CODE=$?
expect "an unreadable billing state is reported as such, not as billing off (exit 2)" bash -c "[ $CODE = 2 ] && grep -q 'could not read the billing state' <<<\"\$1\" && ! grep -q 'billing is not enabled' <<<\"\$1\"" _ "$OUT"
reset
bash "$SCRIPT" --bogus >/dev/null 2>&1; CODE=$?
expect "rejects an unknown option (exit 2)" test "$CODE" = 2

echo "== verify =="
good_env() {
  reset; export STUB_PROVIDER=yes STUB_SECRETS="PAYU_KEY PAYU_SALT DATABASE_URL" STUB_CONDITION="$GOOD_CONDITION" STUB_KEYS="" \
    STUB_WIF_MEMBERS="$GOOD_MEMBER" STUB_ROLES_DEPLOYER="roles/run.developer" STUB_ROLES_RUNTIME="roles/firebaseauth.viewer" STUB_ROLES_SCHEDULER="" \
    STUB_SECRET_ACCESSORS="serviceAccount:api-runtime@ease-disease-staging.iam.gserviceaccount.com" \
    STUB_AR_WRITERS="$DEPLOYER_SA" STUB_RUNTIME_USERS="$DEPLOYER_SA" STUB_PROJECT_SECRET_READERS=""
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
good_env; export STUB_ROLES_RUNTIME=$'roles/firebaseauth.viewer\nroles/editor'; verify_fails "any extra project role on the runtime account is flagged"
good_env; export STUB_ROLES_RUNTIME=""; verify_fails "a runtime account without the Firebase Authentication read role is flagged (checkout would fail)"
good_env; export STUB_CONDITION="assertion.repository == '${REPO}'"; verify_fails "a provider that trusts any branch is flagged"
good_env; export STUB_CONDITION=""; verify_fails "a provider with no condition is flagged"
good_env; export STUB_WIF_MEMBERS="principalSet://iam.googleapis.com/${POOL}/*"; verify_fails "letting the whole pool act as the deployer is flagged"
good_env; export STUB_SECRET_ACCESSORS=$'serviceAccount:api-runtime@ease-disease-staging.iam.gserviceaccount.com\nserviceAccount:deployer@ease-disease-staging.iam.gserviceaccount.com'
verify_fails "a second reader of a secret is flagged"
good_env; unset STUB_PROVIDER; verify_fails "a missing provider is flagged"
good_env; export STUB_CONDITION="assertion.repository == '${REPO}' && assertion.ref == 'refs/heads/develop'"; verify_fails "a provider that trusts any workflow event is flagged"
good_env; export STUB_AR_WRITERS=$'serviceAccount:deployer@ease-disease-staging.iam.gserviceaccount.com\nuser:someone@example.com'; verify_fails "a second image writer is flagged"
good_env; unset STUB_AR_WRITERS; verify_fails "a deployer without image-push rights is flagged"
good_env; export STUB_RUNTIME_USERS=$'serviceAccount:deployer@ease-disease-staging.iam.gserviceaccount.com\nuser:someone@example.com'; verify_fails "a second person who can act as api-runtime is flagged"
good_env; export STUB_PROJECT_SECRET_READERS="serviceAccount:api-runtime@ease-disease-staging.iam.gserviceaccount.com"; verify_fails "secretAccessor granted project-wide is flagged"
good_env; export STUB_SERVICES="iam.googleapis.com run.googleapis.com"; verify_fails "a missing API (sts) is flagged"
good_env
OUT="$(STUB_FAIL_ON="projects get-iam-policy" bash "$SCRIPT" --verify 2>&1)"; CODE=$?
expect "a failing read is reported and the report still finishes (exit 1, not a silent stop)" bash -c "[ $CODE = 1 ] && grep -q 'could not read' <<<\"\$1\" && grep -q 'verify: ' <<<\"\$1\"" _ "$OUT"
good_env
OUT="$(bash "$SCRIPT" --verify 2>&1)"
expect "a clean setup still warns that the trust is pinned by name only" grep -q 'WARN' <<<"$OUT"

echo "== the script file itself =="
expect "never creates a service account key" bash -c "! grep -qE 'keys create|--key-file|GOOGLE_APPLICATION_CREDENTIALS' '$SCRIPT'"
expect "never grants owner, editor or admin roles" bash -c "! grep -qE 'roles/(owner|editor)|Admin' '$SCRIPT'"
expect "passes shellcheck-style strict mode" grep -q '^set -euo pipefail' "$SCRIPT"

echo
[ "$FAILED" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
