#!/usr/bin/env node

/**
 * MTech Colab full-stack launcher.
 *
 * Colab-safe launcher. It starts the MTech API, OpenHands agent-server,
 * automation, Vite, code-server, and ingress from the current MTech checkout.
 */

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PORT || 8000);
const API_PORT = Number(process.env.OH_CANVAS_SAFE_API_PORT || 18002);
const AGENT_PORT = Number(process.env.OH_CANVAS_SAFE_BACKEND_PORT || 18000);
const AUTOMATION_PORT = Number(process.env.OH_CANVAS_SAFE_AUTOMATION_PORT || 18001);
const VITE_PORT = Number(process.env.VITE_FRONTEND_PORT || process.env.VITE_PORT || 3001);
const VSCODE_PORT = Number(process.env.OH_CANVAS_SAFE_VSCODE_PORT || 18003);
const STATE_DIR = process.env.OH_CANVAS_SAFE_STATE_DIR || join(process.env.HOME || "/content/mtech-home", ".openhands", "agent-canvas");
const CODE_SERVER_BIN = process.env.CODE_SERVER_BIN || "/opt/mtech-code-server/bin/code-server";
const CODE_SERVER_ROOT = process.env.MTECH_WORKSPACE_ROOT || process.env.MTECH_PROJECTS_ROOT || join(ROOT, ".mtech", "workspace");
const CODE_SERVER_DATA = process.env.CODE_SERVER_DATA_DIR || join(STATE_DIR, "code-server");
const CODE_SERVER_CONFIG = process.env.CODE_SERVER_CONFIG_DIR || join(CODE_SERVER_DATA, "config");
const CODE_SERVER_LOG = process.env.CODE_SERVER_LOG || join(CODE_SERVER_DATA, "code-server.log");
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

async function waitFor(url, ms = 60000, label = url) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready within ${ms}ms`);
}

function tailFile(file, lines = 120) {
  try {
    const text = readFileSync(file, "utf8");
    return text.split(/\r?\n/).slice(-lines).join("\n").trim();
  } catch (e) {
    return `(unable to read ${file}: ${e.message})`;
  }
}

async function waitForCodeServer(child, ms = 60000) {
  const health = `http://127.0.0.1:${VSCODE_PORT}/healthz`;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`code-server exited with code=${child.exitCode}; log:\n${tailFile(CODE_SERVER_LOG)}`);
    }
    try {
      const r = await fetch(health, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`code-server health check failed on :${VSCODE_PORT}; log:\n${tailFile(CODE_SERVER_LOG)}`);
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
      body: JSON.stringify({ name: "OPENHANDS_AUTOMATION_API_KEY", value: apiKey, description: "MTech local automation API key" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) log("secrets", `warning: seed returned HTTP ${response.status}`);
  } catch (e) { log("secrets", `warning: ${e.message}`); }
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(CODE_SERVER_DATA, { recursive: true });
  mkdirSync(CODE_SERVER_CONFIG, { recursive: true });
  mkdirSync(CODE_SERVER_ROOT, { recursive: true });
  const apiKey = readOrCreate(API_KEY_FILE, "LOCAL_BACKEND_API_KEY");
  const secretKey = readOrCreate(SECRET_KEY_FILE, "OH_SECRET_KEY");
  process.env.LOCAL_BACKEND_API_KEY = apiKey;
  process.env.OH_SECRET_KEY = secretKey;
  process.env.OH_SESSION_API_KEYS_0 = apiKey;
  process.env.OH_PERSISTENCE_DIR = dirname(STATE_DIR);
  process.env.OH_CANVAS_SAFE_STATE_DIR = STATE_DIR;

  const python = process.env.OH_PYTHON || "/content/mtech-python/bin/python";
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

  spawnService("agent-server", python, ["-m", "openhands.agent_server", "--host", "127.0.0.1", "--port", String(AGENT_PORT), "--extra-python-path", toolsDir, "--import-modules", "canvas_ui_tool"], agentEnv);
  await waitFor(`http://127.0.0.1:${AGENT_PORT}/server_info`, 90000, "Agent Server");
  log("agent-server", `READY http://127.0.0.1:${AGENT_PORT}`);
  await seedSecret(apiKey);

  spawnService("mtech-api", "pnpm", ["--filter", "@workspace/api-server", "dev"], {
    PORT: String(API_PORT), NODE_ENV: "development", MTECH_STATE_DIR: STATE_DIR,
    MTECH_PROJECTS_DIR: join(STATE_DIR, "workspaces"), LOCAL_BACKEND_API_KEY: apiKey,
    OPENHANDS_AGENT_SERVER_URL: `http://127.0.0.1:${AGENT_PORT}`, OPENHANDS_AGENT_SERVER_API_KEY: apiKey,
  });
  await waitFor(`http://127.0.0.1:${API_PORT}/api/mtech/health`, 90000, "MTech API");
  log("mtech-api", `READY http://127.0.0.1:${API_PORT}`);

  spawnService("automation", "uvx", ["--from", "openhands-automation", "uvicorn", "openhands.automation.app:app", "--host", "127.0.0.1", "--port", String(AUTOMATION_PORT)], {
    PYTHONUTF8: "1", AUTOMATION_AGENT_SERVER_URL: `http://127.0.0.1:${AGENT_PORT}`,
    AUTOMATION_AGENT_SERVER_API_KEY: apiKey, AUTOMATION_LOCAL_API_KEY: apiKey, AUTOMATION_KV_SECRET: apiKey,
    AUTOMATION_DB_URL: `sqlite+aiosqlite:///${join(STATE_DIR, "automations.db")}`,
    AUTOMATION_BASE_URL: `http://127.0.0.1:${PORT}`, AUTOMATION_WORKSPACE_BASE: join(STATE_DIR, "workspaces"),
    AUTOMATION_CORS_ORIGINS: `http://127.0.0.1:${PORT},http://localhost:${PORT},http://127.0.0.1:${VITE_PORT},http://localhost:${VITE_PORT}`,
    FILE_STORE: "local", LOCAL_STORAGE_PATH: join(STATE_DIR, "storage"), OPENHANDS_SUPPRESS_BANNER: "1",
  });
  mkdirSync(join(STATE_DIR, "workspaces"), { recursive: true });
  mkdirSync(join(STATE_DIR, "storage"), { recursive: true });
  await waitFor(`http://127.0.0.1:${AUTOMATION_PORT}/health`, 90000, "Automation");
  log("automation", `READY http://127.0.0.1:${AUTOMATION_PORT}`);

  spawnService("vite", "pnpm", ["--filter", "@workspace/mtech", "dev", "--", "--host", "0.0.0.0", "--port", String(VITE_PORT)], {
    VITE_BACKEND_HOST: `127.0.0.1:${PORT}`, VITE_WORKING_DIR: process.env.VITE_WORKING_DIR || ROOT,
    VITE_SESSION_API_KEY: apiKey, VITE_VSCODE_BASE_PATH: "/vscode", VITE_VSCODE_TARGET: `http://127.0.0.1:${VSCODE_PORT}`,
  });
  await waitFor(`http://127.0.0.1:${VITE_PORT}`, 60000, "Frontend");
  log("vite", `READY http://127.0.0.1:${VITE_PORT}`);

  if (!existsSync(CODE_SERVER_BIN)) throw new Error(`code-server binary not found: ${CODE_SERVER_BIN}`);
  const codeServerEnv = {
    HOME: process.env.HOME || "/content/mtech-home",
    XDG_CONFIG_HOME: CODE_SERVER_CONFIG,
    XDG_DATA_HOME: CODE_SERVER_DATA,
    CODE_SERVER_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
  const codeServer = spawnService("code-server", CODE_SERVER_BIN, [
    "--auth", "none",
    "--bind-addr", `127.0.0.1:${VSCODE_PORT}`,
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-workspace-trust",
    CODE_SERVER_ROOT,
  ], codeServerEnv);
  await waitForCodeServer(codeServer, 60000);
  log("code-server", `READY http://127.0.0.1:${VSCODE_PORT}/healthz`);

  startIngress();
  await waitFor(`http://127.0.0.1:${PORT}`, 30000, "Ingress");
  log("mtech", "FULL STACK READY");
  log("mtech", `UI: http://127.0.0.1:${PORT}`);
  log("mtech", `Workspace: ${CODE_SERVER_ROOT}`);
  log("mtech", `code-server: http://127.0.0.1:${VSCODE_PORT}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [name, p] of processes) {
    try {
      if (typeof p.close === "function") p.close();
      else if (p.pid) process.platform === "win32" ? p.kill("SIGTERM") : process.kill(-p.pid, "SIGTERM");
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
