# MTech architecture

MTech keeps the OpenHands-derived control-room layout while moving runtime
ownership into the MTech API.

```text
Chat request
  -> orchestrator
  -> persisted task graph
  -> planner / feature / execution / security / review workers
  -> project workspace
  -> verification commands
  -> real preview process
  -> activity API and UI
```

The API lives in `artifacts/api-server`. `lib/api-zod` is the typed contract
boundary and `artifacts/mtech` is the React/Vite client. Runtime state is
stored atomically in `.mtech/state.json`; project roots created through the
API live below `.mtech/projects/<id>`. The existing workspace is represented by
the deterministic `workspace` project id.

The state file is intentionally ignored by Git and survives a process restart.
The archive did not contain a usable database schema, so this implementation
uses a small file-backed repository rather than claiming a database write that
does not happen. A Postgres adapter can replace the repository without changing
the orchestrator or route contracts.

## Safety boundaries

- Every file path is resolved beneath the selected project root.
- Commands are executed with `shell: false` and pass an allowlist before spawn.
- LLM output is treated as planning text; it is never passed directly to a
  shell.
- Preview status is set to running only after the child process answers HTTP.
- Activity and task transitions are persisted before they are returned.