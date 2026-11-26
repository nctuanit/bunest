#!/usr/bin/env bash
# Zero-downtime rolling rollback script for Bunest 0.1 staging/production preview.
# Rolls back api-1 and api-2 sequentially to a previous image tag WITHOUT running
# destructive down migrations (expand-and-contract schema discipline).
#
# Usage:
#   ./deploy/rollback.sh <target-image-tag> [compose-file]
# Example:
#   ./deploy/rollback.sh 0.1.0-preview

set -euo pipefail

TARGET_TAG="${1:?Usage: $0 <target-image-tag> [compose-file]}"
COMPOSE_FILE="${2:-$(dirname "$0")/docker-compose.yml}"

START_TS=$(date +%s)
echo "[rollback] Rolling back to image tag: ${TARGET_TAG} (no down migrations executed)"

export APP_IMAGE_TAG="${TARGET_TAG}"

wait_for_ready() {
  local service="$1"
  local attempts=0
  local max_attempts=60
  echo "[rollback] Waiting for ${service} /ready == 200..."
  while [ "$attempts" -lt "$max_attempts" ]; do
    if docker compose -f "$COMPOSE_FILE" exec -T "$service" \
      bun -e "const r = await fetch('http://127.0.0.1:3000/ready'); process.exit(r.status === 200 ? 0 : 1)" \
      >/dev/null 2>&1; then
      echo "[rollback] ${service} is ready."
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  echo "[rollback] ERROR: ${service} failed to become ready within ${max_attempts}s" >&2
  return 1
}

probe_schema_read() {
  local service="$1"
  local probe_id="${ROLLBACK_PROBE_ITEM_ID:-1}"
  echo "[rollback] Running post-rollback schema read probe on ${service} (GET /items & GET /items/${probe_id})..."
  if ! docker compose -f "$COMPOSE_FILE" exec -T "$service" \
    bun -e "
      const listRes = await fetch('http://127.0.0.1:3000/items');
      if (listRes.status >= 500 || (listRes.status !== 200 && listRes.status !== 404)) {
        console.error('GET /items failed with status ' + listRes.status);
        process.exit(1);
      }
      const itemRes = await fetch('http://127.0.0.1:3000/items/${probe_id}');
      if (itemRes.status >= 500 || (itemRes.status !== 200 && itemRes.status !== 404)) {
        console.error('GET /items/${probe_id} failed with status ' + itemRes.status);
        process.exit(1);
      }
    "; then
    echo "[rollback] ERROR: ${service} failed post-rollback schema read probe" >&2
    return 1
  fi
  echo "[rollback] ${service} passed schema read probe."
}

probe_schema_write() {
  local service="$1"
  echo "[rollback] Running post-rollback schema write probe on ${service} (POST /items -> GET /items/:id)..."
  if ! docker compose -f "$COMPOSE_FILE" exec -T "$service" \
    bun -e "
      const createRes = await fetch('http://127.0.0.1:3000/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'rollback-smoke-probe', quantity: 1 }),
      });
      if (createRes.status !== 201) {
        console.error('POST /items failed with status ' + createRes.status);
        process.exit(1);
      }
      const created = await createRes.json();
      if (!created || created.id === undefined || created.id === null) {
        console.error('POST /items response missing id');
        process.exit(1);
      }
      const readRes = await fetch('http://127.0.0.1:3000/items/' + created.id);
      if (readRes.status !== 200) {
        console.error('GET /items/' + created.id + ' failed with status ' + readRes.status);
        process.exit(1);
      }
    "; then
    echo "[rollback] ERROR: ${service} failed post-rollback schema write probe" >&2
    return 1
  fi
  echo "[rollback] ${service} passed schema write probe."
}

for svc in api-1 api-2; do
  echo "[rollback] Replacing ${svc} with tag ${TARGET_TAG}..."
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "$svc"
  wait_for_ready "$svc"
done

for svc in api-1 api-2; do
  probe_schema_read "$svc"
done

if [ "${ROLLBACK_SMOKE_WRITE:-0}" = "1" ]; then
  probe_schema_write api-1
fi

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
echo "[rollback] Completed rollback to ${TARGET_TAG} in ${ELAPSED}s (target gate: <300s)."
if [ "$ELAPSED" -ge 300 ]; then
  echo "[rollback] WARNING: Rollback exceeded 5-minute gate (${ELAPSED}s)" >&2
  exit 1
fi
