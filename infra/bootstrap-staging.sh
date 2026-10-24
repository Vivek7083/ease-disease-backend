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
# The one repository allowed to deploy (change it here when the repository moves to the owners' GitHub account).
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-Vivek7083/ease-disease-backend}"
# The one branch allowed to deploy to this project.
ALLOWED_REF="refs/heads/develop"
POOL_ID="github-pool"
PROVIDER_ID="github-provider"
AR_REPO="api"
SECRETS=(PAYU_KEY PAYU_SALT DATABASE_URL)
# -----------------------------------------------------------------------------------------------------------------------

DEPLOYER="deployer@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER="scheduler-tick@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_PROJECT_ROLES="roles/run.developer"

MODE="apply"
for argument in "$@"; do
  case "$argument" in
    --dry-run) MODE="dry-run" ;;
    --verify) MODE="verify" ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $argument" >&2; exit 2 ;;
  esac
done

problems=0
note() { echo "$*"; }
problem() { echo "PROBLEM  $*"; problems=$((problems + 1)); }
# Every command that CHANGES something goes through run: printed in dry-run, executed otherwise.
run() {
  if [ "$MODE" = "dry-run" ]; then echo "+ $*"; else echo "+ $1 $2 $3 ..."; "$@"; fi
}

# ---- guards ---------------------------------------------------------------------------------------------------------
active="$(gcloud config get-value project 2>/dev/null || true)"
if [ "$active" != "$PROJECT_ID" ]; then
  echo "Refusing to run: the active project is '${active}', this script is only for '${PROJECT_ID}'." >&2
  echo "Fix with: gcloud config set project ${PROJECT_ID}" >&2
  exit 2
fi
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]; then
  echo "Refusing to run: billing is not enabled on ${PROJECT_ID}." >&2
  exit 2
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"
REPO_MEMBER="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${GITHUB_REPOSITORY}"
CONDITION="assertion.repository == '${GITHUB_REPOSITORY}' && assertion.ref == '${ALLOWED_REF}'"

for account in "$DEPLOYER" "$RUNTIME" "$SCHEDULER"; do
  gcloud iam service-accounts describe "$account" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || { echo "Service account ${account} does not exist yet: create it first (runbook step 3.6)." >&2; exit 2; }
done
gcloud artifacts repositories describe "$AR_REPO" --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1 \
  || { echo "Artifact Registry repository '${AR_REPO}' does not exist in ${REGION} yet (runbook step 3.5)." >&2; exit 2; }

# ---- verify (read only) ---------------------------------------------------------------------------------------------
verify() {
  note "== verify ${PROJECT_ID} =="
  for account in "$DEPLOYER" "$RUNTIME" "$SCHEDULER"; do
    keys="$(gcloud iam service-accounts keys list --iam-account "$account" --managed-by user --format='value(name)')"
    [ -z "$keys" ] && note "ok       no downloaded key on ${account%%@*}" || problem "${account%%@*} has a downloaded key (delete it; keyless access is the rule)"
  done

  if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project "$PROJECT_ID" --location global \
    --workload-identity-pool "$POOL_ID" >/dev/null 2>&1; then
    have="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project "$PROJECT_ID" --location global \
      --workload-identity-pool "$POOL_ID" --format='value(attributeCondition)')"
    [ "$have" = "$CONDITION" ] && note "ok       provider only trusts ${GITHUB_REPOSITORY} on ${ALLOWED_REF}" \
      || problem "provider condition is '${have}', expected '${CONDITION}'"
  else
    problem "workload identity provider ${PROVIDER_ID} does not exist"
  fi

  members="$(gcloud iam service-accounts get-iam-policy "$DEPLOYER" --project "$PROJECT_ID" \
    --flatten='bindings[].members' --filter='bindings.role=roles/iam.workloadIdentityUser' --format='value(bindings.members)')"
  [ "$members" = "$REPO_MEMBER" ] && note "ok       only this repository may act as the deployer" \
    || problem "who may act as the deployer: '${members}', expected only '${REPO_MEMBER}'"

  for entry in "deployer:${DEPLOYER}:${DEPLOYER_PROJECT_ROLES}" "api-runtime:${RUNTIME}:" "scheduler-tick:${SCHEDULER}:"; do
    name="${entry%%:*}"; rest="${entry#*:}"; account="${rest%%:*}"; expected="${rest#*:}"
    roles="$(gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
      --filter="bindings.members=serviceAccount:${account}" --format='value(bindings.role)' | sort | tr '\n' ' ' | sed 's/ $//')"
    [ "$roles" = "$expected" ] && note "ok       ${name} project roles: '${roles}'" || problem "${name} project roles are '${roles}', expected '${expected}'"
  done

  for secret in "${SECRETS[@]}"; do
    if gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1; then
      accessors="$(gcloud secrets get-iam-policy "$secret" --project "$PROJECT_ID" --flatten='bindings[].members' \
        --filter='bindings.role=roles/secretmanager.secretAccessor' --format='value(bindings.members)' | sort | tr '\n' ' ' | sed 's/ $//')"
      [ "$accessors" = "serviceAccount:${RUNTIME}" ] && note "ok       ${secret} readable only by api-runtime" \
        || problem "${secret} accessors are '${accessors}', expected only 'serviceAccount:${RUNTIME}'"
    else
      note "pending  secret ${secret} is not created yet"
    fi
  done
  [ "$problems" -eq 0 ] && note "verify: all good" || note "verify: ${problems} problem(s)"
  [ "$problems" -eq 0 ]
}

if [ "$MODE" = "verify" ]; then verify; exit $?; fi

# ---- apply ----------------------------------------------------------------------------------------------------------
note "== ${MODE}: ${PROJECT_ID} (${PROJECT_NUMBER}), repository ${GITHUB_REPOSITORY}, branch ${ALLOWED_REF} =="

if ! gcloud iam workload-identity-pools describe "$POOL_ID" --project "$PROJECT_ID" --location global >/dev/null 2>&1; then
  run gcloud iam workload-identity-pools create "$POOL_ID" --project "$PROJECT_ID" --location global --display-name "GitHub Actions"
fi

provider_args=(--project "$PROJECT_ID" --location global --workload-identity-pool "$POOL_ID"
  --display-name "GitHub" --issuer-uri "https://token.actions.githubusercontent.com"
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
  --attribute-condition "$CONDITION")
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project "$PROJECT_ID" --location global \
  --workload-identity-pool "$POOL_ID" >/dev/null 2>&1; then
  run gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" "${provider_args[@]}"
else
  run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" "${provider_args[@]}"
fi

# Only this repository (not the whole pool) may act as the deployer.
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser --member "$REPO_MEMBER"

# The deployer: push images to the one repository, manage Cloud Run, and act as the runtime account (and only that one).
run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --project "$PROJECT_ID" --location "$REGION" \
  --role roles/artifactregistry.writer --member "serviceAccount:${DEPLOYER}"
run gcloud projects add-iam-policy-binding "$PROJECT_ID" --role "$DEPLOYER_PROJECT_ROLES" \
  --member "serviceAccount:${DEPLOYER}" --condition=None
run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --project "$PROJECT_ID" \
  --role roles/iam.serviceAccountUser --member "serviceAccount:${DEPLOYER}"

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
[ "$MODE" = "dry-run" ] && note "(dry run: nothing was changed)"
exit 0
