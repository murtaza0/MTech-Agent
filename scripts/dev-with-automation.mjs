#!/usr/bin/env node

/**
 * MTech Colab full-stack launcher.
 *
 * Colab-safe launcher. It starts the MTech API, OpenHands agent-server,
 * automation, Vite, and ingress from the current MTech checkout. The
 * compatibility module under tools/ is explicitly added to PYTHONPATH and
 * imported by agent-server so legacy persisted conversation metadata does not
 * abort startup.
 */

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PORT || 8000);
const API_PORT = Number(process.env.OH_CANVAS_SAFE_API_PORT || 18002);
const AGENT_PORT = Number(process.env.OH_CANVAS_SAFE_BACKEND_PORT || 18000);
const AUTOMATION_PORT = Number(process.env.OH_CANVAS_SAFE_AUTOMATION_PORT || 18001);
const VITE_PORT = Number(process.env.VITE_FRONTEND_PORT || process.env.VITE_PORT || 3001);
const VSCODE_PORT = Number(process.env.OH_CANVAS_SAFE_VSCODE_PORT || (AGENT_PORT + 1));
const STATE_DIR = process.env.OH_CANVAS_SAFE_STATE_DIR || join(process.env.HOME || "/content/mtech-home", ".openhands", "agent-canvas");
const API_KEY_FILE = join(STATE_DIR, "api-key.txt");
const SECRET_KEY_FILE = join(STATE_DIR, "secret-key.txt");

const processes = new Map();
let shuttingDown = false;

function log(name, message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${name}] ${message}`);
}

function readOrCreate(file, envName) {
  mkdirSync(dirname(file), { recursive: true });
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const value = readFileSync(file, "utf8").trim();
    if (value) return value;
  } catch {}
  const value = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  try { writeFileSync(file, `${value}\n`, { mode: 0o600 }); } catch {}
  return value;
}

function spawnService(name, command, args, extraEnv = {}) {
  log(name, `starting: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false,
  });
  processes.set(name, child);
  child.stdout.on("data", b => b.toString().split(/\r?\n/).filter(Boolean).forEach(x => log(name, x)));
  child.stderr.on("data", b => b.toString().split(/\r?\n/).filter(Boolean).forEach(x => log(name, x)));
  child.on("error", e => log(name, `ERROR: ${e.message}`));
  child.on("exit", (code, signal) => {
    if (!shuttingDown) log(name, `exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    processes.delete(name);
  });
  return child;
}

async function waitFor(url, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function routeFor(pathname) {
  if (pathname === "/server_info" || pathname === "/health" || pathname === "/ready" || pathname === "/alive" || pathname === "/docs" || pathname === "/redoc" || pathname === "/openapi.json" || pathname === "/sockets" || pathname.startsWith("/sockets/")) return `http://127.0.0.1:${AGENT_PORT}`;
  if (pathname === "/vscode" || pathname.startsWith("/vscode/")) return `http://127.0.0.1:${VSCODE_PORT}`;
  if (pathname === "/api/automation" || pathname.startsWith("/api/automation/")) return `http://127.0.0.1:${AUTOMATION_PORT}`;
  if (pathname === "/api/healthz" || pathname === "/api/healthz/" || pathname === "/api/mtech" || pathname.startsWith("/api/mtech/")) return `http://127.0.0.1:${API_PORT}`;
  if (pathname === "/api" || pathname.startsWith("/api/")) return `http://127.0.0.1:${AGENT_PORT}`;
  return `http://127.0.0.1:${VITE_PORT}`;
}

function proxyHttp(req, res) {
  const target = new URL(routeFor(new URL(req.url || "/", "http://localhost").pathname));
  const upstream = httpRequest({
    hostname: target.hostname,
    port: Number(target.port),
    path: req.url || "/",
    method: req.method,
    headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
  }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  upstream.on("error", e => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Bad Gateway: ${e.message}`);
  });
  req.pipe(upstream);
}

function proxyWebSocket(req, socket, head) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const target = new URL(routeFor(pathname));
  const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
  upstream.on("connect", () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    const requestHead = `${req.method} ${req.url || "/"} HTTP/${req.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`;
    upstream.write(requestHead);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const fail = () => { try { socket.destroy(); } catch {} try { upstream.destroy(); } catch {} };
  upstream.on("error", fail);
  socket.on("error", () => { try { upstream.destroy(); } catch {} });
}

function startIngress() {
  const server = createServer(proxyHttp);
  server.on("upgrade", proxyWebSocket);
  server.on("clientError", (_e, socket) => socket.destroy());
  server.listen(PORT, "0.0.0.0", () => log("ingress", `listening on http://127.0.0.1:${PORT}`));
  processes.set("ingress", server);
}

async function seedSecret(apiKey) {
  try {
    const response = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/settings/secrets`, {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Session-API-Key": apiKey },
      body: JSON.stringify({
        name: "OPENHANDS_AUTOMATION_API_KEY",
        value: apiKey,
        description: "MTech local automation API key",
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) log("secrets", `warning: seed returned HTTP ${response.status}`);
  } catch (e) { log("secrets", `warning: ${e.message}`); }
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const apiKey = readOrCreate(API_KEY_FILE, "LOCAL_BACKEND_API_KEY");
  const secretKey = readOrCreate(SECRET_KEY_FILE, "OH_SECRET_KEY");
  process.env.LOCAL_BACKEND_API_KEY = apiKey;
  process.env.OH_SECRET_KEY = secretKey;
  process.env.OH_SESSION_API_KEYS_0 = apiKey;
  process.env.OH_PERSISTENCE_DIR = dirname(STATE_DIR);
  process.env.OH_CANVAS_SAFE_STATE_DIR = STATE_DIR;

  const python = process.env.OH_PYTHON || "/content/openhands-venv/bin/python";
  const toolsDir = join(ROOT, "tools");
  const agentEnv = {
    PYTHONPATH: [toolsDir, process.env.PYTHONPATH].filter(Boolean).join(":"),
    PYTHONUTF8: "1",
    OH_PERSISTENCE_DIR: dirname(STATE_DIR),
    OH_CONVERSATIONS_PATH: join(STATE_DIR, "dev_conversations"),
    OH_BASH_EVENTS_DIR: join(STATE_DIR, "bash_events"),
    OH_SECRET_KEY: secretKey,
    OH_SESSION_API_KEYS_0: apiKey,
    AGENT_SERVER_URL: `http://127.0.0.1:${AGENT_PORT}`,
    OH_EXTRA_PYTHON_PATH: toolsDir,
    TMUX_TMPDIR: join(STATE_DIR, "tmux"),
    OH_VSCODE_PORT: String(VSCODE_PORT),
    OH_VSCODE_BASE_PATH: "/vscode",
    OPENHANDS_SUPPRESS_BANNER: "1",
  };
  for (const p of [agentEnv.OH_CONVERSATIONS_PATH, agentEnv.OH_BASH_EVENTS_DIR, agentEnv.TMUX_TMPDIR]) mkdirSync(p, { recursive: true });

  const agent = spawnService("agent-server", python, ["-m", "openhands.agent_server", "--host", "127.0.0.1", "--port", String(AGENT_PORT), "--extra-python-path", toolsDir, "--import-modules", "canvas_ui_tool"], agentEnv);
  const agentReady = await waitFor(`http://127.0.0.1:${AGENT_PORT}/server_info`, 90000);
  if (!agentReady) throw new Error(`Agent Server did not open ${AGENT_PORT}`);
  log("agent-server", `READY http://127.0.0.1:${AGENT_PORT}`);
  await seedSecret(apiKey);

  const api = spawnService("mtech-api", "pnpm", ["--filter", "@workspace/api-server", "dev"], {
    PORT: String(API_PORT),
    NODE_ENV: "development",
    MTECH_STATE_DIR: STATE_DIR,
    MTECH_PROJECTS_DIR: join(STATE_DIR, "workspaces"),
    LOCAL_BACKEND_API_KEY: apiKey,
    OPENHANDS_AGENT_SERVER_URL: `http://127.0.0.1:${AGENT_PORT}`,
    OPENHANDS_AGENT_SERVER_API_KEY: apiKey,
  });
  const apiReady = await waitFor(`http://127.0.0.1:${API_PORT}/api/mtech/health`, 90000);
  if (!apiReady) {
    try { if (api?.pid) process.kill(-api.pid, "SIGTERM"); } catch {}
    throw new Error(`MTech API did not open ${API_PORT}`);
  }
  log("mtech-api", `READY http://127.0.0.1:${API_PORT}`);

  spawnService("automation", "uvx", ["--from", "openhands-automation", "uvicorn", "openhands.automation.app:app", "--host", "127.0.0.1", "--port", String(AUTOMATION_PORT)], {
    PYTHONUTF8: "1",
    AUTOMATION_AGENT_SERVER_URL: `http://127.0.0.1:${AGENT_PORT}`,
    AUTOMATION_AGENT_SERVER_API_KEY: apiKey,
    AUTOMATION_LOCAL_API_KEY: apiKey,
    AUTOMATION_KV_SECRET: apiKey,
    AUTOMATION_DB_URL: `sqlite+aiosqlite:///${join(STATE_DIR, "automations.db")}`,
    AUTOMATION_BASE_URL: `http://127.0.0.1:${PORT}`,
    AUTOMATION_WORKSPACE_BASE: join(STATE_DIR, "workspaces"),
    AUTOMATION_CORS_ORIGINS: `http://127.0.0.1:${PORT},http://localhost:${PORT},http://127.0.0.1:${VITE_PORT},http://localhost:${VITE_PORT}`,
    FILE_STORE: "local",
    LOCAL_STORAGE_PATH: join(STATE_DIR, "storage"),
    OPENHANDS_SUPPRESS_BANNER: "1",
  });
  mkdirSync(join(STATE_DIR, "workspaces"), { recursive: true });
  mkdirSync(join(STATE_DIR, "storage"), { recursive: true });

  spawnService("vite", "pnpm", ["--filter", "@workspace/mtech", "dev", "--", "--host", "0.0.0.0", "--port", String(VITE_PORT)], {
    VITE_BACKEND_HOST: `127.0.0.1:${PORT}`,
    VITE_WORKING_DIR: process.env.VITE_WORKING_DIR || ROOT,
    VITE_SESSION_API_KEY: apiKey,
    VITE_VSCODE_BASE_PATH: "/vscode",
    VITE_VSCODE_TARGET: `http://127.0.0.1:${VSCODE_PORT}`,
  });

  await new Promise(r => setTimeout(r, 1500));
  startIngress();
  log("mtech", "FULL STACK READY");
  log("mtech", `UI: http://127.0.0.1:${PORT}`);
  log("mtech", `MTech API: http://127.0.0.1:${API_PORT}`);
  log("mtech", `Agent: http://127.0.0.1:${AGENT_PORT}`);
  log("mtech", `Automation: http://127.0.0.1:${AUTOMATION_PORT}`);
  log("mtech", `Frontend: http://127.0.0.1:${VITE_PORT}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [name, p] of processes) {
    try {
      if (typeof p.close === "function") p.close();
      else if (p.pid) {
        if (process.platform === "win32") p.kill("SIGTERM");
        else process.kill(-p.pid, "SIGTERM");
      }
    } catch {}
    log(name, "stopping");
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

main().catch(err => {
  console.error(`FATAL: ${err.stack || err.message || err}`);
  shutdown(1);
});
