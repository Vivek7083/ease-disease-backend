#!/usr/bin/env bash
# Deploys one already-built image tag to the UAT ("staging") project, safely:
#   1. runs the database migration as a Cloud Run Job and waits; a failed migration stops everything (service untouched)
#   2. starts the new version WITHOUT user traffic, on its own tagged address
#   3. checks that address (health with database, package list, login required, no dev routes, browser access rules)
#   4. only if every check passed, sends all traffic to it; if the check after the switch fails, goes back to the old version
# A failed check leaves the old version serving and exits 1.
#
#   bash infra/deploy-staging.sh --dry-run <image-tag>   prints every change, changes nothing
#   bash infra/deploy-staging.sh <image-tag>             deploys
#
# <image-tag> is the tag used for the images `api:<tag>` and `api:<tag>-migrate` in Artifact Registry (the commit hash).
# Settings arrive as environment variables (the workflow passes them from the GitHub environment variables):
#   FIREBASE_PROJECT_ID FRONTEND_BASE_URL API_PUBLIC_URL TICK_AUDIENCE TICK_SERVICE_ACCOUNT_EMAIL
#   TRUST_PROXY_HOPS (default 0)   CORS_EXTRA_ORIGINS (optional, comma separated)
# Who may call the service (the invoker check) is NOT set here: the deployer cannot change it. The project owner sets it once
# when creating the service (see the deployment runbook); later deploys keep it.
# Secrets are never passed in: they are Secret Manager references. This script never prints a secret.
set -euo pipefail

# ---- settings -------------------------------------------------------------------------------------------------------
PROJECT_ID="ease-disease-staging"
REGION="asia-south1"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/api"
SERVICE="api"
JOB="api-migrate"
RUNTIME="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SLEEP_SECONDS="${SLEEP_SECONDS:-5}"
CHECK_ATTEMPTS="${CHECK_ATTEMPTS:-12}"
# ---------------------------------------------------------------------------------------------------------------------

MODE="apply"
TAG=""
for argument in "$@"; do
  case "$argument" in
    --dry-run) MODE="dry-run" ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "unknown option: $argument" >&2; exit 2 ;;
    *) [ -z "$TAG" ] && TAG="$argument" || { echo "only one image tag is allowed" >&2; exit 2; } ;;
  esac
done
if ! [[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$ ]]; then
  echo "Usage: infra/deploy-staging.sh [--dry-run] <image-tag>   (the tag, usually a commit hash, is missing or malformed)" >&2
  exit 2
fi

note() { echo "$*"; }
fail() { echo "FAILED  $*" >&2; exit 1; }
run() {
  if [ "$MODE" = "dry-run" ]; then echo "+ $*"; else echo "+ $1 $2 $3 $4 ..."; "$@"; fi
}

# ---- guards ---------------------------------------------------------------------------------------------------------
active="$(gcloud config get-value project 2>/dev/null || true)"
if [ "$active" != "$PROJECT_ID" ]; then
  echo "Refusing to run: the active project is '${active}', this script is only for '${PROJECT_ID}'." >&2
  exit 2
fi

missing=()
for name in FIREBASE_PROJECT_ID FRONTEND_BASE_URL API_PUBLIC_URL TICK_AUDIENCE TICK_SERVICE_ACCOUNT_EMAIL; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then echo "Refusing to run: missing settings: ${missing[*]}" >&2; exit 2; fi
for name in FRONTEND_BASE_URL API_PUBLIC_URL TICK_AUDIENCE; do
  case "${!name}" in https://*) ;; *) echo "Refusing to run: ${name} must start with https://" >&2; exit 2 ;; esac
done
FRONTEND_ORIGIN="${FRONTEND_BASE_URL%/}"
TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-0}"
[[ "$TRUST_PROXY_HOPS" =~ ^[0-5]$ ]] || { echo "Refusing to run: TRUST_PROXY_HOPS must be 0 to 5" >&2; exit 2; }

IMAGE="${REGISTRY}/api:${TAG}"
MIGRATE_IMAGE="${REGISTRY}/api:${TAG}-migrate"
for image in "$IMAGE" "$MIGRATE_IMAGE"; do
  gcloud artifacts docker images describe "$image" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || { echo "Refusing to run: image ${image} is not in Artifact Registry (build and push it first)." >&2; exit 2; }
done
# No secret lookup here: the deployer holds no Secret Manager role (least privilege), so the lookup would fail and wrongly
# report "missing". The setup script's --verify checks that the secrets exist, and Cloud Run refuses a deploy that names a
# secret the runtime account cannot read.

# ---- 1. migrate -----------------------------------------------------------------------------------------------------
note "== 1. migrate the database (job ${JOB}, image ${MIGRATE_IMAGE##*/}) =="
run gcloud run jobs deploy "$JOB" --project "$PROJECT_ID" --region "$REGION" --image "$MIGRATE_IMAGE" \
  --service-account "$RUNTIME" --set-secrets "DATABASE_URL=DATABASE_URL_DIRECT:latest" --max-retries 0 --task-timeout 600
if [ "$MODE" = "dry-run" ]; then
  run gcloud run jobs execute "$JOB" --project "$PROJECT_ID" --region "$REGION" --wait
elif ! gcloud run jobs execute "$JOB" --project "$PROJECT_ID" --region "$REGION" --wait; then
  fail "the database migration failed; the service was NOT touched and keeps serving the previous version"
fi

# Reads one fact from the service's traffic list. The list is read as JSON and picked apart with node, because the gcloud
# --flatten/--filter form came back empty on the build machine; a failure now prints its reason instead of hiding it.
#   serving-revision: the revision that has all the traffic    candidate-url: the address of the revision tagged "candidate"
traffic_lookup() {
  gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format=json \
    | node -e 'let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
        const traffic = (JSON.parse(d).status || {}).traffic || [];
        const wantUrl = process.argv[1] === "candidate-url";
        const found = wantUrl ? traffic.find((t) => t.tag === "candidate" && t.url) : traffic.find((t) => t.percent === 100);
        process.stdout.write(found ? (wantUrl ? found.url : found.revisionName) || "" : "");
      });' "$1"
}

# ---- 2. deploy without traffic--------------------------------------------------------------------------------------
service_exists=1
gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(metadata.name)' >/dev/null 2>&1 || service_exists=0

previous=""
if [ "$service_exists" = 1 ]; then
  previous="$(traffic_lookup serving-revision || true)"
fi

env_pairs=("NODE_ENV=staging" "FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}" "APP_CHECK_MODE=enforce" "FRONTEND_BASE_URL=${FRONTEND_ORIGIN}"
  "API_PUBLIC_URL=${API_PUBLIC_URL%/}" "TICK_AUDIENCE=${TICK_AUDIENCE%/}" "TICK_SERVICE_ACCOUNT_EMAIL=${TICK_SERVICE_ACCOUNT_EMAIL}"
  "TRUST_PROXY_HOPS=${TRUST_PROXY_HOPS}" "PAYU_ENV=test")
[ -z "${CORS_EXTRA_ORIGINS:-}" ] || env_pairs+=("CORS_EXTRA_ORIGINS=${CORS_EXTRA_ORIGINS}")
ENV_ARG="^#^$(IFS='#'; echo "${env_pairs[*]}")"

deploy_args=(--project "$PROJECT_ID" --region "$REGION" --image "$IMAGE" --service-account "$RUNTIME"
  --min-instances 0 --max-instances 1 --timeout 60 --memory 512Mi --cpu 1
  --set-env-vars "$ENV_ARG" --set-secrets "PAYU_KEY=PAYU_KEY:latest,PAYU_SALT=PAYU_SALT:latest,DATABASE_URL=DATABASE_URL:latest")

note "== 2. deploy ${IMAGE##*/} ${SERVICE} $([ "$service_exists" = 1 ] && echo 'without traffic' || echo '(first deploy: a new service has to take traffic at once)') =="
if [ "$service_exists" = 1 ]; then
  run gcloud run deploy "$SERVICE" "${deploy_args[@]}" --no-traffic --tag candidate
else
  run gcloud run deploy "$SERVICE" "${deploy_args[@]}"
fi

if [ "$MODE" = "dry-run" ]; then
  note "== 3 and 4: would check the candidate, then switch traffic (dry run: nothing was changed) =="
  exit 0
fi

if [ "$service_exists" = 1 ]; then
  CHECK_URL="$(traffic_lookup candidate-url || true)"
else
  CHECK_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
fi
CHECK_URL="${CHECK_URL%/}"
[ -n "$CHECK_URL" ] || fail "could not find the address of the new version"

# ---- 3. check the new version ---------------------------------------------------------------------------------------
checks_failed=0
pass() { note "PASS    $1"; }
bad() { note "FAIL    $1"; checks_failed=1; }
status_of() { curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo "000"; }

check_health() { # retries: a cold start and a sleeping database can take a while
  local body
  for _ in $(seq 1 "$CHECK_ATTEMPTS"); do
    body="$(curl -sS --max-time 20 "$1/v1/health" 2>/dev/null || true)"
    if [[ "$body" == *'"status":"ok"'* && "$body" == *'"db":"ok"'* ]]; then return 0; fi
    sleep "$SLEEP_SECONDS"
  done
  return 1
}

run_checks() { # run_checks <base-url>
  local base="$1" body acao
  if check_health "$base"; then pass "/v1/health is ok and the database answers"; else bad "/v1/health is not ok with the database"; fi

  body="$(curl -sS --max-time 20 "$base/v1/packages" 2>/dev/null || true)"
  if [[ "$body" == '{"packages":[{'* ]]; then
    local key ok=1
    for key in '"id":' '"title":' '"description":' '"pricePaise":' '"originalPricePaise":' '"currency":"INR"' '"durationMinutes":'; do
      [[ "$body" == *"$key"* ]] || ok=0
    done
    for key in isActive createdAt updatedAt; do
      [[ "$body" != *"$key"* ]] || ok=0
    done
    if [ "$ok" = 1 ]; then pass "/v1/packages lists packages with exactly the public fields"; else bad "/v1/packages has the wrong fields"; fi
  else
    bad "/v1/packages did not return at least one package (is the database seeded?)"
  fi

  if [ "$(status_of "$base/v1/me")" = "401" ]; then pass "/v1/me without a token is 401"; else bad "/v1/me without a token is not 401"; fi
  if [ "$(status_of -X POST "$base/dev/tick")" = "404" ]; then pass "development-only routes answer 404"; else bad "a development-only route is reachable"; fi

  acao="$(curl -sS --max-time 20 -D - -o /dev/null -X OPTIONS -H "Origin: ${FRONTEND_ORIGIN}" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: authorization,idempotency-key,content-type,x-firebase-appcheck' "$base/v1/bookings" 2>/dev/null | tr -d '\r' | grep -i '^access-control-allow-origin:' || true)"
  if [ "${acao,,}" = "access-control-allow-origin: ${FRONTEND_ORIGIN,,}" ]; then pass "the website origin is allowed by CORS"; else bad "CORS does not allow ${FRONTEND_ORIGIN}"; fi
  acao="$(curl -sS --max-time 20 -D - -o /dev/null -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' \
    "$base/v1/bookings" 2>/dev/null | tr -d '\r' | grep -i '^access-control-allow-origin:' || true)"
  if [ -z "$acao" ]; then pass "a foreign origin gets no CORS permission"; else bad "a foreign origin is allowed by CORS"; fi
}

note "== 3. check the new version at ${CHECK_URL%%.*}... =="
run_checks "$CHECK_URL"
if [ "$checks_failed" -ne 0 ]; then
  if [ "$service_exists" = 1 ]; then
    fail "a check failed: all traffic stays on ${previous:-the previous version}; the new version is left under the tag 'candidate' for inspection"
  fi
  fail "a check failed on the FIRST deploy: the service is running but not healthy; fix it and deploy again"
fi

# ---- 4. switch ------------------------------------------------------------------------------------------------------
if [ "$service_exists" = 1 ]; then
  note "== 4. send all traffic to the new version =="
  run gcloud run services update-traffic "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --to-latest
  run gcloud run services update-traffic "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --remove-tags candidate
  LIVE_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
  if [ -n "$LIVE_URL" ] && ! check_health "${LIVE_URL%/}"; then
    if [ -n "$previous" ]; then
      run gcloud run services update-traffic "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --to-revisions "${previous}=100"
      fail "the live address failed its health check after the switch; traffic was sent back to ${previous}"
    fi
    fail "the live address failed its health check after the switch and there is no previous version to go back to"
  fi
fi

revision="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
digest="$(gcloud artifacts docker images describe "$IMAGE" --project "$PROJECT_ID" --format='value(image_summary.digest)' 2>/dev/null || true)"
note ""
note "DEPLOYED  revision ${revision:-unknown}  image ${IMAGE##*/}  digest ${digest:-unknown}"
[ -z "$previous" ] || note "To go back: gcloud run services update-traffic ${SERVICE} --project ${PROJECT_ID} --region ${REGION} --to-revisions ${previous}=100"
exit 0
