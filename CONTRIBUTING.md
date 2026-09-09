# Contributing to MTech

## Development standard

Keep the API contract in `lib/api-spec/openapi.yaml` as the source of truth. When the contract changes, regenerate the typed client with `pnpm --filter @workspace/api-spec run codegen` and then run the full typecheck. Avoid embedding fake source snippets or hard-coded project-specific content in the UI; workspace views must use API data.

## Verification checklist

- `pnpm run typecheck` passes.
- `pnpm run build` passes.
- Every route is mounted once and includes a project-id guard where applicable.
- File downloads reject traversal and oversized files.
- Both single-file and ZIP downloads return the correct content disposition.
- Preview start, stop, restart, embedded rendering, and new-tab opening work.
- Files, Code, and Activity panels collapse and reopen without losing selection.
- No API keys, `.env` files, generated `dist` output, or local caches are committed.

## Commit and pull request guidance

Use focused commits and describe user-visible behavior in pull requests. Include the commands used for verification and note any environment-dependent checks that could not run locally.
