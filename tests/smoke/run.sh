#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

project="material-studio-smoke-${BASHPID}"
image="$project-runner"
export WEB_PORT=0 SIMULATION_ENABLED=true
export ASSET_RETENTION_SECONDS=86400 ASSET_CLEANUP_INTERVAL_MS=500
export MSYS_NO_PATHCONV=1

compose() { docker compose -p "$project" "$@"; }
runner() {
  docker run --rm --init --ipc=host --network "${project}_default" "$image" node "$@"
}
cleanup() {
  local result=$?
  if (( result != 0 )); then compose logs --no-color --tail 100 || true; fi
  compose down --volumes || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sql() {
  compose exec -T db sh -ec 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" -D "$MYSQL_DATABASE" -N -B -e "$1"' -- "$1"
}
replica_ips() {
  local ids
  ids=$(compose ps -q api)
  mapfile -t containers <<< "$ids"
  [[ ${#containers[@]} -eq 2 ]]
  docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${containers[@]}"
}

docker build -t "$image" tests/smoke
compose up --build -d --wait --wait-timeout 120 --scale api=2
runner browser.mjs

ips=$(replica_ips)
readarray -t replicas <<< "$ips"
fixture=$(runner service.mjs prepare-restart "${replicas[@]}")
read -r task used unused <<< "$fixture"
[[ $task =~ ^[a-f0-9-]{36}$ && $used =~ ^[a-f0-9-]{36}$ && $unused =~ ^[a-f0-9-]{36}$ ]]
compose kill -s SIGKILL api
[[ $(sql "SELECT CONCAT(status, '/', stage) FROM tasks WHERE id='$task'") == RUNNING/GENERATE ]]
sql "UPDATE assets SET created_at=CURRENT_TIMESTAMP(3)-INTERVAL 2 DAY WHERE id IN ('$used', '$unused')"
compose up -d --wait --wait-timeout 120 --scale api=2
runner service.mjs verify "$task" "$used" "$unused"
[[ $(sql "SELECT COUNT(*) FROM assets WHERE id='$unused'") == 0 ]]
compose exec -T --index 1 api sh -ec 'test -f "$1" && test ! -e "$2"' -- "/app/data/uploads/$used.jpg" "/app/data/uploads/$unused.jpg"

ips=$(replica_ips)
readarray -t replicas <<< "$ips"
fixture=$(runner service.mjs prepare-outage "${replicas[@]}")
read -r task used <<< "$fixture"
api_containers=$(compose ps -q api)
compose kill -s SIGKILL db
# Leave the database down beyond the saved stage deadline.
sleep 7
compose up -d --no-recreate --wait --wait-timeout 120 db
[[ $(compose ps -q api) == "$api_containers" ]]
runner service.mjs verify "$task" "$used"
