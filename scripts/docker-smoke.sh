#!/usr/bin/env bash
# Local proof of the container image against the local Postgres (docker-compose service "postgres").
# Builds both targets, migrates a throw-away database twice, seeds it, starts the API and checks it.
# Needs Docker running and the compose Postgres container up. Touches no real database and no secrets.
set -uo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows must not rewrite /app style paths

cd "$(dirname "$0")/.." || exit 2
PG_CONTAINER="${PG_CONTAINER:-ease-disease-backend-postgres-1}"
DB="smoke_$(date +%s)"
API_IMAGE="ease-disease-api:smoke"
MIGRATE_IMAGE="ease-disease-migrate:smoke"
API_NAME="ease-disease-smoke-api"
PORT_ON_HOST="${SMOKE_PORT:-3999}"
FAILED=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
check() { # check "description" command...
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}

cleanup() {
  docker rm -f "$API_NAME" >/dev/null 2>&1
  docker exec "$PG_CONTAINER" psql -U easedisease -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1
}
trap cleanup EXIT

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || { echo "Postgres container $PG_CONTAINER is not running"; exit 2; }
NETWORK="$(docker inspect "$PG_CONTAINER" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')"
DB_HOST="$(docker inspect "$PG_CONTAINER" --format '{{range .NetworkSettings.Networks}}{{index .Aliases 0}}{{end}}')"
DATABASE_URL="postgresql://easedisease:easedisease_local@${DB_HOST}:5432/${DB}?schema=public"

echo "== build =="
docker build -q --target runtime -t "$API_IMAGE" . >/dev/null && pass "runtime image builds with no .env present" || { fail "runtime image builds"; exit 1; }
docker build -q --target migrate -t "$MIGRATE_IMAGE" . >/dev/null && pass "migrate image builds" || { fail "migrate image builds"; exit 1; }

echo "== image contents =="
check "runs as a non-root user" test "$(docker run --rm --entrypoint id "$API_IMAGE" -u)" != "0"
check "no .env file inside the image" bash -c "! docker run --rm --entrypoint sh $API_IMAGE -c 'ls -A /app | grep -E \"^\\.env\"'"
check "no docs, tests or source folder inside the image" bash -c "! docker run --rm --entrypoint sh $API_IMAGE -c 'ls /app' | grep -E '^(docs|test|src|prisma)\$'"
check "image history shows no env secrets" bash -c "! docker history --no-trunc $API_IMAGE | grep -Ei 'password|secret|PAYU_|DATABASE_URL'"

echo "== migrate (empty database, twice) =="
docker exec "$PG_CONTAINER" psql -U easedisease -d postgres -c "CREATE DATABASE $DB" >/dev/null || { fail "create throw-away database"; exit 1; }
FIRST="$(docker run --rm --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" "$MIGRATE_IMAGE" 2>&1)"
echo "$FIRST" | grep -q "successfully applied" && pass "all migrations applied on an empty database" || { fail "migrations applied"; echo "$FIRST" | tail -15; }
SECOND="$(docker run --rm --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" "$MIGRATE_IMAGE" 2>&1)"
echo "$SECOND" | grep -q "No pending migrations" && pass "second run has nothing to apply" || { fail "second run is a no-op"; echo "$SECOND" | tail -10; }

echo "== seed =="
docker run --rm --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" "$API_IMAGE" node dist/seed/run-seed.js 2>&1 | grep -q "Seed complete" && pass "seed creates the launch package" || fail "seed"

echo "== boot refusal outside development =="
REFUSAL="$(docker run --rm -e NODE_ENV=staging -e DATABASE_URL="$DATABASE_URL" "$API_IMAGE" 2>&1)"
echo "$REFUSAL" | grep -qi "required" && pass "staging without its required settings refuses to start with a readable error" || fail "staging refusal"

echo "== run the API =="
docker run -d --name "$API_NAME" --network "$NETWORK" -p "${PORT_ON_HOST}:3000" \
  -e NODE_ENV=development -e APP_CHECK_MODE=off -e DATABASE_URL="$DATABASE_URL" "$API_IMAGE" >/dev/null
READY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT_ON_HOST}/healthz" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" = 1 ] && pass "/healthz answers" || { fail "/healthz answers"; docker logs "$API_NAME" 2>&1 | tail -20; }
curl -fsS "http://localhost:${PORT_ON_HOST}/healthz" | grep -q '"db":"ok"' && pass "database reachable from the container" || fail "database reachable"
curl -fsS "http://localhost:${PORT_ON_HOST}/v1/packages" | grep -q "One-Time Consult" && pass "/v1/packages returns the seeded package" || fail "/v1/packages"
test "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT_ON_HOST}/v1/me")" = "401" && pass "/v1/me without a token is 401" || fail "/v1/me is 401"

echo "== stop =="
START=$(date +%s)
docker stop -t 10 "$API_NAME" >/dev/null
ELAPSED=$(( $(date +%s) - START ))
CODE="$(docker inspect "$API_NAME" --format '{{.State.ExitCode}}')"
{ [ "$ELAPSED" -le 5 ] && { [ "$CODE" = 0 ] || [ "$CODE" = 143 ]; }; } && pass "SIGTERM stops it cleanly in ${ELAPSED}s (exit $CODE)" || fail "SIGTERM stop took ${ELAPSED}s, exit $CODE"

echo
[ "$FAILED" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
