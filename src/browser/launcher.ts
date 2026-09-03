import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface BrowserProfile {
  readonly profileDir: string;
  readonly downloadDir: string;
  /** True only for a temporary profile that BrowserManager may delete. */
  readonly owned: boolean;
}

export interface BrowserLaunchOptions {
  readonly executablePath: string;
  readonly cdpPort: number;
  readonly profile: BrowserProfile;
  readonly headless?: boolean;
  readonly extraArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface LaunchedBrowser {
  readonly process: ChildProcess;
  readonly cdpEndpoint: string;
  readonly args: readonly string[];
}

/**
 * Creates a dedicated profile by default. Supplying a profile path is an
 * explicit advanced opt-in and is never created as a user's normal profile.
 */
export async function createBrowserProfile(profileDir?: string, downloadDir?: string, owned = profileDir === undefined): Promise<BrowserProfile> {
  const resolvedProfileDir = profileDir ?? (await mkdtemp(join(tmpdir(), "browser-mcp-")));
  await mkdir(resolvedProfileDir, { recursive: true });
  const resolvedDownloadDir = downloadDir ?? join(resolvedProfileDir, "downloads");
  await mkdir(resolvedDownloadDir, { recursive: true });

  return {
    profileDir: resolvedProfileDir,
    downloadDir: resolvedDownloadDir,
    owned,
  };
}

/** Launch a locally installed browser with a localhost-only CDP listener. */
export function launchBrowser(options: BrowserLaunchOptions): LaunchedBrowser {
  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${options.cdpPort}`,
    `--user-data-dir=${options.profile.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Recent Chromium releases reject DevTools websocket clients without this
    // flag. The CDP listener itself remains bound to loopback.
    "--remote-allow-origins=*",
    ...(options.headless ? ["--headless=new"] : []),
    ...(options.extraArgs ?? []),
  ];

  const child = spawn(options.executablePath, args, {
    detached: false,
    env: options.env ?? process.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false,
  });

  // A spawn failure otherwise emits an unhandled `error` event. BrowserManager
  // observes exit state while it waits for CDP and converts it to a clear error.
  child.on("error", () => undefined);
  child.stderr?.resume();

  return {
    process: child,
    cdpEndpoint: `http://127.0.0.1:${options.cdpPort}`,
    args,
  };
}

/** Best-effort termination used only for browser processes owned by this server. */
export async function terminateBrowserProcess(process: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  const exited = waitForExit(process, timeoutMs);
  try {
    process.kill("SIGTERM");
  } catch {
    return;
  }

  if (await exited) {
    return;
  }

  try {
    process.kill("SIGKILL");
  } catch {
    // The process may have exited between the two calls.
  }
  await waitForExit(process, 1_000);
}

function waitForExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    const onExit = () => finish(true);
    process.once("exit", onExit);

    function finish(exited: boolean): void {
      clearTimeout(timer);
      process.removeListener("exit", onExit);
      resolve(exited);
    }
  });
}
