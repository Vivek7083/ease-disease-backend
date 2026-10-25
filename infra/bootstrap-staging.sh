#!/usr/bin/env bash
# One-time (and safely re-runnable) Google Cloud setup for the UAT ("staging") project: lets GitHub Actions deploy
# WITHOUT any downloaded key (Workload Identity Federation), and gives each service account only the roles it needs.
#
# Run it in Google Cloud Shell (gcloud is already there), signed in as the project owner:
#   bash infra/bootstrap-staging.sh --dry-run    prints every change it would make, changes nothing
#   bash infra/bootstrap-staging.sh              makes the changes
#   bash infra/bootstrap-staging.sh --verify     read-only report; exit 1 if anything is missing or too broad
#
# It never prints a secret, never creates a service account key, and refuses to touch any project other than PROJECT_ID.
set -euo pipefail

# ---- settings (the only things to edit) -------------------------------------------------------------------------------
PROJECT_ID="ease-disease-staging"
REGION="asia-south1"
# The one repository allowed to deploy (edit here when the repository moves to the owners' GitHub account, then re-run:
# the old trust is removed by the apply step). Deliberately NOT read from the environment.
GITHUB_REPOSITORY="Vivek7083/ease-disease-backend"
# GitHub's numeric id of that repository (a name can be reclaimed after a rename or move; the id cannot). Get it once from a
# workflow run (it prints github.repository_id) or from the GitHub API. Empty = trust is pinned by name only (verify warns).
GITHUB_REPOSITORY_ID="1428738784"
# The one branch and the one event allowed to deploy to this project (the deploy is a manual button on develop).
ALLOWED_REF="refs/heads/develop"
ALLOWED_EVENT="workflow_dispatch"
POOL_ID="github-pool"
PROVIDER_ID="github-provider"
AR_REPO="api"
# DATABASE_URL: pooled address for the API; DATABASE_URL_DIRECT: direct address for the migration job.
SECRETS=(PAYU_KEY PAYU_SALT DATABASE_URL DATABASE_URL_DIRECT)
# APIs the keyless deploy and the runtime need (sts and iamcredentials are what Workload Identity Federation uses).
APIS=(iam iamcredentials sts run artifactregistry secretmanager cloudscheduler)
# -----------------------------------------------------------------------------------------------------------------------

DEPLOYER="deployer@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER="scheduler-tick@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_PROJECT_ROLES="roles/run.developer"
# On the money route the API checks that an account was not disabled or signed out (a Firebase Authentication lookup), so
# its own account may READ Firebase Authentication users. Nothing else at project level.
RUNTIME_PROJECT_ROLES="roles/firebaseauth.viewer"

MODE="apply"
for argument in "$@"; do
  case "$argument" in
    --dry-run) MODE="dry-run" ;;
    --verify) MODE="verify" ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $argument" >&2; exit 2 ;;
  esac
done

problems=0
note() { echo "$*"; }
problem() { echo "PROBLEM  $*"; problems=$((problems + 1)); }
warn() { echo "WARN     $*"; }
# Every command that CHANGES something goes through run: printed in dry-run, executed otherwise.
run() {
  if [ "$MODE" = "dry-run" ]; then echo "+ $*"; else echo "+ $1 $2 $3 ..."; "$@"; fi
}
# A read-only query whose failure is reported as a problem instead of ending the script half way (set -e).
# Usage: query_into VARIABLE "what is being read" gcloud ...   (not run in a subshell, so the problem count is kept)
query_into() {
  local __var="$1" __label="$2" __out
  shift 2
  if __out="$("$@" 2>/dev/null)"; then
    printf -v "$__var" '%s' "$__out"
  else
    printf -v "$__var" '%s' ""
    problem "could not read ${__label} (missing permission or API?)"
  fi
}
# Lines sorted and joined by one space, for comparing lists.
joined() { printf '%s\n' "$1" | sed '/^$/d' | sort | tr '\n' ' ' | sed 's/ $//'; }

# ---- guards ---------------------------------------------------------------------------------------------------------
active="$(gcloud config get-value project 2>/dev/null || true)"
if [ "$active" != "$PROJECT_ID" ]; then
  echo "Refusing to run: the active project is '${active}', this script is only for '${PROJECT_ID}'." >&2
  echo "Fix with: gcloud config set project ${PROJECT_ID}" >&2
  exit 2
fi
if ! billing="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)"; then
  echo "Refusing to run: could not read the billing state of ${PROJECT_ID} (missing permission, or the Cloud Billing API is off)." >&2
  exit 2
fi
if [ "$billing" != "True" ]; then
  echo "Refusing to run: billing is not enabled on ${PROJECT_ID}." >&2
  exit 2
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"
CONDITION="assertion.repository == '${GITHUB_REPOSITORY}' && assertion.ref == '${ALLOWED_REF}' && assertion.event_name == '${ALLOWED_EVENT}'"
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
if [ -n "$GITHUB_REPOSITORY_ID" ]; then
  CONDITION="assertion.repository_id == '${GITHUB_REPOSITORY_ID}' && ${CONDITION}"
  MAPPING="${MAPPING},attribute.repository_id=assertion.repository_id"
  REPO_MEMBER="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository_id/${GITHUB_REPOSITORY_ID}"
else
  REPO_MEMBER="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${GITHUB_REPOSITORY}"
fi

for account in "$DEPLOYER" "$RUNTIME" "$SCHEDULER"; do
  gcloud iam service-accounts describe "$account" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || { echo "Service account ${account} does not exist yet: create it first (runbook step 3.6)." >&2; exit 2; }
done
gcloud artifacts repositories describe "$AR_REPO" --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1 \
  || { echo "Artifact Registry repository '${AR_REPO}' does not exist in ${REGION} yet (runbook step 3.5)." >&2; exit 2; }

# ---- verify (read only) ---------------------------------------------------------------------------------------------
# query_into assigns the variables below indirectly (printf -v), which shellcheck cannot see.
# shellcheck disable=SC2154
verify() {
  note "== verify ${PROJECT_ID} =="

  query_into enabled "the enabled APIs" gcloud services list --enabled --project "$PROJECT_ID" --format='value(config.name)'
  for api in "${APIS[@]}"; do
    case $'\n'"$enabled"$'\n' in *$'\n'"${api}.googleapis.com"$'\n'*) note "ok       API ${api} is enabled" ;; *) problem "API ${api}.googleapis.com is not enabled" ;; esac
  done

  for account in "$DEPLOYER" "$RUNTIME" "$SCHEDULER"; do
    query_into keys "the keys of ${account%%@*}" gcloud iam service-accounts keys list --iam-account "$account" --managed-by user --format='value(name)'
    [ -z "$keys" ] && note "ok       no downloaded key on ${account%%@*}" || problem "${account%%@*} has a downloaded key (delete it; keyless access is the rule)"
  done

  if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project "$PROJECT_ID" --location global \
    --workload-identity-pool "$POOL_ID" >/dev/null 2>&1; then
    query_into have "the provider condition" gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project "$PROJECT_ID" \
      --location global --workload-identity-pool "$POOL_ID" --format='value(attributeCondition)'
    if [ "$have" = "$CONDITION" ]; then
      note "ok       provider only trusts ${GITHUB_REPOSITORY} on ${ALLOWED_REF} for ${ALLOWED_EVENT}"
    else
      problem "provider condition is '${have}', expected '${CONDITION}'"
    fi
  else
    problem "workload identity provider ${PROVIDER_ID} does not exist"
  fi
  [ -n "$GITHUB_REPOSITORY_ID" ] || warn "the trust is pinned by repository NAME only; set GITHUB_REPOSITORY_ID (a renamed or moved repository can be reclaimed by name)"

  query_into members "who may act as the deployer" gcloud iam service-accounts get-iam-policy "$DEPLOYER" --project "$PROJECT_ID" \
    --flatten='bindings[].members' --filter='bindings.role=roles/iam.workloadIdentityUser' --format='value(bindings.members)'
  if [ "$(joined "$members")" = "$REPO_MEMBER" ]; then
    note "ok       only this repository may act as the deployer"
  else
    problem "who may act as the deployer: '$(joined "$members")', expected only '${REPO_MEMBER}'"
  fi

  for entry in "deployer:${DEPLOYER}:${DEPLOYER_PROJECT_ROLES}" "api-runtime:${RUNTIME}:${RUNTIME_PROJECT_ROLES}" "scheduler-tick:${SCHEDULER}:"; do
    name="${entry%%:*}"; rest="${entry#*:}"; account="${rest%%:*}"; expected="${rest#*:}"
    query_into roles "the project roles of ${name}" gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
      --filter="bindings.members=serviceAccount:${account}" --format='value(bindings.role)'
    if [ "$(joined "$roles")" = "$expected" ]; then
      note "ok       ${name} project roles: '$(joined "$roles")'"
    else
      problem "${name} project roles are '$(joined "$roles")', expected '${expected}'"
    fi
  done

  query_into writers "who may push to the ${AR_REPO} repository" gcloud artifacts repositories get-iam-policy "$AR_REPO" --project "$PROJECT_ID" \
    --location "$REGION" --flatten='bindings[].members' --filter='bindings.role=roles/artifactregistry.writer' --format='value(bindings.members)'
  if [ "$(joined "$writers")" = "serviceAccount:${DEPLOYER}" ]; then
    note "ok       only the deployer may push images"
  else
    problem "image writers are '$(joined "$writers")', expected only 'serviceAccount:${DEPLOYER}'"
  fi

  query_into acting "who may act as api-runtime" gcloud iam service-accounts get-iam-policy "$RUNTIME" --project "$PROJECT_ID" \
    --flatten='bindings[].members' --filter='bindings.role=roles/iam.serviceAccountUser' --format='value(bindings.members)'
  if [ "$(joined "$acting")" = "serviceAccount:${DEPLOYER}" ]; then
    note "ok       only the deployer may act as api-runtime"
  else
    problem "who may act as api-runtime: '$(joined "$acting")', expected only 'serviceAccount:${DEPLOYER}'"
  fi

  query_into wide "project-wide secret readers" gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
    --filter='bindings.role=roles/secretmanager.secretAccessor' --format='value(bindings.members)'
  [ -z "$wide" ] && note "ok       nobody can read every secret in the project" || problem "secretAccessor is granted project-wide to: $(joined "$wide") (grant it per secret)"

  for secret in "${SECRETS[@]}"; do
    if gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1; then
      query_into accessors "the readers of ${secret}" gcloud secrets get-iam-policy "$secret" --project "$PROJECT_ID" --flatten='bindings[].members' \
        --filter='bindings.role=roles/secretmanager.secretAccessor' --format='value(bindings.members)'
      if [ "$(joined "$accessors")" = "serviceAccount:${RUNTIME}" ]; then
        note "ok       ${secret} readable only by api-runtime"
      else
        problem "${secret} accessors are '$(joined "$accessors")', expected only 'serviceAccount:${RUNTIME}'"
      fi
    else
      note "pending  secret ${secret} is not created yet"
    fi
  done
  if [ "$problems" -eq 0 ]; then note "verify: all good"; else note "verify: ${problems} problem(s)"; fi
  [ "$problems" -eq 0 ]
}

if [ "$MODE" = "verify" ]; then verify; exit $?; fi

# ---- apply ----------------------------------------------------------------------------------------------------------
note "== ${MODE}: ${PROJECT_ID} (${PROJECT_NUMBER}), repository ${GITHUB_REPOSITORY}, branch ${ALLOWED_REF}, event ${ALLOWED_EVENT} =="
[ -n "$GITHUB_REPOSITORY_ID" ] || warn "GITHUB_REPOSITORY_ID is empty: the trust is pinned by repository name only"

api_list=()
for api in "${APIS[@]}"; do api_list+=("${api}.googleapis.com"); done
run gcloud services enable "${api_list[@]}" --project "$PROJECT_ID"

if ! gcloud iam workload-identity-pools describe "$POOL_ID" --project "$PROJECT_ID" --location global >/dev/null 2>&1; then
  run gcloud iam workload-identity-pools create "$POOL_ID" --project "$PROJECT_ID" --location global --display-name "GitHub Actions"
fi

provider_args=(--project "$PROJECT_ID" --location global --workload-identity-pool "$POOL_ID"
  --display-name "GitHub" --issuer-uri "https://token.actions.githubusercontent.com"
  --attribute-mapping "$MAPPING"
  --attribute-condition "$CONDITION")
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project "$PROJECT_ID" --location global \
  --workload-identity-pool "$POOL_ID" >/dev/null 2>&1; then
  run gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" "${provider_args[@]}"
else
  run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" "${provider_args[@]}"
fi

# Only this repository (not the whole pool) may act as the deployer; any older trust (an old repository name) is removed.
existing="$(gcloud iam service-accounts get-iam-policy "$DEPLOYER" --project "$PROJECT_ID" --flatten='bindings[].members' \
  --filter='bindings.role=roles/iam.workloadIdentityUser' --format='value(bindings.members)' 2>/dev/null || true)"
for member in $existing; do
  if [ "$member" != "$REPO_MEMBER" ]; then
    run gcloud iam service-accounts remove-iam-policy-binding "$DEPLOYER" --project "$PROJECT_ID" \
      --role roles/iam.workloadIdentityUser --member "$member"
  fi
done
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser --member "$REPO_MEMBER"

# The deployer: push images to the one repository, manage Cloud Run, and act as the runtime account (and only that one).
run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --project "$PROJECT_ID" --location "$REGION" \
  --role roles/artifactregistry.writer --member "serviceAccount:${DEPLOYER}"
run gcloud projects add-iam-policy-binding "$PROJECT_ID" --role "$DEPLOYER_PROJECT_ROLES" \
  --member "serviceAccount:${DEPLOYER}" --condition=None
run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --project "$PROJECT_ID" \
  --role roles/iam.serviceAccountUser --member "serviceAccount:${DEPLOYER}"

# The runtime account: read Firebase Authentication users (the revocation check), and nothing else at project level.
run gcloud projects add-iam-policy-binding "$PROJECT_ID" --role "$RUNTIME_PROJECT_ROLES" \
  --member "serviceAccount:${RUNTIME}" --condition=None

# The runtime account reads exactly the named secrets and nothing else.
for secret in "${SECRETS[@]}"; do
  if gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud secrets add-iam-policy-binding "$secret" --project "$PROJECT_ID" \
      --role roles/secretmanager.secretAccessor --member "serviceAccount:${RUNTIME}"
  else
    note "skip     secret ${secret} does not exist yet: create it, then run this script again"
  fi
done

note ""
note "GitHub Environment 'staging' needs these identifiers (they are not secrets):"
note "  GCP_PROJECT_ID                   = ${PROJECT_ID}"
note "  GCP_REGION                       = ${REGION}"
note "  GCP_WORKLOAD_IDENTITY_PROVIDER   = ${PROVIDER_NAME}"
note "  GCP_DEPLOYER_SERVICE_ACCOUNT     = ${DEPLOYER}"
note "  GCP_RUNTIME_SERVICE_ACCOUNT      = ${RUNTIME}"
note "  GCP_ARTIFACT_REPOSITORY          = ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
if [ "$MODE" = "dry-run" ]; then note "(dry run: nothing was changed)"; else note "Next: bash infra/bootstrap-staging.sh --verify (permission changes can take a minute to show)"; fi
exit 0
