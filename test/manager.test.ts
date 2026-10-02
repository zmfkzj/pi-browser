import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BROWSER_CONFIG, type EngineSetting } from "../src/config.js";
import type { BrowserEngine, EngineName } from "../src/engine.js";
import { ObscuraEngine } from "../src/engines/obscura.js";
import { ChromeEngine } from "../src/engines/chrome.js";
import { chromeUnavailable, EngineManager, isDevelopmentUrl } from "../src/manager.js";

const fakeServer = fileURLToPath(new URL("./helpers/fake-mcp-server.mjs", import.meta.url));
const engines: BrowserEngine[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.stop())); });

/** A second engine identity backed by the existing fake obscura protocol, not Chrome. */
class FakeChromeEngine extends ObscuraEngine {
  override readonly name: EngineName = "chrome";
}

function setup(options: { engine?: EngineSetting; obscura?: boolean; chrome?: boolean } = {}) {
  const create = (name: EngineName) => {
    const Constructor = name === "chrome" ? FakeChromeEngine : ObscuraEngine;
    const engine = new Constructor({
      config: { ...DEFAULT_BROWSER_CONFIG }, command: process.execPath,
      launch: () => spawn(process.execPath, [fakeServer], { stdio: "pipe" }),
    });
    engines.push(engine);
    return engine;
  };
  const factories = { obscura: vi.fn(() => create("obscura")), chrome: vi.fn(() => create("chrome")) };
  const onStateChange = vi.fn();
  const manager = new EngineManager({
    config: { engine: options.engine ?? "auto" }, factories,
    availability: {
      obscura: () => options.obscura === false ? { ok: false, reason: "Obscura binary missing." } : { ok: true },
      chrome: () => options.chrome === false ? chromeUnavailable() : { ok: true },
    },
    onStateChange,
  });
  return { manager, factories, onStateChange };
}

async function openBoth(manager: EngineManager) {
  const obscura = await manager.select({ engine: "obscura" });
  await obscura.navigate("https://public.example/page", {});
  const chrome = await manager.select({ engine: "chrome" });
  await chrome.navigate("http://localhost:3000/app", {});
  return { obscura, chrome };
}

const pendingEntries = () => ({ localStorage: [["k", "v"]] as [string, string][], sessionStorage: [] });

describe("EngineManager selection", () => {
  it("requires navigation before accessing an active engine", () => {
    const { manager, factories } = setup();
    expect(manager.active()).toBeUndefined();
    expect(() => manager.require()).toThrow("No page is open yet; call browser_navigate first.");
    expect(factories.obscura).not.toHaveBeenCalled();
    expect(factories.chrome).not.toHaveBeenCalled();
  });

  it("lets an explicit engine override config, URL routing and the sticky engine", async () => {
    const { manager } = setup({ engine: "obscura" });
    const obscura = await manager.select({ url: "https://public.example" });
    const chrome = await manager.select({ engine: "chrome", url: "https://public.example" });
    expect(chrome.name).toBe("chrome");
    expect(manager.require()).toBe(chrome);
    expect(await manager.select({ engine: "obscura", url: "http://localhost" })).toBe(obscura);
  });

  it.each(["obscura", "chrome"] as const)("keeps %s sticky across URLs", async (engine) => {
    const { manager, factories } = setup();
    const selected = await manager.select({ engine });
    expect(await manager.select({ url: "http://localhost:3000" })).toBe(selected);
    expect(await manager.select({ url: "https://example.com" })).toBe(selected);
    expect(factories[engine]).toHaveBeenCalledTimes(1);
    expect(factories[engine === "chrome" ? "obscura" : "chrome"]).not.toHaveBeenCalled();
  });

  it.each(["obscura", "chrome"] as const)("uses configured %s before auto routing", async (engine) => {
    const { manager } = setup({ engine });
    expect((await manager.select({ url: engine === "obscura" ? "http://localhost" : "https://example.com" })).name).toBe(engine);
  });

  it.each([
    "http://localhost:3000", "http://127.0.0.1", "http://127.12.34.56", "http://0.0.0.0",
    "http://10.1.2.3", "http://172.16.0.1", "http://172.31.255.254", "http://192.168.1.3",
    "http://169.254.1.2", "http://[::1]", "http://[fd12::1]", "http://[fc00::1]", "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]", "http://app.localhost", "http://service.local", "https://app.test",
    "http://APP.LOCALHOST.",
  ])("auto selects the fake-backed chrome engine for %s", async (url) => {
    const { manager } = setup();
    expect((await manager.select({ url })).name).toBe("chrome");
  });

  it.each([
    "https://example.com", "https://localhost.example.com", "https://notlocal", "http://172.15.0.1",
    "http://172.32.0.1", "http://192.169.1.3", "http://[2001:4860:4860::8888]", "http://[::ffff:8.8.8.8]",
    undefined,
  ])("auto selects obscura for public/non-dev URL %s", async (url) => {
    const { manager } = setup();
    expect((await manager.select({ url })).name).toBe("obscura");
  });

  it("routes without DNS resolution and tolerates malformed/missing URLs", () => {
    expect(isDevelopmentUrl("not a URL")).toBe(false);
    expect(isDevelopmentUrl()).toBe(false);
    expect(isDevelopmentUrl("https://example.com")).toBe(false);
  });

  it("uses obscura for dev work while the chrome implementation is unavailable", async () => {
    const { manager } = setup({ chrome: false });
    expect((await manager.select({ url: "http://localhost:3000" })).name).toBe("obscura");
  });

  it("falls back to chrome for public pages when obscura is unavailable", async () => {
    const { manager } = setup({ obscura: false });
    expect((await manager.select({ url: "https://example.com" })).name).toBe("chrome");
  });

  it("reports the exact unavailable-chrome reason and remediation", async () => {
    const { manager } = setup({ chrome: false });
    expect(chromeUnavailable()).toEqual({ ok: false, reason: "chrome engine disabled in config" });
    await expect(manager.select({ engine: "chrome" })).rejects.toThrow(
      'Cannot use engine "chrome": chrome engine disabled in config Install/enable the chrome engine or use engine "obscura".',
    );
    expect(manager.active()).toBeUndefined();
  });

  it("does not silently fall back from an unavailable configured engine", async () => {
    const { manager } = setup({ engine: "chrome", chrome: false });
    await expect(manager.select({ url: "https://example.com" })).rejects.toThrow("chrome engine disabled in config");
  });

  it("combines both availability errors when no engine can run", async () => {
    const { manager } = setup({ obscura: false, chrome: false });
    await expect(manager.select()).rejects.toThrow(
      "No browser engine is available. obscura: Obscura binary missing.; chrome: chrome engine disabled in config. Configure binaryPath or run /browser install.",
    );
  });

  it("treats availability without a registered factory as unavailable", async () => {
    const manager = new EngineManager({ config: { engine: "auto" }, factories: {}, availability: {
      obscura: () => ({ ok: true }), chrome: () => ({ ok: true }),
    } });
    await expect(manager.select({ engine: "chrome" })).rejects.toThrow("No factory registered for the chrome engine.");
  });
});

describe("EngineManager session default and lifecycle", () => {
  it("switchTo sets the next-navigation default without starting a new engine", async () => {
    const { manager, factories, onStateChange } = setup();
    const obscura = await manager.select({ engine: "obscura" });
    await manager.switchTo("chrome");
    expect(manager.active()).toBe(obscura);
    expect(factories.chrome).not.toHaveBeenCalled();
    expect(manager.status()).toMatchObject({ active: "obscura", default: "chrome", configDefault: "auto" });
    expect((await manager.select({ url: "https://example.com" })).name).toBe("chrome");
    expect(onStateChange).toHaveBeenCalled();
  });

  it("explicit selection wins over a pending session default", async () => {
    const { manager } = setup();
    await manager.switchTo("chrome");
    expect((await manager.select({ engine: "obscura" })).name).toBe("obscura");
    expect(manager.status().default).toBe("chrome");
  });

  it("switchTo activates an already-started engine with pages immediately", async () => {
    const { manager } = setup();
    const { obscura } = await openBoth(manager);
    await manager.switchTo("obscura");
    expect(manager.active()).toBe(obscura);
    expect(manager.status().default).toBe("obscura");
    expect((await manager.select({ url: "http://localhost" })).name).toBe("obscura");
  });

  it("switchTo defers activation of a running engine with no open pages", async () => {
    const { manager } = setup();
    const { obscura, chrome } = await openBoth(manager);
    await chrome.closeAll();
    await manager.select({ engine: "obscura" });
    await manager.switchTo("chrome");
    expect(manager.active()).toBe(obscura);
    expect(await manager.select()).toBe(chrome);
  });

  it("tab activation does not consume a pending next-navigation default", async () => {
    const { manager } = setup();
    await manager.select({ engine: "obscura" });
    await manager.switchTo("chrome");
    expect(manager.activate("obscura").name).toBe("obscura");
    expect((await manager.select()).name).toBe("chrome");
  });

  it("switchTo rejects unavailable engines without changing the active/default engine", async () => {
    const { manager } = setup({ chrome: false });
    const obscura = await manager.select();
    await expect(manager.switchTo("chrome")).rejects.toThrow("chrome engine disabled in config");
    expect(manager.active()).toBe(obscura);
    expect(manager.status().default).toBe("auto");
  });

  it("isolates pending storage by engine and origin", () => {
    const { manager } = setup();
    const obscura = manager.pendingFor("obscura"), chrome = manager.pendingFor("chrome");
    obscura.set("https://same.example", pendingEntries());
    chrome.set("https://same.example", { localStorage: [], sessionStorage: [["different", "1"]] });
    expect(obscura).not.toBe(chrome);
    expect(manager.pendingFor("obscura")).toBe(obscura);
    expect(chrome.get("https://same.example")?.sessionStorage).toEqual([["different", "1"]]);
    manager.clearPending("obscura");
    expect(obscura.size).toBe(0);
    expect(chrome.size).toBe(1);
    manager.engineStopped("chrome");
    expect(chrome.size).toBe(0);
  });

  it("restartActive restarts only the active engine and clears only its old queue", async () => {
    const { manager } = setup();
    const { obscura, chrome } = await openBoth(manager);
    const obscuraPid = obscura.status().pid, chromePid = chrome.status().pid;
    manager.pendingFor("obscura").set("https://saved.example", pendingEntries());
    manager.pendingFor("chrome").set("https://saved.example", pendingEntries());
    await manager.restartActive();
    expect(manager.active()).toBe(chrome);
    expect(chrome.status()).toMatchObject({ running: true, pid: expect.any(Number) });
    expect(chrome.status().pid).not.toBe(chromePid);
    expect(obscura.status()).toMatchObject({ running: true, pid: obscuraPid });
    expect(manager.pendingFor("chrome").size).toBe(0);
    expect(manager.pendingFor("obscura").size).toBe(1);
  });

  it("restartActive requires an active engine", async () => {
    const { manager } = setup();
    await expect(manager.restartActive()).rejects.toThrow("No page is open yet; call browser_navigate first.");
  });

  it("stopAll stops both processes, clears all queues and retains the session default", async () => {
    const { manager } = setup();
    const { obscura, chrome } = await openBoth(manager);
    await manager.switchTo("chrome");
    manager.pendingFor("obscura").set("https://saved.example", pendingEntries());
    manager.pendingFor("chrome").set("https://saved.example", pendingEntries());
    await manager.stopAll();
    expect(obscura.status().running).toBe(false);
    expect(chrome.status().running).toBe(false);
    expect(manager.active()).toBeUndefined();
    expect(manager.pendingFor("obscura").size).toBe(0);
    expect(manager.pendingFor("chrome").size).toBe(0);
    expect(manager.status()).toMatchObject({ default: "chrome", configDefault: "auto" });
    expect((await manager.select()).name).toBe("chrome");
    await manager.stopAll();
  });

  it("reports each engine's process, binary, availability, active name and defaults", async () => {
    const { manager } = setup({ engine: "obscura" });
    expect(manager.status()).toMatchObject({ active: undefined, default: "obscura", configDefault: "obscura", engines: {
      obscura: { running: false, available: true }, chrome: { running: false, available: true },
    } });
    const { obscura, chrome } = await openBoth(manager);
    expect(manager.status()).toMatchObject({ active: "chrome", engines: {
      obscura: { running: true, pid: obscura.status().pid, binary: process.execPath, available: true },
      chrome: { running: true, pid: chrome.status().pid, binary: process.execPath, available: true },
    } });
  });
});

describe("EngineManager cross-engine tabs", () => {
  it("lists one named block per started engine and marks the active engine", async () => {
    const { manager } = setup();
    await openBoth(manager);
    const listing = await manager.listTabs();
    expect(listing).toMatch(/^\[obscura\]\n/);
    expect(listing).toContain("https://public.example/page");
    expect(listing).toContain("\n\n[chrome] (active)\n");
    expect(listing).toContain("http://localhost:3000/app");
    expect(listing).not.toContain("[obscura] (active)");
    await manager.switchTo("obscura");
    expect(await manager.listTabs()).toContain("[obscura] (active)");
  });

  it("filters by engine without changing the active engine", async () => {
    const { manager } = setup();
    await openBoth(manager);
    const listing = await manager.listTabs("obscura");
    expect(listing).toMatch(/^\[obscura\]\n/);
    expect(listing).not.toContain("[chrome]");
    expect(manager.active()?.name).toBe("chrome");
  });

  it("does not start engines just to list tabs", async () => {
    const { manager, factories } = setup();
    await manager.select({ engine: "obscura" });
    expect(await manager.listTabs()).toBe("No open tabs.");
    expect(factories.chrome).not.toHaveBeenCalled();
    expect(manager.require().status().running).toBe(false);
  });
});

describe("EngineManager with the actual Chrome adapter and fake Chrome protocol", () => {
  function chromeManager() {
    const chrome = new ChromeEngine({ config: { ...DEFAULT_BROWSER_CONFIG }, launch: () => spawn(process.execPath, [fileURLToPath(new URL('./helpers/fake-chrome-mcp.mjs', import.meta.url))], { stdio: 'pipe', detached: true }) });
    const obscura = new ObscuraEngine({ config: { ...DEFAULT_BROWSER_CONFIG }, command: process.execPath, launch: () => spawn(process.execPath, [fakeServer], { stdio: 'pipe' }) });
    engines.push(chrome, obscura);
    return new EngineManager({config:{engine:'auto'},factories:{chrome:()=>chrome,obscura:()=>obscura},availability:{chrome:()=>({ok:true}),obscura:()=>({ok:true})}});
  }
  it('routes local URLs to Chrome, stays sticky, honors explicit engine and session command selection', async () => {
    const manager=chromeManager();
    const chrome=await manager.select({url:'http://127.0.0.1:3000/'});
    expect(chrome).toBeInstanceOf(ChromeEngine);
    await chrome.navigate('http://127.0.0.1:3000/',{});
    expect((await chrome.summarize({maxChars:100})).elements![0]?.ref).toMatch(/^\d+_\d+$/);
    expect(await manager.select({url:'https://example.com'})).toBe(chrome);
    expect((await manager.select({engine:'obscura',url:'http://127.0.0.1'})).name).toBe('obscura');
    await manager.switchTo('chrome');
    expect(manager.active()).toBe(chrome);
    expect((await manager.listTabs()).includes('[chrome] (active)')).toBe(true);
  });
  it('routes a fresh public URL to obscura even when Chrome is truly available',async () => {
    expect((await chromeManager().select({url:'https://example.com'})).name).toBe('obscura');
  });
});
