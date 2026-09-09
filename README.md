# MTech Agent Platform

<p align="center">
  <img src="artifacts/mtech/public/mtech-logo.png" alt="MTECH — Build Smarter Together" width="520" />
</p>

<p align="center"><strong>A production-oriented local agent workspace for planning, building, previewing, and verifying software projects.</strong></p>

MTech coordinates implementation briefs through a persisted orchestrator and specialist task graph while keeping the source workspace visible, editable, downloadable, and verifiable. It provides a focused control-room UI, a Local Colab-compatible OpenAI API connection, real command execution, an HTTP-verified preview lifecycle, file activity, security findings, and release checks suitable for a GitHub repository.

## Product capabilities

| Capability | Description |
| --- | --- |
| Workspace control room | Chat with the production orchestrator, inspect project metadata, and manage the preview lifecycle. |
| Specialist agent roster | A persisted roster covering planning, feature, runtime, testing, security, debugging, review, deployment, and documentation. |
| Real source inspection and editing | The Files and Code panels load indexed files from the workspace API and save editor changes back to the same project root. |
| Preview workflow | Start, stop, restart, embed, or open a real child-process preview after an HTTP health check. |
| Execution and review | Policy-checked command execution, project-defined verification scripts, credential/dynamic-execution scans, and structured task output. |
| Downloads | Download an individual source file or the complete workspace as a valid ZIP archive. |
| Route safety | Centralized route mounting, project-id guards, normalized file paths, traversal protection, and download size limits. |
| GitHub readiness | Reproducible install/build commands, environment template, CI workflow, API documentation, and route verification script. |

## Architecture

```text
Browser / Vite UI (artifacts/mtech)
          │  /api/*
          ▼
Express API (artifacts/api-server)
          │
          ├── Local Colab-compatible LLM provider
           ├── Workspace repository and safe file resolver
           ├── Orchestrator, task graph, and activity journal
           ├── Policy-checked execution and preview process lifecycle
          └── Typed API contracts (lib/api-spec + lib/api-zod)
```

The API is mounted once from `artifacts/api-server/src/routes/index.ts`. Health routes use `/api/healthz`; MTech routes use `/api/mtech/*`. The OpenAPI specification and generated Zod/client types are the contract boundary between the UI and server. Durable state is an atomic, Git-ignored `.mtech/state.json` repository because the uploaded database schema was empty; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Requirements

- Node.js 20 or newer; Node.js 24 is recommended.
- pnpm 10 or newer.
- A Local Colab-compatible endpoint is optional for browsing the workspace and required for live LLM chat/model requests.

## Installation and local development

```bash
pnpm install
cp .env.example .env

# Validate all TypeScript packages.
pnpm run typecheck

# Build the API and Vite client.
pnpm run build

# Start the API and UI in separate terminals.
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/mtech run dev
```

The API process requires `PORT`; the development command should be started with a port such as `PORT=5000`. The Vite client defaults to port `5173` and `/` as its base path when those variables are not supplied. For the API smoke suite, use `PORT=5101` so the verification command is isolated from another local service.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | API or Vite listening port, depending on the package | API: required by server entry; UI: `5173` |
| `BASE_PATH` | Vite public base path | `/` |
| `MTECH_WORKSPACE_ROOT` | Root directory indexed and served by the API | Current working directory |
| `MTECH_PROJECTS_ROOT` | Durable root for API-created projects | `.mtech/projects` |
| `MTECH_MAX_INDEXED_FILES` | Maximum indexed file entries | `500` |
| `MTECH_MAX_DOWNLOAD_BYTES` | Per-file and aggregate ZIP source-size guard | `33554432` |
| `MTECH_PREVIEW_URL` | URL shown in the embedded preview and Open action | `http://127.0.0.1:4173` |
| `MTECH_PREVIEW_PORT` | Preview port reported to the UI | `4173` |
| `LLM_BASE_URL` | Local Colab-compatible OpenAI API base URL | `http://127.0.0.1:8100/v1` |
| `LLM_MODEL` | Model identifier sent to the provider | `openai/deepseek-coder-6.7b-instruct` |
| `LLM_TIMEOUT` | Provider request timeout in milliseconds | `20000` |
| `LLM_MAX_TOKENS` | Maximum generated tokens | `2048` |
| `LLM_TEMPERATURE` | Provider temperature | `0.2` |
| `LLM_API_KEY` | Bearer token for the local endpoint | `replitclone-local` |
| `EXECUTION_PROVIDER` | `local` or `colab` command runtime | `local` |
| `COLAB_EXECUTION_URL` | Colab execution bridge base URL | unset |
| `COLAB_EXECUTION_API_KEY` | Server-only Colab bridge token | unset |
| `COLAB_WORKSPACE_ROOT` | Workspace path used by the Colab bridge | project root |

Never commit a real `.env` file or API key. Use `.env.example` as the shareable template.

## API and route verification

The complete route matrix, expected status codes, validation behavior, and security notes are documented in [`docs/API.md`](docs/API.md). Run the automated route suite after building the API:

```bash
pnpm run verify:routes
```

The suite starts the built API on an isolated port and verifies health, every read/write route, project-id guards, malformed request handling, preview transitions, individual-file downloads, ZIP integrity, and path traversal rejection. Routes that depend on an external Local Colab service are verified for their correct unavailable-service response rather than falsely requiring a live model in CI.

## GitHub release checklist

1. Copy the repository contents into a new GitHub repository; do not commit `node_modules`, `dist`, `.git`, `.env`, or TypeScript build-info files.
2. Configure repository secrets only if CI or deployment needs a remote LLM endpoint.
3. Run `pnpm install --frozen-lockfile`.
4. Run `pnpm run typecheck`.
5. Run `pnpm run build`.
6. Run `pnpm run verify:routes`.
7. Review the generated GitHub diff and confirm that only intended source, docs, and lockfile changes are present.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for code standards and [`docs/ROUTE-VERIFICATION.md`](docs/ROUTE-VERIFICATION.md) for the verification report format.

Detailed runtime contracts are in [`docs/AGENTS.md`](docs/AGENTS.md),
[`docs/COLAB.md`](docs/COLAB.md), [`docs/EXECUTION.md`](docs/EXECUTION.md),
[`docs/SECURITY.md`](docs/SECURITY.md), and
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## License

The repository is prepared as an MIT-licensed workspace. Add the final copyright holder name and year before publishing if your organization requires a named notice.
