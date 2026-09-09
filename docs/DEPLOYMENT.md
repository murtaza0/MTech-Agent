# Deployment

1. Provision Node 20+ and pnpm 10+.
2. Run `pnpm install --frozen-lockfile`.
3. Set `PORT`, `MTECH_WORKSPACE_ROOT`, and the Local Colab variables.
4. Run `pnpm run typecheck` and `pnpm run build`.
5. Run `pnpm run verify:routes`.
6. Start the API with `PORT=5000 pnpm --filter @workspace/api-server run start`.
7. Serve the built Vite output from `artifacts/mtech/dist/public`.

Keep `.env`, `.mtech/state.json`, and generated project roots outside source
control. Put the API behind the deployment's TLS and authentication layer;
this archive provides workspace and command safety, not an identity provider.