import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, ready } from "./browser.mjs";
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
try {
  const ctx = await browser.newContext();
  const board = await ctx.newPage();
  await board.goto("http://localhost:8765/index.html?lang=en");
  await ready(board);
  const settings = await ctx.newPage();
  await settings.goto("http://localhost:8765/settings.html?lang=en");
  await settings.waitForTimeout(300);
  const state = await board.evaluate(() => __mock.invoke("load_state"));
  const config = await settings.evaluate(() => __mock.invoke("get_settings"));
  const status = await board.evaluate(() => __mock.invoke("update_status"));
  const cargo = await readFile(
    new URL("../src-tauri/Cargo.toml", import.meta.url),
    "utf8",
  );
  const nativeVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)[1];
  assert.equal(state.version, nativeVersion);
  assert.equal(config.version, nativeVersion);
  assert.equal(status.current, nativeVersion);
  assert.deepEqual(config.config, state.config);
  const rust = await readFile(
    new URL("../src-tauri/src/main.rs", import.meta.url),
    "utf8",
  );
  const typeList = rust.match(/const WIDGETS:[^=]+=\s*&\s*\[([\s\S]*?)\];/);
  assert.ok(typeList, "native widget list must be readable");
  const nativeTypes = [...typeList[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(config.widgetTypes, nativeTypes);
  console.log(
    "PASS shared version, config and widget types match native sources",
  );
  await board.evaluate(() =>
    __mock.invoke("save_config", {
      patch: { holidays: { add: { "2030-01-01": "custom" } } },
    }),
  );
  await settings.evaluate(() =>
    __mock.invoke("save_config", {
      patch: { holidays: { add: { "2030-01-01": null } } },
    }),
  );
  assert.equal(
    await board.evaluate(async () =>
      Object.hasOwn(
        (await __mock.invoke("get_settings")).config.holidays.add,
        "2030-01-01",
      ),
    ),
    false,
  );
  console.log("PASS config null deletion matches across pages");
  await settings.evaluate(() =>
    __mock.invoke("emit_primary", { event: "add-widget", payload: "memo" }),
  );
  await board.waitForSelector(".memo textarea");
  await board.locator(".memo textarea").fill("saved across pages");
  await settings.evaluate(() => __mock.invoke("flush_boards"));
  assert.equal(
    await settings.evaluate(
      async () => (await __mock.invoke("content_list"))[0].data.text,
    ),
    "saved across pages",
  );
  console.log("PASS settings command reaches board and shared persisted state");
  await settings.evaluate(() =>
    __mock.invoke("store_set", {
      key: "checklist",
      src: "settings",
      value: [{ id: "i", title: "shared", date: "2020-01-01", done: false }],
    }),
  );
  await settings.evaluate(() =>
    __mock.invoke("emit_primary", {
      event: "add-widget",
      payload: "checklist",
    }),
  );
  await board.waitForSelector(".ck-title");
  assert.equal(await board.locator(".ck-title").textContent(), "shared");
  await settings.evaluate(() =>
    __mock.invoke("store_set", {
      key: "checklist",
      src: "settings",
      value: [{ id: "i", title: "changed", date: "2020-01-01", done: false }],
    }),
  );
  await board.waitForFunction(
    () => document.querySelector(".ck-title").textContent === "changed",
  );
  console.log("PASS cross-window shared store emits change notifications");
  assert.match(
    await board.evaluate(async () => {
      try {
        await __mock.invoke("typo_command");
      } catch (e) {
        return e.message;
      }
    }),
    /Unimplemented mock command/,
  );
  console.log("PASS unknown native commands fail instead of hiding mock drift");
} finally {
  await browser.close();
}
