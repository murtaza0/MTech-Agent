#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MTECH_VERIFY_PORT:-5101}"
BASE="http://127.0.0.1:${PORT}/api"
LOG="${TMPDIR:-/tmp}/mtech-api-${PORT}.log"

if [[ ! -f "$ROOT/artifacts/api-server/dist/index.mjs" ]]; then
  echo "Missing compiled API. Run pnpm run build first." >&2
  exit 1
fi

PORT="$PORT" MTECH_WORKSPACE_ROOT="$ROOT" node --enable-source-maps "$ROOT/artifacts/api-server/dist/index.mjs" >"$LOG" 2>&1 &
API_PID=$!
cleanup() { kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in {1..30}; do
  curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

pass=0
check() {
  local name="$1" expected="$2" method="$3" path="$4" body="${5:-}"
  local code
  if [[ -n "$body" ]]; then
    code="$(curl -sS -o /tmp/mtech-route-body -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data "$body" "$BASE$path")"
  else
    code="$(curl -sS -o /tmp/mtech-route-body -w '%{http_code}' -X "$method" "$BASE$path")"
  fi
  [[ "$code" =~ ^($expected)$ ]] || { echo "FAIL $name: expected $expected, received $code"; cat /tmp/mtech-route-body; return 1; }
  echo "PASS $name ($code)"
  pass=$((pass + 1))
}

check health 200 GET /healthz
check mtech-health 200 GET /mtech/health
check llm-status 200 GET /mtech/llm/status
check llm-config 200 GET /mtech/llm/config
check llm-models '200|502' GET /mtech/llm/models
check llm-test 200 POST /mtech/llm/test || true
check malformed-llm-config 400 PATCH /mtech/llm/config '{"timeout":"not-a-number"}'
check malformed-chat 400 POST /mtech/llm/chat '{}'
check malformed-stream 400 POST /mtech/llm/stream '{}'
check projects-list 200 GET /mtech/projects
check project-create 201 POST /mtech/projects '{"name":"Route Verification Workspace","description":"Automated verification"}'
check project-detail 200 GET /mtech/projects/workspace
check project-detail-missing 404 GET /mtech/projects/does-not-exist
check tasks 200 GET /mtech/projects/workspace/tasks
check tasks-missing 404 GET /mtech/projects/does-not-exist/tasks
check plan 200 GET /mtech/projects/workspace/plan
check messages 200 GET /mtech/projects/workspace/messages
check files-list 200 GET /mtech/projects/workspace/files
check execution 200 POST /mtech/projects/workspace/execution '{"command":"node","args":["-e","console.log(\"mtech-execution-ok\")"]}'
check agents 200 GET /mtech/projects/workspace/agents
check agents-missing 404 GET /mtech/projects/does-not-exist/agents
check activity 200 GET /mtech/projects/workspace/activity
check activity-missing 404 GET /mtech/projects/does-not-exist/activity
check preview-initial 200 GET /mtech/projects/workspace/preview
check preview-start 200 POST /mtech/projects/workspace/preview/start
check preview-running 200 GET /mtech/projects/workspace/preview
check preview-restart 200 POST /mtech/projects/workspace/preview/restart
check preview-stop 200 POST /mtech/projects/workspace/preview/stop
check preview-missing 404 POST /mtech/projects/does-not-exist/preview/start
check missing-file-path 400 GET /mtech/projects/workspace/files/download
check missing-file 404 GET '/mtech/projects/workspace/files/download?path=does-not-exist.txt'
check traversal 404 GET '/mtech/projects/workspace/files/download?path=../../etc/passwd'
check wrong-file-project 404 GET '/mtech/projects/does-not-exist/files/download?path=README.md'

curl -fsS -D /tmp/mtech-file-headers -o /tmp/mtech-readme.md "$BASE/mtech/projects/workspace/files/download?path=README.md"
grep -qi 'content-disposition: attachment' /tmp/mtech-file-headers || { echo 'FAIL file attachment header'; exit 1; }
pass=$((pass + 1)); echo 'PASS single-file-download (200)'

curl -fsS -D /tmp/mtech-zip-headers -o /tmp/mtech-workspace.zip "$BASE/mtech/projects/workspace/download.zip"
grep -qi 'content-type: application/zip' /tmp/mtech-zip-headers || { echo 'FAIL ZIP content type'; exit 1; }
python3 - <<'PY'
import zipfile
with zipfile.ZipFile('/tmp/mtech-workspace.zip') as archive:
    if archive.testzip() is not None:
        raise SystemExit('ZIP checksum failure')
    if not archive.namelist():
        raise SystemExit('ZIP is empty')
print('PASS zip-integrity')
PY
pass=$((pass + 1))

check zip-missing-project 404 GET /mtech/projects/does-not-exist/download.zip
echo "Route verification complete: $pass checks passed."
