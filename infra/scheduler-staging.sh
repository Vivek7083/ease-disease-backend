#!/usr/bin/env bash
# Creates (or updates) the Cloud Scheduler job that calls the API's housekeeping endpoint every five minutes in the UAT
# ("staging") project. The call carries a Google-signed token for the `scheduler-tick` account; the API accepts it only
# when the token's audience and account match its TICK_AUDIENCE and TICK_SERVICE_ACCOUNT_EMAIL settings.
#
#   bash infra/scheduler-staging.sh --dry-run    prints the change, changes nothing
#   bash infra/scheduler-staging.sh              creates or updates the job
#   bash infra/scheduler-staging.sh --verify     read-only report; exit 1 if the job differs from what the API expects
#
# Needs the same two settings as the deploy: API_PUBLIC_URL and TICK_AUDIENCE (the audience must be exactly what the API has).
# Run it in Cloud Shell as the project owner, after the API is deployed. Then run the job once by hand to see it work:
#   gcloud scheduler jobs run tick --location asia-south1 --project ease-disease-staging
set -euo pipefail

PROJECT_ID="ease-disease-staging"
REGION="asia-south1"
JOB="tick"
SCHEDULE="*/5 * * * *"
SCHEDULER="scheduler-tick@${PROJECT_ID}.iam.gserviceaccount.com"

MODE="apply"
for argument in "$@"; do
  case "$argument" in
    --dry-run) MODE="dry-run" ;;
    --verify) MODE="verify" ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $argument" >&2; exit 2 ;;
  esac
done

active="$(gcloud config get-value project 2>/dev/null || true)"
if [ "$active" != "$PROJECT_ID" ]; then
  echo "Refusing to run: the active project is '${active}', this script is only for '${PROJECT_ID}'." >&2
  exit 2
fi
for name in API_PUBLIC_URL TICK_AUDIENCE; do
  value="${!name:-}"
  case "$value" in https://*) ;; *) echo "Refusing to run: ${name} must be set and start with https://" >&2; exit 2 ;; esac
done
URI="${API_PUBLIC_URL%/}/v1/internal/tick"
AUDIENCE="${TICK_AUDIENCE%/}"

problems=0
problem() { echo "PROBLEM  $*"; problems=$((problems + 1)); }

verify() {
  echo "== verify job ${JOB} in ${PROJECT_ID} =="
  if ! gcloud scheduler jobs describe "$JOB" --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
    problem "the job ${JOB} does not exist"
    return 1
  fi
  local field value
  check() { # check "label" "format expression" "expected"
    if ! value="$(gcloud scheduler jobs describe "$JOB" --project "$PROJECT_ID" --location "$REGION" --format="value($2)" 2>/dev/null)"; then
      problem "could not read $1"
    elif [ "$value" = "$3" ]; then
      echo "ok       $1: $value"
    else
      problem "$1 is '${value}', expected '$3'"
    fi
  }
  check "state" "state" "ENABLED"
  check "schedule" "schedule" "$SCHEDULE"
  check "address" "httpTarget.uri" "$URI"
  check "method" "httpTarget.httpMethod" "POST"
  check "signing account" "httpTarget.oidcToken.serviceAccountEmail" "$SCHEDULER"
  check "token audience" "httpTarget.oidcToken.audience" "$AUDIENCE"
  check "no other credential (OAuth token)" "httpTarget.oauthToken.serviceAccountEmail" ""
  field="$(gcloud scheduler jobs describe "$JOB" --project "$PROJECT_ID" --location "$REGION" --format='value(attemptDeadline)' 2>/dev/null || true)"
  echo "info     attempt deadline: ${field:-unknown}"
  if [ "$problems" -eq 0 ]; then echo "verify: all good"; else echo "verify: ${problems} problem(s)"; fi
  [ "$problems" -eq 0 ]
}

if [ "$MODE" = "verify" ]; then verify; exit $?; fi

if gcloud scheduler jobs describe "$JOB" --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then verb="update"; else verb="create"; fi
args=(scheduler jobs "$verb" http "$JOB" --project "$PROJECT_ID" --location "$REGION" --schedule "$SCHEDULE" --time-zone "Etc/UTC"
  --uri "$URI" --http-method POST --oidc-service-account-email "$SCHEDULER" --oidc-token-audience "$AUDIENCE"
  --attempt-deadline 60s --max-retry-attempts 2 --min-backoff 10s --max-backoff 60s)
echo "== ${MODE}: ${verb} job ${JOB}: every five minutes, POST ${URI}, signed as ${SCHEDULER%%@*} =="
if [ "$MODE" = "dry-run" ]; then
  echo "+ gcloud ${args[*]}"
  echo "(dry run: nothing was changed)"
else
  gcloud "${args[@]}"
  echo "Next: bash infra/scheduler-staging.sh --verify, then run it once: gcloud scheduler jobs run ${JOB} --location ${REGION} --project ${PROJECT_ID}"
fi
exit 0
