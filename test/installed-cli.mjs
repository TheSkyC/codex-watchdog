import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { shell = process.platform === "win32", ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      shell,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const root = mkdtempSync(path.join(tmpdir(), "codex-watchdog-installed-cli-"));
try {
  const packResult = await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--json", "--pack-destination", root],
    { cwd: repositoryRoot },
  );
  assert.equal(packResult.code, 0, packResult.stderr);
  const packed = JSON.parse(packResult.stdout);
  const tarball = path.join(root, packed[0].filename);
  const installRoot = path.join(root, "install");
  const installResult = await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--prefix", installRoot, tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: root },
  );
  assert.equal(installResult.code, 0, installResult.stderr);

  const recordPath = path.join(root, "tui-invocation.json");
  const fakeCodexPath = path.join(root, "fake-codex.mjs");
  const wsModuleUrl = pathToFileURL(path.join(installRoot, "node_modules", "ws", "index.js")).href;
  writeFileSync(fakeCodexPath, `
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "app-server") {
  let generation = 1;
  if (process.env.FAKE_CODEX_APP_SERVER_COUNT) {
    try {
      generation = Number(readFileSync(process.env.FAKE_CODEX_APP_SERVER_COUNT, "utf8")) + 1;
    } catch {}
    writeFileSync(process.env.FAKE_CODEX_APP_SERVER_COUNT, String(generation));
  }
  const listenIndex = args.indexOf("--listen");
  const address = new URL(args[listenIndex + 1]);
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/readyz" ? 200 : 404);
    response.end();
  });
  if (process.env.FAKE_CODEX_CRASH_ONCE === "1") {
    const wsModule = await import(process.env.FAKE_CODEX_WS_MODULE);
    const WebSocketServer = wsModule.WebSocketServer ?? wsModule.default.WebSocketServer;
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
        } else if (message.method === "test/ping") {
          socket.send(JSON.stringify({ id: message.id, result: { pong: true } }));
        }
      });
    });
  }
  server.listen(Number(address.port), address.hostname);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.env.FAKE_CODEX_CRASH_ONCE === "1" && generation === 1) {
    setTimeout(() => process.exit(17), 200);
  }
} else {
  writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, cwd: process.cwd() }));
  if (process.env.FAKE_CODEX_CRASH_ONCE === "1") {
    const remoteIndex = args.indexOf("--remote");
    const socket = new WebSocket(args[remoteIndex + 1]);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const waitForResponse = (id) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("response timeout: " + id)), 5000);
      const onMessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolve(message);
      };
      socket.addEventListener("message", onMessage);
    });
    const initialized = waitForResponse("fake-initialize");
    socket.send(JSON.stringify({
      method: "initialize",
      id: "fake-initialize",
      params: { clientInfo: { name: "codex_cli", title: "Fake Codex", version: "1" } },
    }));
    await initialized;
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(process.env.FAKE_CODEX_APP_SERVER_COUNT) &&
          Number(readFileSync(process.env.FAKE_CODEX_APP_SERVER_COUNT, "utf8")) >= 2) {
        const pong = waitForResponse("after-restart");
        socket.send(JSON.stringify({ method: "test/ping", id: "after-restart", params: {} }));
        await pong;
        socket.close();
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.exit(19);
  }
}
`, "utf8");
  const fakeCheck = await run(process.execPath, ["--check", fakeCodexPath], {
    cwd: root,
    shell: false,
  });
  assert.equal(fakeCheck.code, 0, fakeCheck.stderr);
  const fakePreflight = await run(
    process.execPath,
    [fakeCodexPath, "app-server", "--listen", "ws://127.0.0.1:0"],
    {
      cwd: root,
      shell: false,
      env: {
        ...process.env,
        FAKE_CODEX_APP_SERVER_COUNT: path.join(root, "preflight-count"),
        FAKE_CODEX_CRASH_ONCE: "1",
        FAKE_CODEX_WS_MODULE: wsModuleUrl,
      },
    },
  );
  assert.equal(fakePreflight.code, 17, fakePreflight.stderr);

  const targetDirectory = path.join(root, "target-project");
  mkdirSync(targetDirectory);
  const canonicalTargetDirectory = realpathSync(targetDirectory);
  const binName = process.platform === "win32" ? "codex-watchdog.cmd" : "codex-watchdog";
  const installedBin = path.join(installRoot, "node_modules", ".bin", binName);
  const cliResult = await run(installedBin, ["--version"], {
    cwd: targetDirectory,
    env: {
      ...process.env,
      CODEX_WATCHDOG_CODEX_JS: fakeCodexPath,
      FAKE_CODEX_RECORD: recordPath,
    },
  });
  assert.equal(cliResult.code, 0, cliResult.stderr);

  const invocation = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(invocation.cwd, canonicalTargetDirectory);
  assert.equal(invocation.args[0], "--remote");
  assert.match(invocation.args[1], /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(invocation.args.slice(2), ["-C", canonicalTargetDirectory, "--version"]);

  const appServerCountPath = path.join(root, "app-server-count");
  const survivedRecordPath = path.join(root, "survived-tui-invocation.json");
  const recoveryResult = await run(installedBin, ["--version"], {
    cwd: targetDirectory,
    env: {
      ...process.env,
      CODEX_WATCHDOG_CODEX_JS: fakeCodexPath,
      FAKE_CODEX_RECORD: survivedRecordPath,
      FAKE_CODEX_APP_SERVER_COUNT: appServerCountPath,
      FAKE_CODEX_CRASH_ONCE: "1",
      FAKE_CODEX_WS_MODULE: wsModuleUrl,
    },
  });
  assert.equal(recoveryResult.code, 0, recoveryResult.stderr);
  assert.equal(Number(readFileSync(appServerCountPath, "utf8")), 2);
  assert.equal(existsSync(survivedRecordPath), true);
  process.stdout.write("installed codex-watchdog command forwarded cwd and arguments correctly\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
