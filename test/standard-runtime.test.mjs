import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { superviseStandardRuntime } from "../src/standard-runtime.mjs";

class FakeChild extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.pid = 1;
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
  }

  exit(code = 0, signal = null) {
    if (this.exitCode != null || this.signalCode != null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  fail(error) {
    this.emit("error", error);
  }

  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    this.exit(null, signal);
    return true;
  }
}

function never() {
  return new Promise(() => {});
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("restarts an exited app-server without terminating the live TUI", async () => {
  const firstAppServer = new FakeChild("app-server-1");
  const secondAppServer = new FakeChild("app-server-2");
  const tui = new FakeChild("tui");
  const starts = [];
  const logs = [];

  const running = superviseStandardRuntime({
    initialAppServer: firstAppServer,
    tui,
    signalPromise: never(),
    restartDelaysMs: [0],
    startAppServer() {
      starts.push(secondAppServer);
      return secondAppServer;
    },
    waitForAppServerReady: async () => {},
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });

  firstAppServer.exit(17);
  await waitFor(() => starts.length === 1);

  assert.deepEqual(tui.kills, []);
  assert.ok(logs.some((message) => message.includes("App-server restarted")));

  tui.exit(0);
  assert.deepEqual(await running, { type: "tui", code: 0, signal: null });
  assert.deepEqual(secondAppServer.kills, ["SIGTERM"]);
});

test("keeps retrying app-server startup with capped delays while the TUI is alive", async () => {
  const firstAppServer = new FakeChild("app-server-1");
  const failedReplacement = new FakeChild("app-server-2");
  const healthyReplacement = new FakeChild("app-server-3");
  const finalReplacement = new FakeChild("app-server-4");
  const tui = new FakeChild("tui");
  const replacements = [failedReplacement, healthyReplacement, finalReplacement];
  const observedDelays = [];

  const running = superviseStandardRuntime({
    initialAppServer: firstAppServer,
    tui,
    signalPromise: never(),
    restartDelaysMs: [10, 20],
    delay: async (delayMs) => observedDelays.push(delayMs),
    startAppServer() {
      return replacements.shift();
    },
    waitForAppServerReady: async (child) => {
      if (child === failedReplacement) throw new Error("readiness failed");
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  firstAppServer.exit(17);
  await waitFor(() => replacements.length === 1);

  assert.deepEqual(observedDelays, [10, 20]);
  assert.deepEqual(tui.kills, []);

  healthyReplacement.exit(18);
  await waitFor(() => observedDelays.length === 3);
  assert.deepEqual(observedDelays, [10, 20, 20]);
  await waitFor(() => replacements.length === 0);

  tui.exit(0);
  await running;
  assert.deepEqual(finalReplacement.kills, ["SIGTERM"]);
});

test("keeps retrying when a replacement emits an asynchronous spawn error", async () => {
  const firstAppServer = new FakeChild("app-server-1");
  const failedReplacement = new FakeChild("app-server-2");
  const healthyReplacement = new FakeChild("app-server-3");
  const tui = new FakeChild("tui");
  const replacements = [failedReplacement, healthyReplacement];

  const running = superviseStandardRuntime({
    initialAppServer: firstAppServer,
    tui,
    signalPromise: never(),
    restartDelaysMs: [0],
    startAppServer: () => replacements.shift(),
    waitForAppServerReady: (child) => child === failedReplacement ? never() : Promise.resolve(),
    logger: { info() {}, warn() {}, error() {} },
  });

  firstAppServer.exit(17);
  await waitFor(() => replacements.length === 1);
  failedReplacement.fail(new Error("spawn ENOENT"));
  await waitFor(() => replacements.length === 0);
  tui.exit(0);

  assert.deepEqual(await running, { type: "tui", code: 0, signal: null });
  assert.deepEqual(healthyReplacement.kills, ["SIGTERM"]);
});

test("reports an asynchronous TUI spawn error as a failed outcome", async () => {
  const appServer = new FakeChild("app-server");
  const tui = new FakeChild("tui");
  const running = superviseStandardRuntime({
    initialAppServer: appServer,
    tui,
    signalPromise: never(),
    startAppServer() { throw new Error("not reached"); },
    waitForAppServerReady: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const error = new Error("spawn TUI ENOENT");
  tui.fail(error);
  assert.deepEqual(await running, { type: "tui", code: null, signal: null, error });
  assert.deepEqual(appServer.kills, ["SIGTERM"]);
});
