import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../src/browser/browser-manager.js";
import { discoverBrowser } from "../src/platform/browser-discovery.js";
import { ElementRegistry, StaleElementReferenceError } from "../src/exploration/ElementRegistry.js";
import { Observer } from "../src/exploration/Observer.js";

let server: Server | undefined;
let fixtureUrl: string | undefined;
let browser: BrowserManager | undefined;
let browserExecutable: string | undefined;

beforeAll(async () => {
  try {
    browserExecutable = (await discoverBrowser()).executablePath;
  } catch {
    return;
  }

  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/frame.html") {
      response.end(`<!doctype html><button id="frame-button">Frame button</button>`);
      return;
    }
    response.end(`<!doctype html>
      <button id="main-button">Main button</button>
      <iframe id="child-frame" name="child-frame" src="/frame.html"></iframe>
      <script>
        window.removeChildFrame = () => document.querySelector("#child-frame").remove();
      </script>`);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address && typeof address !== "string") {
    fixtureUrl = `http://127.0.0.1:${address.port}/`;
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
});

describe("browser iframe integration", () => {
  it("uses the selected frame and invalidates refs after detach", async (context) => {
    if (!browserExecutable || !fixtureUrl) {
      context.skip();
      return;
    }

    const invalidationReasons: string[] = [];
    const registry = new ElementRegistry();
    browser = new BrowserManager({
      executablePath: browserExecutable,
      headless: true,
      useUserProfile: false,
      startupTimeoutMs: 15_000,
      defaultTimeoutMs: 10_000,
      onFrameContextChanged: (reason) => {
        invalidationReasons.push(reason);
        registry.invalidate(reason);
      },
    });
    await browser.start();
    await browser.navigate(fixtureUrl);

    const frames = await browser.listFrames();
    const child = frames.find((frame) => !frame.main);
    expect(child).toBeDefined();
    await browser.switchFrame(child!.id);

    const frame = await browser.requireActiveFrame();
    expect(await frame.evaluate(() => document.body.textContent?.trim())).toContain("Frame button");

    const observer = new Observer({ registry });
    const observation = await observer.observe(frame);
    const button = observation.interactables.find((element) => element.name === "Frame button");
    expect(button).toBeDefined();
    const entry = registry.resolve(button!.ref);

    const mainPage = await browser.requireActivePage();
    await mainPage.evaluate(() => (window as Window & { removeChildFrame?: () => void }).removeChildFrame?.());

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(invalidationReasons).toContain("The selected or observed child frame detached.");
    expect(() => registry.resolve(entry.ref)).toThrow(StaleElementReferenceError);
    await expect(browser.switchFrame(child!.id)).rejects.toThrow("Unknown or detached frame");
  }, 30_000);
});
