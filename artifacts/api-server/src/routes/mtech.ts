import { Router, type IRouter } from "express";
import {
  ChatWithLlmBody, ChatWithLlmResponse, CreateProjectBody, CreateProjectResponse,
  GetLlmConfigResponse, GetLlmModelsResponse, GetLlmStatusResponse, GetMtechHealthResponse,
  GetPreviewParams, GetPreviewResponse, GetProjectParams, GetProjectResponse,
  ListActivityParams, ListActivityResponse, ListAgentsParams, ListAgentsResponse,
  ListProjectsResponse, ListTasksParams, ListTasksResponse, StartPreviewParams,
  StartPreviewResponse, StopPreviewParams, StopPreviewResponse, RestartPreviewParams,
  RestartPreviewResponse, TestLlmConnectionResponse, UpdateLlmConfigBody,
  UpdateLlmConfigResponse,
} from "@workspace/api-zod";
import {
  activity, addMessage, agents, cancelTask, createProject, createWorkspaceZip,
  enqueueTask, getPreview, getProject, listFiles, llmProvider, messages, orchestrate,
  gitCheckpoint, gitDiff, gitLog, gitRollback, gitStatus, previewLogsForProject, projects,
  executeCommand, executionProvider, readProjectFile, recordActivity, resolveWorkspaceFile,
  retryTask, runCommand, securityScan, startPreview, stopPreview, taskDetails, tasks, writeProjectFile,
} from "../lib/mtech";

const router: IRouter = Router();
const projectExists = (projectId: string) => Boolean(getProject(projectId));
const bad = (res: any, status: number, message: string) => res.status(status).json({ error: { code: `MTECH_${status}`, message, source: "mtech-api" } });
const guardProject = (projectId: string, res: any) => {
  if (!projectExists(projectId)) { bad(res, 404, "Project not found."); return false; }
  return true;
};

router.get("/mtech/health", (_req, res) => {
  res.json(GetMtechHealthResponse.parse({ status: "ok", service: "mtech-api", version: "1.0.0" }));
});

router.get("/mtech/llm/status", async (_req, res): Promise<void> => { res.json(GetLlmStatusResponse.parse(await llmProvider.status())); });
router.get("/mtech/llm/models", async (_req, res): Promise<void> => {
  try { res.json(GetLlmModelsResponse.parse({ models: await llmProvider.models() })); }
  catch (error) { bad(res, 502, error instanceof Error ? error.message : "Local Colab is unavailable."); }
});
router.get("/mtech/llm/config", (_req, res) => { res.json(GetLlmConfigResponse.parse(llmProvider.getConfig())); });
const updateLlmConfig = (req: any, res: any) => {
  const parsed = UpdateLlmConfigBody.safeParse(req.body);
  if (!parsed.success) { bad(res, 400, parsed.error.message); return; }
  res.json(UpdateLlmConfigResponse.parse(llmProvider.updateConfig(parsed.data)));
};
router.patch("/mtech/llm/config", updateLlmConfig);
router.put("/mtech/llm/config", updateLlmConfig);
router.post("/mtech/llm/test", async (_req, res): Promise<void> => { res.json(TestLlmConnectionResponse.parse(await llmProvider.testConnection())); });

const chat = async (req: any, res: any) => {
  const parsed = ChatWithLlmBody.safeParse(req.body);
  if (!parsed.success) { bad(res, 400, parsed.error.message); return; }
  if (!guardProject(parsed.data.projectId, res)) return;
  try {
    const result = await orchestrate(parsed.data.projectId, parsed.data.message);
    res.json(ChatWithLlmResponse.parse({ message: result.message, taskId: result.taskId, activity: result.activity }));
  } catch (error) { bad(res, 500, error instanceof Error ? error.message : "Orchestration failed."); }
};
router.post("/mtech/llm/chat", chat);
router.post("/mtech/projects/:projectId/chat", chat);

router.post("/mtech/llm/stream", async (req, res): Promise<void> => {
  const parsed = ChatWithLlmBody.safeParse(req.body);
  if (!parsed.success) { bad(res, 400, parsed.error.message); return; }
  try {
    const upstream = await llmProvider.stream([
      { role: "system", content: "You are the MTech Local Colab model. Do not claim tools or file changes you did not perform." },
      ...(parsed.data.history ?? []), { role: "user", content: parsed.data.message },
    ]);
    if (!upstream.ok || !upstream.body) { bad(res, 502, "Local Colab stream failed."); return; }
    res.status(200).setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive");
    const reader = upstream.body.getReader();
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; res.write(Buffer.from(chunk.value)); } }
    finally { reader.releaseLock(); res.end(); }
  } catch (error) { if (!res.headersSent) bad(res, 502, error instanceof Error ? error.message : "Local Colab is unavailable."); else res.end(); }
});

router.get("/mtech/projects", (_req, res) => { res.json(ListProjectsResponse.parse(projects())); });
router.post("/mtech/projects", (req, res): void => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) { bad(res, 400, parsed.error.message); return; }
  res.status(201).json(CreateProjectResponse.parse(createProject(parsed.data.name.trim(), parsed.data.description)));
});
router.get("/mtech/projects/:projectId", (req, res): void => {
  const parsed = GetProjectParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  res.json(GetProjectResponse.parse(getProject(parsed.data.projectId)));
});

router.get("/mtech/projects/:projectId/files", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  res.json({ files: listFiles(req.params.projectId) });
});
router.get(/^\/mtech\/projects\/([^/]+)\/files\/(.+)$/, (req, res, next): void => {
  const projectId = req.params[0]; const filePath = req.params[1];
  if (filePath === "download") { next(); return; }
  if (!guardProject(projectId, res)) return;
  try { res.json({ path: filePath, content: readProjectFile(projectId, filePath) }); }
  catch (error) { bad(res, 404, error instanceof Error ? error.message : "File is unavailable."); }
});
router.put("/mtech/projects/:projectId/files", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  const filePath = typeof req.body?.path === "string" ? req.body.path : "";
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  if (!filePath || content === null) { bad(res, 400, "path and content are required."); return; }
  try { res.json(writeProjectFile(req.params.projectId, filePath, content)); }
  catch (error) { bad(res, 400, error instanceof Error ? error.message : "File could not be written."); }
});
router.get("/mtech/projects/:projectId/files/download", (req, res): void => {
  const parsed = GetProjectParams.safeParse(req.params); const filePath = typeof req.query.path === "string" ? req.query.path : "";
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  if (!filePath) { bad(res, 400, "A file path is required."); return; }
  try {
    const { absolutePath } = resolveWorkspaceFile(filePath, parsed.data.projectId);
    const filename = filePath.split("/").pop() ?? "download";
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/["\\]/g, "")}"`);
    res.sendFile(absolutePath);
  } catch (error) { bad(res, 404, error instanceof Error ? error.message : "File is unavailable."); }
});
router.get("/mtech/projects/:projectId/download.zip", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  try { res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", 'attachment; filename="mtech-workspace.zip"'); res.send(createWorkspaceZip(req.params.projectId)); }
  catch (error) { bad(res, 413, error instanceof Error ? error.message : "Workspace archive could not be created."); }
});

router.get("/mtech/projects/:projectId/tasks", (req, res): void => {
  const parsed = ListTasksParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  res.json(ListTasksResponse.parse(tasks(parsed.data.projectId)));
});
router.post("/mtech/projects/:projectId/tasks", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  const body = req.body ?? {};
  if (typeof body.title !== "string" || typeof body.description !== "string") { bad(res, 400, "title and description are required."); return; }
  try { res.status(201).json(enqueueTask(req.params.projectId, { agentId: body.agentId ?? "feature", title: body.title, description: body.description, priority: body.priority, dependencies: Array.isArray(body.dependencies) ? body.dependencies : [] })); }
  catch (error) { bad(res, 400, error instanceof Error ? error.message : "Task could not be queued."); }
});
router.get("/mtech/projects/:projectId/tasks/:taskId", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  const task = taskDetails(req.params.projectId, req.params.taskId);
  if (!task) { bad(res, 404, "Task not found."); return; }
  res.json(task);
});
router.post("/mtech/projects/:projectId/tasks/:taskId/retry", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  try { res.json(retryTask(req.params.projectId, req.params.taskId)); } catch (error) { bad(res, 404, error instanceof Error ? error.message : "Task not found."); }
});
router.post("/mtech/projects/:projectId/tasks/:taskId/cancel", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  try { res.json(cancelTask(req.params.projectId, req.params.taskId)); } catch (error) { bad(res, 404, error instanceof Error ? error.message : "Task not found."); }
});
router.get("/mtech/projects/:projectId/plan", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  res.json({ projectId: req.params.projectId, tasks: tasks(req.params.projectId), generatedAt: new Date().toISOString() });
});
router.get("/mtech/projects/:projectId/messages", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  res.json(messages(req.params.projectId));
});

router.get("/mtech/projects/:projectId/agents", (req, res): void => {
  const parsed = ListAgentsParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  res.json(ListAgentsResponse.parse(agents(parsed.data.projectId)));
});
router.get("/mtech/projects/:projectId/activity", (req, res): void => {
  const parsed = ListActivityParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  res.json(ListActivityResponse.parse(activity(parsed.data.projectId)));
});
router.get("/mtech/projects/:projectId/activity/stream", (req, res): void => {
  if (!guardProject(req.params.projectId, res)) return;
  res.status(200).setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive");
  const send = () => res.write(`event: activity\ndata: ${JSON.stringify(activity(req.params.projectId)[0] ?? null)}\n\n`);
  send(); const timer = setInterval(send, 1000); req.on("close", () => clearInterval(timer));
});

router.post("/mtech/projects/:projectId/execution", async (req, res): Promise<void> => {
  if (!guardProject(req.params.projectId, res)) return;
  const { command, args, timeoutMs } = req.body ?? {};
  if (typeof command !== "string" || (args !== undefined && !Array.isArray(args))) { bad(res, 400, "command and optional args are required."); return; }
  let result;
  try { result = await executeCommand(req.params.projectId, command, args ?? [], Number(timeoutMs) || 120000); }
  catch (error) { bad(res, 502, error instanceof Error ? error.message : "Execution provider failed."); return; }
  res.status(result.status === "completed" ? 200 : 422).json(result);
});
router.get("/mtech/projects/:projectId/processes", async (req, res): Promise<void> => { if (!guardProject(req.params.projectId, res)) return; res.json({ provider: await executionProvider.health(), preview: getPreview(), logs: previewLogsForProject(req.params.projectId) }); });
router.get("/mtech/projects/:projectId/security", (req, res): void => { if (!guardProject(req.params.projectId, res)) return; res.json({ projectId: req.params.projectId, findings: securityScan(req.params.projectId), scannedAt: new Date().toISOString() }); });
router.get("/mtech/projects/:projectId/git/status", async (req, res): Promise<void> => { if (!guardProject(req.params.projectId, res)) return; res.json(await gitStatus(req.params.projectId)); });
router.get("/mtech/projects/:projectId/git/diff", async (req, res): Promise<void> => { if (!guardProject(req.params.projectId, res)) return; res.json(await gitDiff(req.params.projectId)); });
router.get("/mtech/projects/:projectId/git/log", async (req, res): Promise<void> => { if (!guardProject(req.params.projectId, res)) return; res.json(await gitLog(req.params.projectId)); });
router.post("/mtech/projects/:projectId/git/checkpoint", async (req, res): Promise<void> => {
  if (!guardProject(req.params.projectId, res)) return;
  try { const result = await gitCheckpoint(req.params.projectId, typeof req.body?.message === "string" ? req.body.message : "MTech checkpoint"); res.status(result.status === "completed" ? 200 : 422).json(result); }
  catch (error) { bad(res, 400, error instanceof Error ? error.message : "Checkpoint failed."); }
});
router.post("/mtech/projects/:projectId/git/rollback", async (req, res): Promise<void> => {
  if (!guardProject(req.params.projectId, res)) return;
  try { const result = await gitRollback(req.params.projectId, typeof req.body?.ref === "string" ? req.body.ref : "HEAD"); res.status(result.status === "completed" ? 200 : 422).json(result); }
  catch (error) { bad(res, 400, error instanceof Error ? error.message : "Rollback failed."); }
});

router.get("/mtech/projects/:projectId/preview", (req, res): void => {
  const parsed = GetPreviewParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  res.json(GetPreviewResponse.parse(getPreview()));
});
router.post("/mtech/projects/:projectId/preview/start", async (req, res): Promise<void> => {
  const parsed = StartPreviewParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  try { res.json(StartPreviewResponse.parse(await startPreview(parsed.data.projectId))); } catch (error) { bad(res, 422, error instanceof Error ? error.message : "Preview could not be started."); }
});
router.post("/mtech/projects/:projectId/preview/stop", (req, res): void => {
  const parsed = StopPreviewParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  res.json(StopPreviewResponse.parse(stopPreview(parsed.data.projectId)));
});
router.post("/mtech/projects/:projectId/preview/restart", async (req, res): Promise<void> => {
  const parsed = RestartPreviewParams.safeParse(req.params);
  if (!parsed.success || !guardProject(parsed.data.projectId, res)) return;
  stopPreview(parsed.data.projectId);
  try { res.json(RestartPreviewResponse.parse(await startPreview(parsed.data.projectId))); } catch (error) { bad(res, 422, error instanceof Error ? error.message : "Preview could not be restarted."); }
});

export default router;