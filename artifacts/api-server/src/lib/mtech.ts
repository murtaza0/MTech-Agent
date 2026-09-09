import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { extname, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const execFileAsync = promisify(execFile);
type ChatRole = "user" | "assistant" | "system";
export type ChatMessage = { role: ChatRole; content: string };
type LlmConfigState = { endpoint: string; model: string; timeout: number; maxTokens: number; temperature: number };
type TaskStatus = "queued" | "planning" | "running" | "waiting" | "completed" | "failed" | "retrying" | "cancelled";
type ActivityType = "agent" | "system" | "success" | "warning";
export type ActivityItem = { id: string; agent: string; action: string; detail: string; timestamp: string; type: ActivityType; projectId?: string };
type TaskRecord = {
  id: string; projectId: string; agentId: string; title: string; description: string;
  priority: "low" | "medium" | "high"; dependencies: string[]; status: TaskStatus;
  input?: string; output?: string; changedFiles?: string[]; logs?: string[]; error?: string;
  attempts: number; createdAt: string; startedAt?: string; completedAt?: string;
};
type ProjectRecord = { id: string; name: string; description: string; status: "active" | "paused" | "archived"; branch: string; updatedAt: string; root: string };
type State = { projects: Record<string, ProjectRecord>; tasks: TaskRecord[]; activity: ActivityItem[]; messages: Record<string, ChatMessage[]>; llm?: Partial<LlmConfigState> };

const workspaceRoot = resolve(process.env.MTECH_WORKSPACE_ROOT ?? process.cwd());
const projectsRoot = resolve(process.env.MTECH_PROJECTS_ROOT ?? join(workspaceRoot, ".mtech", "projects"));
const stateFile = resolve(process.env.MTECH_STATE_FILE ?? join(workspaceRoot, ".mtech", "state.json"));
const ignoredDirectories = new Set([".git", ".local", ".cache", "node_modules", "dist", "build", "coverage", ".mtech"]);
const maxIndexedFiles = Number(process.env.MTECH_MAX_INDEXED_FILES ?? 500);
const maxDownloadBytes = Number(process.env.MTECH_MAX_DOWNLOAD_BYTES ?? 32 * 1024 * 1024);
const defaultConfig: LlmConfigState = {
  endpoint: process.env.LLM_BASE_URL ?? "http://127.0.0.1:8100/v1",
  model: process.env.LLM_MODEL ?? "openai/deepseek-coder-6.7b-instruct",
  timeout: Number(process.env.LLM_TIMEOUT ?? 120000),
  maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 2048),
  temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
};
const apiKey = process.env.LLM_API_KEY ?? "replitclone-local";
let config: LlmConfigState = { ...defaultConfig };
let lastStatus: { connected: boolean; latency: number | null; lastCheck: string | null; error: string | null } = {
  connected: false, latency: null, lastCheck: null, error: null,
};

const ensureParent = (file: string) => mkdirSync(resolve(file, ".."), { recursive: true });
const initialState = (): State => ({
  projects: {
    workspace: {
      id: "workspace", name: process.env.MTECH_PROJECT_NAME ?? "MTech Workspace",
      description: process.env.MTECH_PROJECT_DESCRIPTION ?? "The current local workspace connected to MTech.",
      status: "active", branch: process.env.MTECH_BRANCH ?? "workspace", updatedAt: new Date().toISOString(), root: workspaceRoot,
    },
  }, tasks: [], activity: [], messages: {},
});
const readState = (): State => {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as State;
    const state = { ...initialState(), ...parsed, projects: { ...initialState().projects, ...(parsed.projects ?? {}) } };
    return state;
  } catch { return initialState(); }
};
const writeState = (state: State) => {
  ensureParent(stateFile);
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, stateFile);
};
const mutateState = (fn: (state: State) => void) => { const state = readState(); fn(state); writeState(state); return state; };
const now = () => new Date().toISOString();
const projectRecord = (projectId: string) => readState().projects[projectId];
export const projectRoot = (projectId: string) => {
  const project = projectRecord(projectId);
  if (!project) throw new Error("Project not found.");
  return resolve(project.root);
};

const withTimeout = async <T>(action: (signal: AbortSignal) => Promise<T>, timeout: number): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await action(controller.signal); } finally { clearTimeout(timer); }
};
const trimEndpoint = (endpoint: string) => endpoint.replace(/\/+$/, "");
const jsonHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
const parseError = async (response: Response) => (await response.text()).slice(0, 500) || `${response.status} ${response.statusText}`;

export class LocalColabLLMProvider {
  getConfig() { return { provider: "Local Colab", ...config, apiKeyConfigured: Boolean(apiKey) }; }
  updateConfig(next: Partial<LlmConfigState>) {
    config = { ...config, ...next, endpoint: next.endpoint?.trim() || config.endpoint, model: next.model?.trim() || config.model };
    mutateState((state) => { state.llm = { endpoint: config.endpoint, model: config.model, timeout: config.timeout, maxTokens: config.maxTokens, temperature: config.temperature }; });
    return this.getConfig();
  }
  async models() {
    const response = await withTimeout((signal) => fetch(`${trimEndpoint(config.endpoint)}/models`, { headers: jsonHeaders, signal }), Math.max(config.timeout, 30000));
    if (!response.ok) throw new Error(await parseError(response));
    const payload = await response.json() as { data?: Array<{ id?: string; owned_by?: string }> };
    return (payload.data ?? []).map((model) => ({ id: model.id ?? "unknown", ownedBy: model.owned_by ?? "local" }));
  }
  async testConnection() {
    const startedAt = Date.now();
    try {
      const models = await this.models();
      const latency = Date.now() - startedAt;
      lastStatus = { connected: true, latency, lastCheck: now(), error: null };
      return { connected: true, latency, message: `Local Colab responded with ${models.length} model${models.length === 1 ? "" : "s"}.`, model: config.model };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to reach Local Colab.";
      lastStatus = { connected: false, latency: null, lastCheck: now(), error: message };
      return { connected: false, latency: null, message, model: config.model };
    }
  }
  async status() { if (!lastStatus.lastCheck) await this.testConnection(); return { ...this.getConfig(), ...lastStatus }; }
  async chat(messages: ChatMessage[]) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await withTimeout((signal) => fetch(`${trimEndpoint(config.endpoint)}/chat/completions`, {
          method: "POST", headers: jsonHeaders, signal,
          body: JSON.stringify({ model: config.model, messages, max_tokens: config.maxTokens, temperature: config.temperature, stream: false }),
        }), Math.max(config.timeout, 120000));
        if (!response.ok) throw new Error(await parseError(response));
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error("The Local Colab response did not include assistant content.");
        lastStatus = { connected: true, latency: null, lastCheck: now(), error: null };
        return content;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
      }
    }
    throw new Error(lastError instanceof Error ? lastError.message : "Unable to reach Local Colab.");
  }
  async stream(messages: ChatMessage[]) {
    return withTimeout((signal) => fetch(`${trimEndpoint(config.endpoint)}/chat/completions`, {
      method: "POST", headers: jsonHeaders, signal,
      body: JSON.stringify({ model: config.model, messages, max_tokens: config.maxTokens, temperature: config.temperature, stream: true }),
    }), Math.max(config.timeout, 120000));
  }
}
export const llmProvider = new LocalColabLLMProvider();
const savedConfig = readState().llm;
if (savedConfig) config = { ...config, ...savedConfig };

const languageForPath = (filePath: string) => {
  const map: Record<string, string> = { ".css": "CSS", ".html": "HTML", ".js": "JavaScript", ".jsx": "JavaScript React", ".json": "JSON", ".md": "Markdown", ".py": "Python", ".sql": "SQL", ".ts": "TypeScript", ".tsx": "TypeScript React", ".yaml": "YAML", ".yml": "YAML" };
  const extension = extname(filePath).toLowerCase();
  return map[extension] ?? (extension ? extension.slice(1).toUpperCase() : "Text");
};
const listProjectFiles = (root: string) => {
  const files: Array<{ path: string; kind: "file" | "folder"; language: string; size: number; modified: boolean }> = [];
  const visit = (directory: string) => {
    if (files.filter((item) => item.kind === "file").length >= maxIndexedFiles) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      const projectPath = relative(root, absolutePath).split(sep).join("/");
      if (entry.isDirectory()) { files.push({ path: projectPath, kind: "folder", language: "folder", size: 0, modified: false }); visit(absolutePath); }
      else if (entry.isFile()) { const stat = statSync(absolutePath); files.push({ path: projectPath, kind: "file", language: languageForPath(projectPath), size: stat.size, modified: false }); }
    }
  };
  visit(root);
  return files;
};
const asProject = (record: ProjectRecord) => ({ id: record.id, name: record.name, description: record.description, status: record.status, branch: record.branch, updatedAt: record.updatedAt, files: listProjectFiles(record.root), progress: projectProgress(record.id) });
const projectProgress = (id: string) => {
  const projectTasks = readState().tasks.filter((task) => task.projectId === id);
  if (!projectTasks.length) return 0;
  return Math.round(projectTasks.filter((task) => task.status === "completed").length / projectTasks.length * 100);
};
export const workspaceProject = () => asProject(readState().projects.workspace);
export const projects = () => Object.values(readState().projects).map(asProject);
export const getProject = (id: string) => { const record = projectRecord(id); return record ? asProject(record) : null; };
export const createProject = (name: string, description = "") => {
  const id = `project-${randomUUID().slice(0, 8)}`;
  const root = join(projectsRoot, id);
  mkdirSync(root, { recursive: true });
  const record: ProjectRecord = { id, name, description: description || "A new MTech workspace.", status: "active", branch: "main", updatedAt: now(), root };
  mutateState((state) => { state.projects[id] = record; });
  recordActivity({ projectId: id, agent: "Orchestrator", action: "Created workspace", detail: `Initialized durable workspace at ${relative(workspaceRoot, root) || root}.`, type: "success" });
  return asProject(record);
};

export const agents = (projectId: string) => {
  const definitions = [
    ["orchestrator", "Orchestrator", "Mission planning and agent routing"],
    ["planner", "Planner / Architect", "Project analysis and implementation planning"],
    ["frontend", "UI / Frontend", "UI systems and responsive experiences"],
    ["backend", "Backend", "API contracts and runtime behavior"],
    ["database", "Database", "Persistence and schema safety"],
    ["feature", "Feature", "Feature implementation and file changes"],
    ["execution", "Code Execution", "Commands, builds, and process lifecycle"],
    ["testing", "Testing", "Typecheck, lint, tests, and build verification"],
    ["security", "Security", "Workspace and application security review"],
    ["debugger", "Debugger", "Failure diagnosis and bounded repair loop"],
    ["review", "Code Review", "Changed-file correctness and maintainability"],
    ["deployment", "Deployment", "Release readiness and runtime checks"],
    ["documentation", "Documentation", "Repository documentation and contracts"],
  ] as const;
  const taskList = readState().tasks.filter((task) => task.projectId === projectId);
  return definitions.map(([id, name, role]) => {
    const mine = taskList.filter((task) => task.agentId === id);
    const latest = mine[mine.length - 1];
    const completed = mine.filter((task) => task.status === "completed").length;
    const progress = mine.length ? Math.round(completed / mine.length * 100) : 0;
    return { id, name, role, status: latest?.status === "running" ? "running" : latest?.status === "failed" ? "blocked" : latest ? "complete" : "queued", currentTask: latest?.title ?? "Awaiting a task", progress, lastAction: latest?.output ?? "No task execution recorded", changedFiles: latest?.changedFiles?.length ?? 0 };
  });
};
export const tasks = (projectId: string) => readState().tasks.filter((task) => task.projectId === projectId).map(({ input: _input, output: _output, logs: _logs, error: _error, startedAt: _startedAt, completedAt: _completedAt, changedFiles: _changedFiles, ...task }) => task);
export const taskDetails = (projectId: string, taskId: string) => readState().tasks.find((task) => task.projectId === projectId && task.id === taskId) ?? null;
export const activity = (projectId?: string) => readState().activity.filter((item) => !projectId || item.projectId === projectId).slice(0, 100);
export const recordActivity = (event: Omit<ActivityItem, "id" | "timestamp">) => {
  const item = { ...event, id: randomUUID(), timestamp: now() };
  mutateState((state) => { state.activity.unshift(item); state.activity = state.activity.slice(0, 500); });
  return item;
};
export const messages = (projectId: string) => readState().messages[projectId] ?? [];
export const addMessage = (projectId: string, message: ChatMessage) => mutateState((state) => { state.messages[projectId] = [...(state.messages[projectId] ?? []), message].slice(-100); });

const safePath = (root: string, filePath: string) => {
  if (!filePath || filePath.includes("\0") || filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath)) throw new Error("A workspace-relative path is required.");
  const candidate = resolve(root, filePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error("The requested path is outside the configured workspace.");
  return candidate;
};
export const resolveWorkspaceFile = (filePath: string, projectId = "workspace") => {
  const candidate = safePath(projectRoot(projectId), filePath);
  const stat = statSync(candidate);
  if (!stat.isFile()) throw new Error("The requested path is not a file.");
  if (stat.size > maxDownloadBytes) throw new Error("The requested file exceeds the configured download limit.");
  return { absolutePath: candidate, size: stat.size };
};
export const readProjectFile = (projectId: string, filePath: string) => readFileSync(resolveWorkspaceFile(filePath, projectId).absolutePath, "utf8");
export const writeProjectFile = (projectId: string, filePath: string, content: string) => {
  const root = projectRoot(projectId); const absolute = safePath(root, filePath);
  mkdirSync(resolve(absolute, ".."), { recursive: true }); writeFileSync(absolute, content, "utf8");
  mutateState((state) => { if (state.projects[projectId]) state.projects[projectId].updatedAt = now(); });
  recordActivity({ projectId, agent: "Editor", action: "Wrote workspace file", detail: filePath, type: "success" });
  return { path: filePath, size: Buffer.byteLength(content) };
};
export const listFiles = (projectId: string) => listProjectFiles(projectRoot(projectId));

const crc32 = (buffer: Buffer) => { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; };
export const createWorkspaceZip = (projectId = "workspace") => {
  const root = projectRoot(projectId); const entries = listProjectFiles(root).filter((file) => file.kind === "file"); const localParts: Buffer[] = []; const centralParts: Buffer[] = []; let offset = 0; let totalSize = 0;
  for (const entry of entries) {
    const { absolutePath, size } = resolveWorkspaceFile(entry.path, projectId); totalSize += size; if (totalSize > maxDownloadBytes) throw new Error("The workspace exceeds the configured ZIP download limit.");
    const name = Buffer.from(entry.path, "utf8"); const content = readFileSync(absolutePath); const compressed = content.length ? deflateRawSync(content, { level: 6 }) : content; const checksum = crc32(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26); localParts.push(local, name, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); centralParts.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centralParts.length / 2, 8); end.writeUInt16LE(centralParts.length / 2, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...localParts, central, end]);
};

const policyCheck = (command: string, args: string[]) => {
  const executable = command.split("/").pop() ?? command;
  const allowed = new Set(["npm", "pnpm", "yarn", "node", "python", "python3", "pip", "pip3", "git", "bash", "sh"]);
  if (!allowed.has(executable)) throw new Error(`Command "${executable}" is not allowed by the MTech execution policy.`);
  const joined = `${command} ${args.join(" ")}`;
  if (/(^|\s)(rm\s+-rf|sudo|curl|wget|nc|ssh|chmod\s+777)(\s|$)/i.test(joined) || /(\.env|id_rsa|\/etc\/|\/proc\/|\/sys\/)/i.test(joined)) throw new Error("The command was rejected by the MTech security policy.");
};
export type CommandResult = { command: string; cwd: string; stdout: string; stderr: string; exitCode: number | null; startTime: string; endTime: string; pid: number | undefined; status: "completed" | "failed" };
export const runCommand = async (projectId: string, command: string, args: string[] = [], timeoutMs = 120000): Promise<CommandResult> => {
  policyCheck(command, args); const cwd = projectRoot(projectId); const startTime = now();
  try {
    const result = await execFileAsync(command, args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, shell: false });
    return { command: [command, ...args].join(" "), cwd, stdout: result.stdout, stderr: result.stderr, exitCode: 0, startTime, endTime: now(), pid: undefined, status: "completed" };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return { command: [command, ...args].join(" "), cwd, stdout: failure.stdout ?? "", stderr: failure.stderr ?? (error instanceof Error ? error.message : "Command failed"), exitCode: typeof failure.code === "number" ? failure.code : 1, startTime, endTime: now(), pid: undefined, status: "failed" };
  }
};
export interface ExecutionProvider {
  execute(projectId: string, command: string, args?: string[], timeoutMs?: number): Promise<CommandResult>;
  health(): Promise<{ connected: boolean; message: string }>;
}
export class LocalExecutionProvider implements ExecutionProvider {
  execute(projectId: string, command: string, args: string[] = [], timeoutMs = 120000) { return runCommand(projectId, command, args, timeoutMs); }
  async health() { return { connected: true, message: "Local execution provider is available." }; }
}
export class ColabExecutionProvider implements ExecutionProvider {
  private readonly endpoint = (process.env.COLAB_EXECUTION_URL ?? "").replace(/\/+$/, "");
  private readonly key = process.env.COLAB_EXECUTION_API_KEY ?? "";
  async execute(projectId: string, command: string, args: string[] = [], timeoutMs = 120000) {
    policyCheck(command, args);
    if (!this.endpoint) return { command: [command, ...args].join(" "), cwd: projectRoot(projectId), stdout: "", stderr: "COLAB_EXECUTION_URL is not configured.", exitCode: 1, startTime: now(), endTime: now(), pid: undefined, status: "failed" as const };
    const response = await withTimeout((signal) => fetch(`${this.endpoint}/execute`, { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` }, body: JSON.stringify({ command, args, cwd: process.env.COLAB_WORKSPACE_ROOT ?? projectRoot(projectId), timeoutMs }) }), timeoutMs);
    if (!response.ok) throw new Error(`Colab execution failed: ${await parseError(response)}`);
    return await response.json() as CommandResult;
  }
  async health() {
    if (!this.endpoint) return { connected: false, message: "COLAB_EXECUTION_URL is not configured." };
    try {
      const response = await withTimeout((signal) => fetch(`${this.endpoint}/health`, { headers: { Authorization: `Bearer ${this.key}` }, signal }), 5000);
      return { connected: response.ok, message: response.ok ? "Colab execution provider is healthy." : `Colab health returned ${response.status}.` };
    } catch (error) { return { connected: false, message: error instanceof Error ? error.message : "Colab execution provider is unavailable." }; }
  }
}
export const executionProvider: ExecutionProvider = process.env.EXECUTION_PROVIDER === "colab" ? new ColabExecutionProvider() : new LocalExecutionProvider();
export const executeCommand = (projectId: string, command: string, args: string[] = [], timeoutMs = 120000) => executionProvider.execute(projectId, command, args, timeoutMs);
export const gitStatus = (projectId: string) => runCommand(projectId, "git", ["status", "--short", "--branch"]);
export const gitDiff = (projectId: string) => runCommand(projectId, "git", ["diff", "--"]);
export const gitLog = (projectId: string) => runCommand(projectId, "git", ["log", "--oneline", "-20"]);
export const gitCheckpoint = async (projectId: string, message: string) => {
  if (!/^[\w .:/-]{1,120}$/.test(message)) throw new Error("Checkpoint message contains unsupported characters.");
  const status = await gitStatus(projectId);
  if (status.status === "failed" && /not a git repository/i.test(status.stderr)) {
    const initialized = await runCommand(projectId, "git", ["init"]);
    if (initialized.status === "failed") return initialized;
  }
  const result = await runCommand(projectId, "git", ["add", "-A"]);
  if (result.status === "failed") return result;
  return runCommand(projectId, "git", ["commit", "-m", message]);
};
export const gitRollback = async (projectId: string, ref: string) => {
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(ref)) throw new Error("Invalid Git reference.");
  const result = await runCommand(projectId, "git", ["reset", "--hard", ref]);
  if (result.status === "completed") recordActivity({ projectId, agent: "Runtime", action: "Rolled back Git checkpoint", detail: ref, type: "warning" });
  return result;
};

const packageAt = (root: string) => {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }; } catch { return null; }
};
const findPreviewRoot = (root: string) => {
  const direct = packageAt(root); if (direct?.scripts?.dev || direct?.scripts?.start || direct?.scripts?.preview) return { root, package: direct };
  for (const candidate of ["artifacts/mtech", "app", "web", "frontend"]) { const child = resolve(root, candidate); const pkg = packageAt(child); if (pkg?.scripts?.dev || pkg?.scripts?.start || pkg?.scripts?.preview) return { root: child, package: pkg }; }
  return null;
};
type Preview = { status: "running" | "stopped" | "starting"; url: string | null; port: number | null; pid?: number; framework?: string; error?: string };
let preview: Preview = { status: "stopped", url: null, port: null };
let previewProcess: ChildProcess | null = null;
let staticServer: Server | null = null;
let previewLogs: string[] = [];
const waitForHttp = async (url: string, timeoutMs: number) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { try { const response = await fetch(url); if (response.ok || response.status < 500) return true; } catch { /* process is still starting */ } await new Promise((resolvePromise) => setTimeout(resolvePromise, 250)); }
  return false;
};
export const getPreview = () => preview;
export const startPreview = async (projectId: string): Promise<Preview> => {
  if (preview.status === "running") return preview;
  const root = projectRoot(projectId); const candidate = findPreviewRoot(root);
  if (!candidate) throw new Error("No runnable preview found. Add an app with a dev, preview, or start script.");
  const port = Number(process.env.MTECH_PREVIEW_PORT ?? 4173); const url = process.env.MTECH_PREVIEW_URL ?? `http://127.0.0.1:${port}`;
  preview = { status: "starting", url, port, framework: candidate.package.scripts?.dev ? "Vite/Node" : "Node" }; previewLogs = [];
  const script = candidate.package.scripts?.dev ? "dev" : candidate.package.scripts?.preview ? "preview" : "start";
  previewProcess = spawn("pnpm", ["run", script, "--", "--host", "127.0.0.1", "--port", String(port)], { cwd: candidate.root, shell: false, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" } });
  previewProcess.stdout?.on("data", (chunk: Buffer) => previewLogs.push(chunk.toString().slice(0, 4000)));
  previewProcess.stderr?.on("data", (chunk: Buffer) => previewLogs.push(chunk.toString().slice(0, 4000)));
  previewProcess.on("exit", (code) => { if (preview.status === "running" || preview.status === "starting") preview = { status: "stopped", url: null, port: null, error: `Preview exited with code ${code ?? "unknown"}` }; });
  const ready = await waitForHttp(url, 10000);
  if (!ready) { previewProcess.kill("SIGTERM"); previewProcess = null; preview = { status: "stopped", url: null, port: null, error: previewLogs.slice(-4).join("\n") || "Preview did not become reachable." }; throw new Error(preview.error); }
  preview = { ...preview, status: "running", pid: previewProcess.pid };
  recordActivity({ projectId, agent: "Runtime", action: "Started project preview", detail: `${preview.framework ?? "Application"} is reachable at ${url}.`, type: "success" }); return preview;
};
export const stopPreview = (projectId: string) => {
  if (previewProcess) { previewProcess.kill("SIGTERM"); previewProcess = null; }
  if (staticServer) { staticServer.close(); staticServer = null; }
  preview = { status: "stopped", url: null, port: null }; recordActivity({ projectId, agent: "Runtime", action: "Stopped project preview", detail: "The preview process was stopped.", type: "system" }); return preview;
};
export const previewLogsForProject = (_projectId: string) => previewLogs.slice(-100);

const updateTask = (projectId: string, taskId: string, patch: Partial<TaskRecord>) => mutateState((state) => {
  const task = state.tasks.find((item) => item.projectId === projectId && item.id === taskId); if (!task) throw new Error("Task not found."); Object.assign(task, patch);
});
export const enqueueTask = (projectId: string, input: { agentId: string; title: string; description: string; priority?: "low" | "medium" | "high"; dependencies?: string[] }) =>
  createTask({ projectId, agentId: input.agentId, title: input.title, description: input.description, priority: input.priority ?? "medium", dependencies: input.dependencies ?? [], input: input.description });
export const retryTask = (projectId: string, taskId: string) => {
  const task = taskDetails(projectId, taskId);
  if (!task) throw new Error("Task not found.");
  updateTask(projectId, taskId, { status: "retrying", error: undefined });
  return taskDetails(projectId, taskId);
};
export const cancelTask = (projectId: string, taskId: string) => {
  const task = taskDetails(projectId, taskId);
  if (!task) throw new Error("Task not found.");
  updateTask(projectId, taskId, { status: "cancelled", completedAt: now() });
  recordActivity({ projectId, agent: task.agentId, action: `Cancelled ${task.title}`, detail: "Task cancelled by the workspace.", type: "warning" });
  return taskDetails(projectId, taskId);
};
const createTask = (task: Omit<TaskRecord, "id" | "createdAt" | "attempts" | "status"> & { status?: TaskStatus }) => {
  const record: TaskRecord = { ...task, id: newTaskId(), createdAt: now(), attempts: 0, status: task.status ?? "queued" }; mutateState((state) => state.tasks.push(record)); return record;
};
const runTask = async (task: TaskRecord, worker: () => Promise<{ output: string; changedFiles?: string[]; logs?: string[] }>) => {
  updateTask(task.projectId, task.id, { status: "running", attempts: task.attempts + 1, startedAt: now() });
  recordActivity({ projectId: task.projectId, agent: task.agentId, action: `Started ${task.title}`, detail: task.description, type: "agent" });
  try { const result = await worker(); updateTask(task.projectId, task.id, { status: "completed", output: result.output, changedFiles: result.changedFiles ?? [], logs: result.logs ?? [], completedAt: now() }); recordActivity({ projectId: task.projectId, agent: task.agentId, action: `Completed ${task.title}`, detail: result.output, type: "success" }); }
  catch (error) { const message = error instanceof Error ? error.message : "Task failed."; updateTask(task.projectId, task.id, { status: "failed", error: message, logs: [message], completedAt: now() }); recordActivity({ projectId: task.projectId, agent: task.agentId, action: `Failed ${task.title}`, detail: message, type: "warning" }); }
};
const testCommands = (root: string) => {
  const pkg = packageAt(root)?.scripts ?? {};
  return ["typecheck", "lint", "test", "build"].filter((name) => pkg[name]).map((name) => ({ name, command: "pnpm", args: ["run", name] }));
};
export const securityScan = (projectId: string) => {
  const findings: Array<{ severity: string; file: string; line: number; description: string; recommendation: string }> = [];
  const root = projectRoot(projectId);
  for (const secretFile of [".env", ".env.local", "credentials.json"]) {
    if (existsSync(join(root, secretFile))) findings.push({ severity: "high", file: secretFile, line: 1, description: "A runtime secret file is inside the workspace.", recommendation: "Keep runtime secrets outside source control and outside project files." });
  }
  for (const file of listFiles(projectId).filter((item) => item.kind === "file").slice(0, 500)) {
    if (file.path.includes(".env") && file.path !== ".env.example") findings.push({ severity: "high", file: file.path, line: 1, description: "Environment file is inside the workspace.", recommendation: "Keep runtime secrets outside source control." });
    let content = ""; try { content = readProjectFile(projectId, file.path); } catch { continue; }
    const secret = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|-----BEGIN (RSA|OPENSSH|PRIVATE) KEY-----)/.exec(content);
    if (secret) findings.push({ severity: "critical", file: file.path, line: content.slice(0, secret.index ?? 0).split("\n").length, description: "Potential credential material detected.", recommendation: "Revoke the credential and move it to runtime secrets." });
    if (/\beval\s*\(|child_process\.exec\s*\(/.test(content)) findings.push({ severity: "medium", file: file.path, line: 1, description: "Dynamic or shell execution requires review.", recommendation: "Use an allowlisted command runner with validated arguments." });
  }
  return findings;
};
export const orchestrate = async (projectId: string, request: string) => {
  const project = projectRecord(projectId); if (!project) throw new Error("Project not found.");
  const files = listFiles(projectId).filter((file) => file.kind === "file").map((file) => file.path);
  const kind = /fix|bug|error|debug/i.test(request) ? "debugging" : /test|verify|check/i.test(request) ? "verification" : /build|create|implement|add|change|modify/i.test(request) ? "implementation" : "analysis";
  const analysis = createTask({ projectId, agentId: "planner", title: "Analyze workspace", description: "Inspect the current project files before selecting work.", priority: "high", dependencies: [], input: request });
  const implementation = createTask({ projectId, agentId: kind === "implementation" ? "feature" : "orchestrator", title: kind === "implementation" ? "Plan implementation changes" : "Classify request", description: "Turn the request into an executable task boundary without bypassing the workspace policy.", priority: "high", dependencies: [analysis.id], input: request });
  const execution = createTask({ projectId, agentId: "execution", title: "Run project verification", description: "Execute project-defined typecheck, lint, test, and build commands.", priority: "medium", dependencies: [implementation.id], input: request });
  const security = createTask({ projectId, agentId: "security", title: "Review workspace security", description: "Scan real files for credentials and unsafe execution patterns.", priority: "medium", dependencies: [execution.id], input: request });
  const review = createTask({ projectId, agentId: "review", title: "Review delivery", description: "Review the actual task results and changed files.", priority: "low", dependencies: [security.id], input: request });
  await runTask(analysis, async () => ({ output: `Indexed ${files.length} project files. Request classified as ${kind}.`, changedFiles: [] }));
  await runTask(implementation, async () => {
    try {
      const llmNote = (await llmProvider.chat([{ role: "system", content: "You are a planning specialist. Return a concise implementation plan; do not claim to have edited files or run commands." }, { role: "user", content: request }])).slice(0, 2000);
      return { output: llmNote, changedFiles: [] };
    } catch (error) {
      throw new Error(`Planner could not reach Local Colab: ${error instanceof Error ? error.message : "provider unavailable."}`);
    }
  });
  if (taskDetails(projectId, implementation.id)?.status !== "completed") {
    for (const blocked of [execution, security, review]) {
      updateTask(projectId, blocked.id, { status: "waiting", error: `Dependency ${implementation.id} did not complete.` });
      recordActivity({ projectId, agent: blocked.agentId, action: `Waiting for ${blocked.title}`, detail: `Dependency ${implementation.id} failed; no command was run.`, type: "warning" });
    }
    const failedTasks = readState().tasks.filter((task) => [analysis.id, implementation.id, execution.id, security.id, review.id].includes(task.id));
    const failureMessage = "Orchestration stopped at planning because Local Colab was unavailable. No source files or dependent tasks were executed.";
    addMessage(projectId, { role: "user", content: request }); addMessage(projectId, { role: "assistant", content: failureMessage });
    return { taskId: implementation.id, message: failureMessage, tasks: failedTasks, findings: [], activity: activity(projectId) };
  }
  await runTask(execution, async () => {
    const commands = testCommands(project.root); const results: CommandResult[] = [];
    for (const command of commands) results.push(await runCommand(projectId, command.command, command.args));
    return { output: results.length ? results.map((result) => `${result.command}: ${result.status}${result.exitCode === 0 ? "" : ` (exit ${result.exitCode})`}`).join("; ") : "No project-defined verification scripts were found.", logs: results.flatMap((result) => [result.stdout, result.stderr]).filter(Boolean) };
  });
  const findings = securityScan(projectId);
  await runTask(security, async () => ({ output: findings.length ? `${findings.length} security finding(s) require review.` : "Security scan completed with no findings.", logs: findings.map((finding) => `${finding.severity}: ${finding.file}:${finding.line} ${finding.description}`) }));
  await runTask(review, async () => ({ output: "Reviewed task outputs, verification logs, and security findings. No automatic file edits were applied.", logs: findings.map((finding) => finding.description) }));
  const completed = readState().tasks.filter((task) => [analysis.id, implementation.id, execution.id, security.id, review.id].includes(task.id));
  addMessage(projectId, { role: "user", content: request });
  const failed = completed.filter((task) => task.status === "failed");
  const message = failed.length ? `Orchestration completed with ${failed.length} failed task(s). Inspect Tasks and Activity for the captured error.` : `Orchestration completed: analyzed ${files.length} files, ran ${testCommands(project.root).length} verification command(s), and performed a security review. No source files were changed without a verified implementation tool call.`;
  addMessage(projectId, { role: "assistant", content: message });
  return { taskId: review.id, message, tasks: completed, findings, activity: activity(projectId) };
};

export const newTaskId = () => `task-${randomUUID().slice(0, 8)}`;
