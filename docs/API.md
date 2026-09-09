# MTech API Contract

All API routes are mounted under `/api` by `artifacts/api-server/src/app.ts`. MTech routes are declared once in `artifacts/api-server/src/routes/mtech.ts`; the health route is declared once in `artifacts/api-server/src/routes/health.ts`.

## Route matrix

| Method | Path | Success | Expected validation/error behavior |
| --- | --- | --- | --- |
| GET | `/api/healthz` | `200` | Returns `{ status: "ok" }`. |
| GET | `/api/mtech/health` | `200` | Returns service name and version. |
| GET | `/api/mtech/llm/status` | `200` | Reports configured provider and last connection state. |
| GET | `/api/mtech/llm/models` | `200` | Returns provider models; `502` when Local Colab is unavailable. |
| GET | `/api/mtech/llm/config` | `200` | Returns non-secret LLM configuration metadata. |
| PATCH / PUT | `/api/mtech/llm/config` | `200` | Valid partial configuration; malformed bodies return `400`. |
| POST | `/api/mtech/llm/test` | `200` | Returns connection result without crashing when provider is unavailable. |
| POST | `/api/mtech/llm/chat` or `/api/mtech/projects/:projectId/chat` | `200` | Runs the persisted orchestrator/task graph; malformed body `400`, unknown project `404`. |
| POST | `/api/mtech/llm/stream` | `200` | `text/event-stream` when upstream is available; malformed body `400`, unavailable provider `502`. |
| GET | `/api/mtech/projects` | `200` | Returns the configured workspace plus durable projects. |
| POST | `/api/mtech/projects` | `201` | Requires a non-empty name; malformed body `400`. |
| GET | `/api/mtech/projects/:projectId` | `200` | Unknown project id `404`. |
| GET | `/api/mtech/projects/:projectId/tasks` | `200` | Unknown project id `404`. |
| POST | `/api/mtech/projects/:projectId/tasks` | `201` | Queues a task with agent, priority, and dependency metadata. |
| GET | `/api/mtech/projects/:projectId/tasks/:taskId` | `200` | Returns task execution details and logs. |
| POST | `/api/mtech/projects/:projectId/tasks/:taskId/retry` | `200` | Moves a failed task to retrying. |
| POST | `/api/mtech/projects/:projectId/tasks/:taskId/cancel` | `200` | Cancels a queued or active task record. |
| GET | `/api/mtech/projects/:projectId/plan` | `200` | Returns the persisted task graph. |
| GET | `/api/mtech/projects/:projectId/messages` | `200` | Returns the durable project conversation. |
| GET | `/api/mtech/projects/:projectId/agents` | `200` | Specialist roster; unknown project id `404`. |
| GET | `/api/mtech/projects/:projectId/activity` | `200` | Recent events; unknown project id `404`. |
| GET | `/api/mtech/projects/:projectId/activity/stream` | `200` | SSE activity stream. |
| GET | `/api/mtech/projects/:projectId/files` | `200` | Lists real project files. |
| GET | `/api/mtech/projects/:projectId/files/:path` | `200` | Reads a real UTF-8 project file. |
| PUT | `/api/mtech/projects/:projectId/files` | `200` | Writes `{ path, content }` into the project root. |
| POST | `/api/mtech/projects/:projectId/execution` | `200/422` | Runs one policy-checked command and returns captured output. |
| GET | `/api/mtech/projects/:projectId/processes` | `200` | Returns preview process metadata and recent logs. |
| GET | `/api/mtech/projects/:projectId/git/status`, `/git/diff`, `/git/log` | `200` | Runs real Git inspection in the project root. |
| POST | `/api/mtech/projects/:projectId/git/checkpoint` | `200/422` | Adds and commits the project with a validated message. |
| POST | `/api/mtech/projects/:projectId/git/rollback` | `200/422` | Runs a validated `git reset --hard` reference. |
| GET | `/api/mtech/projects/:projectId/preview` | `200` | Preview state; unknown project id `404`. |
| POST | `/api/mtech/projects/:projectId/preview/start` | `200` | Runs preview transition and records activity; unknown id `404`. |
| POST | `/api/mtech/projects/:projectId/preview/stop` | `200` | Stops preview and records activity; unknown id `404`. |
| POST | `/api/mtech/projects/:projectId/preview/restart` | `200` | Restarts preview and records activity; unknown id `404`. |
| GET | `/api/mtech/projects/:projectId/files/download?path=...` | `200` | Attachment headers; missing path `400`, unknown/traversal path `404`. |
| GET | `/api/mtech/projects/:projectId/download.zip` | `200` | Valid ZIP attachment; unknown project `404`, size failure `413`. |

## Contract and safety rules

The project id must match the configured workspace id before workspace data is returned or mutated. The file resolver normalizes the requested path under `MTECH_WORKSPACE_ROOT`, rejects paths outside that root, requires a regular file, and enforces the configured byte limit. ZIP generation reuses the same resolver and rejects an aggregate archive that exceeds the configured limit.

The API does not expose the configured bearer token in responses. Provider failures become explicit `502` responses for model routes rather than uncaught exceptions. The stream route uses `text/event-stream`, disables caching, and closes the reader in a `finally` block.

## Automated verification

Run:

```bash
pnpm run typecheck
pnpm run build
pnpm run verify:routes
```

`verify:routes` starts the compiled API on port `5101`, exercises every route family, checks positive and negative validation paths, verifies all preview transitions, validates download headers, opens the generated ZIP to confirm it is not corrupt, and confirms `../../etc/passwd` is rejected.
