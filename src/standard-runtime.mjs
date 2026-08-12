const DEFAULT_RESTART_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000];

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      resolve({ code: null, signal: null, error });
    };
    const cleanup = () => {
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function sleep(delayMs, { signal } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ type: "restart" }), delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve({ type: "cancelled" });
    }, { once: true });
  });
}

export async function terminateChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode != null || child.signalCode != null || child.pid == null) return;
  const exited = waitForExit(child);
  child.kill(signal);
  let timeout;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 2_000);
    }),
  ]);
  clearTimeout(timeout);
  if (!graceful && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

function tuiOutcome(tui) {
  return waitForExit(tui).then((result) => ({ type: "tui", ...result }));
}

export async function superviseStandardRuntime({
  initialAppServer,
  tui,
  signalPromise,
  startAppServer,
  waitForAppServerReady,
  restartDelaysMs = DEFAULT_RESTART_DELAYS_MS,
  delay = sleep,
  logger = console,
}) {
  if (!initialAppServer || !tui) throw new Error("app-server and TUI children are required");
  if (!Array.isArray(restartDelaysMs) || restartDelaysMs.length === 0) {
    throw new Error("restartDelaysMs must contain at least one delay");
  }

  let appServer = initialAppServer;
  let restartAttempt = 0;
  const waitForTui = tuiOutcome(tui);

  try {
    while (true) {
      const outcome = await Promise.race([
        waitForTui,
        waitForExit(appServer).then((result) => ({ type: "app-server", ...result })),
        signalPromise,
      ]);

      if (outcome.type === "tui") {
        logger.info(outcome.error
          ? `TUI failed: ${outcome.error.message}`
          : `TUI exited with code ${outcome.code ?? "null"} signal ${outcome.signal ?? "none"}`);
        return outcome;
      }
      if (outcome.type === "signal") {
        logger.info(`Received ${outcome.signal}; shutting down`);
        await terminateChild(tui, outcome.signal);
        return outcome;
      }

      logger.error(
        `App-server exited unexpectedly with code ${outcome.code ?? "null"} signal ${outcome.signal ?? "none"}`,
      );
      appServer = null;

      while (!appServer) {
        const delayIndex = Math.min(restartAttempt, restartDelaysMs.length - 1);
        const delayMs = restartDelaysMs[delayIndex];
        restartAttempt += 1;
        logger.warn(`App-server restart attempt ${restartAttempt} in ${delayMs}ms`);

        const delayController = new AbortController();
        const beforeStart = await Promise.race([
          waitForTui,
          signalPromise,
          Promise.resolve(delay(delayMs, { signal: delayController.signal }))
            .then((result) => result ?? { type: "restart" }),
        ]);
        delayController.abort();
        if (beforeStart.type === "tui") return beforeStart;
        if (beforeStart.type === "signal") {
          await terminateChild(tui, beforeStart.signal);
          return beforeStart;
        }

        let candidate;
        try {
          candidate = startAppServer();
        } catch (error) {
          logger.error(`App-server restart attempt ${restartAttempt} failed: ${error.message}`);
          continue;
        }
        const readinessController = new AbortController();
        const startup = await Promise.race([
          waitForTui,
          signalPromise,
          waitForExit(candidate).then((result) => ({ type: "candidate-exit", ...result })),
          Promise.resolve()
            .then(() => waitForAppServerReady(candidate, { signal: readinessController.signal }))
            .then(
              () => ({ type: "candidate-ready" }),
              (error) => ({ type: "candidate-failed", error }),
            ),
        ]);
        readinessController.abort();

        if (startup.type === "tui") {
          await terminateChild(candidate);
          return startup;
        }
        if (startup.type === "signal") {
          await terminateChild(candidate);
          await terminateChild(tui, startup.signal);
          return startup;
        }
        if (startup.type === "candidate-ready") {
          appServer = candidate;
          logger.info("App-server restarted and ready");
          break;
        }

        const reason = startup.type === "candidate-failed"
          ? startup.error.message
          : startup.error
            ? startup.error.message
          : `exited with code ${startup.code ?? "null"} signal ${startup.signal ?? "none"}`;
        logger.error(`App-server restart attempt ${restartAttempt} failed: ${reason}`);
        await terminateChild(candidate);
      }
    }
  } finally {
    await terminateChild(appServer);
  }
}
