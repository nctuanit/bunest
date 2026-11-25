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

for svc in api-1 api-2; do
  echo "[rollback] Replacing ${svc} with tag ${TARGET_TAG}..."
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "$svc"
  wait_for_ready "$svc"
done

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
echo "[rollback] Completed rollback to ${TARGET_TAG} in ${ELAPSED}s (target gate: <300s)."
if [ "$ELAPSED" -ge 300 ]; then
  echo "[rollback] WARNING: Rollback exceeded 5-minute gate (${ELAPSED}s)" >&2
  exit 1
fi
