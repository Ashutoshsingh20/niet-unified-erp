#!/bin/sh
set -eu

: "${POSTGRES_CONTAINER_ID:?POSTGRES_CONTAINER_ID is required}"
: "${FAILURE_DRILL_CONFIRM:?FAILURE_DRILL_CONFIRM is required}"
if [ "$FAILURE_DRILL_CONFIRM" != "DISPOSABLE_TEST_SERVICES" ]; then
  echo "Refusing to stop a database without disposable-test confirmation" >&2
  exit 2
fi

api_log="${TMPDIR:-/tmp}/niet-erp-failure-drill-api.log"
api_pid=""

stop_api() {
  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
    kill -TERM "$api_pid"
    wait "$api_pid" || true
  fi
  api_pid=""
}

cleanup() {
  stop_api
  docker start "$POSTGRES_CONTAINER_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

start_api() {
  : >"$api_log"
  node apps/api/dist/main.js >"$api_log" 2>&1 &
  api_pid=$!
}

wait_status() {
  url=$1
  expected=$2
  attempts=${3:-30}
  count=0
  while [ "$count" -lt "$attempts" ]; do
    status="$(curl --max-time 2 --silent --output /dev/null --write-out '%{http_code}' "$url" || true)"
    if [ "$status" = "$expected" ]; then return 0; fi
    count=$((count + 1))
    sleep 1
  done
  echo "Expected HTTP $expected from $url" >&2
  sed -n '1,120p' "$api_log" >&2
  return 1
}

live_url=http://127.0.0.1:3001/api/v1/health/live
ready_url=http://127.0.0.1:3001/api/v1/health/ready

start_api
wait_status "$ready_url" 200 60
wait_status "$live_url" 200 5

docker stop --time 10 "$POSTGRES_CONTAINER_ID" >/dev/null
wait_status "$ready_url" 503 30
wait_status "$live_url" 200 5

docker start "$POSTGRES_CONTAINER_ID" >/dev/null
wait_status "$ready_url" 200 60

stop_api
start_api
wait_status "$ready_url" 200 60

printf '%s\n' "Database failure isolation, recovery, and API process replacement verified"
