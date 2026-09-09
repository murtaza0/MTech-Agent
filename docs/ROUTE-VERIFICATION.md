# Route Verification Runbook

This runbook is intended for maintainers before a GitHub push or release. It deliberately tests both working behavior and expected failures so a broken route does not hide behind a green happy-path check.

## Required commands

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm run verify:routes
```

The route verifier starts the compiled API on port `5101` and sets `MTECH_WORKSPACE_ROOT` to the repository root. Override the port with `MTECH_VERIFY_PORT` if another service is already using it.

## Coverage

The script checks:

- `/api/healthz` and `/api/mtech/health`.
- LLM status/config routes and malformed config/chat/stream bodies.
- Model/test routes without requiring a live provider; provider unavailability is an allowed service-level response.
- Project list/create/detail routes and unknown-project guards.
- Task graph, plan/messages, real command execution, agents, security, and activity routes with both valid and unknown project ids.
- Preview read/start/restart/stop transitions and unknown-project rejection.
- Missing file path, missing file, wrong project, and `../../etc/passwd` traversal rejection.
- Single-file attachment headers.
- ZIP content type, attachment response, non-empty archive, and checksum integrity.

## Release evidence

A successful run ends with:

```text
Route verification complete: <number> checks passed.
```

If a check fails, the script exits non-zero and prints the response body for the failed route. Do not publish a release until the failing route is fixed and the complete suite is green again.
