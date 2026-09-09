---
name: Workspace restoration
description: Restoring uploaded pnpm workspaces after conversation-to-project handoff.
---

When an uploaded app is moved into a project, source files and generated contracts may be preserved separately from the active workspace, while compiled library declarations remain stale or missing. Restore the app's generated client/server contract sources, then run the root library typecheck before checking leaf packages.

**Why:** Leaf packages resolve workspace libraries through their emitted declarations, so valid source files can still appear to have missing exports until declarations are rebuilt.

**How to apply:** For future uploaded pnpm projects, compare the preserved source tree with the active workspace, restore generated contract files and backend route modules, install from the lockfile, run `pnpm run typecheck:libs`, then run artifact typechecks and build with workflow-provided environment values.