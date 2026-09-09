# Agents

The executable roster is defined in `artifacts/api-server/src/lib/mtech.ts`.
Each task has an id, project, agent, dependencies, lifecycle status, attempts,
timestamps, output, logs, and errors.

Current workers:

- Orchestrator and Planner / Architect: classify and plan a request.
- UI / Frontend, Backend, Database, Feature, Documentation, Deployment:
  specialist ownership boundaries for queued work.
- Code Execution: runs project-defined commands through the policy gate.
- Testing: runs the project's declared `typecheck`, `lint`, `test`, and `build`
  scripts.
- Security: scans actual workspace files for credential material and dangerous
  dynamic execution.
- Debugger and Code Review: capture failure/review boundaries and report
  findings without claiming an unperformed patch.

The orchestrator is intentionally bounded. It records a failure when a
provider, command, or preview is unavailable; it does not manufacture progress
or report that a file changed when it did not.