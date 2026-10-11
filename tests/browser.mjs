import { chromium as playwrightChromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const artifactRoot = fileURLToPath(
  new URL("../test-artifacts/", import.meta.url),
);
await mkdir(artifactRoot, { recursive: true });
// Chromium subprocesses can write debug.log despite --log-file. Keep their cwd here too.
const launchDirectory = process.cwd();
process.chdir(artifactRoot);
export const artifact = (name) => path.join(artifactRoot, name);
const uiRoot = fileURLToPath(new URL("../ui/", import.meta.url));
const cargo = await readFile(
  new URL("../src-tauri/Cargo.toml", import.meta.url),
  "utf8",
);
const metadata = {
  version: cargo.match(/^version\s*=\s*"([^"]+)"/m)[1],
  config: JSON.parse(
    await readFile(
      new URL("../src-tauri/src/default-config.json", import.meta.url),
      "utf8",
    ),
  ),
};
const types = {
  ".js": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".md": "text/plain",
  ".woff2": "font/woff2",
};

/** Resolves once the board has booted and run its first reflow (app.js boot). */
export async function ready(p) {
  await p.waitForSelector("html[data-ready]", { state: "attached" });
  // ponytail: a paused fake clock (clock.pauseAt) never fires the reflow timer; cap at 1 s real time
  await p
    .waitForSelector("html[data-reflowed]", { state: "attached", timeout: 1000 })
    .catch(() => {});
}

/**
 * Resolves once no widget save is queued or in flight and no finite animation (widgets sliding into place) runs.
 * Editors with their own buffers (memo text) need their own wait.
 */
export const settled = (p) =>
  p.waitForFunction(
    () =>
      window.__wbIdle?.() &&
      document
        .getAnimations()
        .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
  );

/** Run `fn` (layout apply, preset, undo) and wait for the board it reloads to boot again. */
export async function reloadsAfter(p, fn) {
  const nav = p.waitForEvent("framenavigated", (f) => f === p.mainFrame());
  await fn();
  await nav;
  await ready(p);
}

// Serve the actual UI files through Playwright. Tests need no background HTTP server.
export const chromium = {
  async launch(options) {
    const browser = await playwrightChromium.launch({
      ...options,
      ...(options?.executablePath
        ? {
            executablePath: path.resolve(
              launchDirectory,
              options.executablePath,
            ),
          }
        : {}),
    });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      await context.addInitScript((metadata) => {
        window.__mockMetadata = metadata;
      }, metadata);
      await context.route("http://localhost:8765/**", async (route) => {
        const url = new URL(route.request().url());
        const file = path.resolve(
          uiRoot,
          "." +
            (url.pathname === "/"
              ? "/index.html"
              : decodeURIComponent(url.pathname)),
        );
        if (!file.startsWith(uiRoot)) return route.abort();
        try {
          await route.fulfill({
            body: await readFile(file),
            contentType:
              types[path.extname(file)] || "application/octet-stream",
          });
        } catch {
          await route.fulfill({ status: 404, body: "" });
        }
      });
      return context;
    };
    browser.newPage = async (options) => {
      const context = await browser.newContext(options);
      const page = await context.newPage();
      const close = page.close.bind(page);
      page.close = async (options) => {
        await close(options);
        await context.close();
      };
      return page;
    };
    return browser;
  },
};
