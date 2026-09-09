# Local Colab

MTech speaks the OpenAI-compatible API exposed by a local or remote Colab
runtime.

```dotenv
LLM_BASE_URL=http://127.0.0.1:8100/v1
LLM_MODEL=openai/deepseek-coder-6.7b-instruct
LLM_API_KEY=replitclone-local
LLM_TIMEOUT=20000
```

The server owns the bearer token. The browser receives only
`apiKeyConfigured: boolean`; it never receives the token. Configure the
endpoint in `/settings/llm` or with `PUT /api/mtech/llm/config`.

For command execution, set `EXECUTION_PROVIDER=colab`,
`COLAB_EXECUTION_URL`, and the server-only `COLAB_EXECUTION_API_KEY`.
`ColabExecutionProvider` calls the bridge's `/health` and `/execute`
endpoints after applying the same command policy used by the local provider.

`GET /api/mtech/llm/status`, `GET /api/mtech/llm/models`, and
`POST /api/mtech/llm/test` make real upstream requests. An unavailable Colab
endpoint is reported as a failed connection, not as a successful model call.