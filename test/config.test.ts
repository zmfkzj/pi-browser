import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_CONFIG, isValidProfileName, loadBrowserConfig, validateBrowserConfig } from "../src/config.js";

let root: string;
let cwd: string;
let agentDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-browser-config-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const load = (projectTrusted = true) => loadBrowserConfig({ cwd, agentDir, projectTrusted });
const user = (value: unknown) => writeFile(join(agentDir, "browser.config.json"), JSON.stringify(value));
const project = (value: unknown) => writeFile(join(cwd, ".pi", "browser.config.json"), JSON.stringify(value));

describe("loadBrowserConfig", () => {
  it("uses fresh defaults when no files exist", async () => {
    const result = await load();
    expect(result).toEqual({ config: DEFAULT_BROWSER_CONFIG, sources: [], errors: [] });
    expect(result.config).toMatchObject({ engine: "auto", exposure: "hybrid", chrome: {
      enabled: true, headless: "auto", isolated: false, channel: "stable",
      executablePath: null, browserUrl: null, viewport: null, args: [],
    } });
    result.config.timeoutMs = 10;
    expect((await load()).config.timeoutMs).toBe(45_000);
    result.config.chrome.enabled = false;
    result.config.chrome.args.push("--test");
    expect((await load()).config.chrome).toEqual(DEFAULT_BROWSER_CONFIG.chrome);
  });

  it("overrides user settings key by key from a trusted project", async () => {
    await user({ timeoutMs: 1000, stealth: true, proxy: "http://proxy.example:3128" });
    await project({ timeoutMs: 2000, allowPrivateNetwork: true, exposure: "deferred" });
    const result = await load();
    expect(result.config).toEqual({
      ...DEFAULT_BROWSER_CONFIG,
      timeoutMs: 2000,
      stealth: true,
      proxy: "http://proxy.example:3128",
      allowPrivateNetwork: true,
      exposure: "deferred",
    });
    expect(result.sources).toEqual([join(agentDir, "browser.config.json"), join(cwd, ".pi", "browser.config.json")]);
    expect(result.errors).toEqual([]);
  });

  it("never reads an untrusted project file (even if invalid)", async () => {
    await user({ timeoutMs: 1000 });
    await writeFile(join(cwd, ".pi", "browser.config.json"), "not JSON");
    expect(await load(false)).toEqual({
      config: { ...DEFAULT_BROWSER_CONFIG, timeoutMs: 1000 },
      sources: [join(agentDir, "browser.config.json")],
      errors: [],
    });
    expect((await load(true)).errors[0]).toContain(join(cwd, ".pi", "browser.config.json"));
  });

  it("ignores the entire invalid user file while applying valid project settings", async () => {
    await user({ timeoutMs: -1, stealth: true });
    await project({ idleMs: 100 });
    const result = await load();
    expect(result.config).toEqual({ ...DEFAULT_BROWSER_CONFIG, idleMs: 100 });
    expect(result.sources).toEqual([join(cwd, ".pi", "browser.config.json")]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("timeoutMs");
  });

  it("retains user settings when a project file has an unknown key", async () => {
    await user({ timeoutMs: 1000 });
    await project({ timeoutMs: 2000, unknownSetting: true });
    const result = await load();
    expect(result.config.timeoutMs).toBe(1000);
    expect(result.errors[0]).toContain('unknown key "unknownSetting"');
  });

  it("accepts every configuration key and explicit null overrides", async () => {
    await user({ binaryPath: "/tmp/obscura", proxy: "http://proxy", userAgent: "test" });
    await project({
      binaryPath: null, version: "0.2.4", variant: "stealth", allowPrivateNetwork: true,
      stealth: true, proxy: null, userAgent: null, timeoutMs: 1,
      evaluateTimeoutMs: 2, idleMs: 3, maxOutputChars: 4, exposure: "deferred",
      autoInstall: "never", profile: "work.profile-1", rawMcp: true,
    });
    const result = await load();
    expect(result.errors).toEqual([]);
    expect(result.config.binaryPath).toBeNull();
    expect(result.config.proxy).toBeNull();
    expect(result.config.variant).toBe("stealth");
    expect(result.config.maxOutputChars).toBe(4);
    expect(result.config).toMatchObject({ autoInstall: "never", profile: "work.profile-1", rawMcp: true });
  });

  it.each(["auto", "obscura", "chrome"])("accepts engine %s", async (engine) => {
    await user({ engine });
    expect((await load()).config.engine).toBe(engine);
  });

  it.each(["hybrid", "direct", "deferred"])("accepts exposure %s", async (exposure) => {
    await user({ exposure });
    expect((await load()).config.exposure).toBe(exposure);
  });

  it("merges nested Chrome defaults, user and trusted project settings key by key", async () => {
    await user({ engine: "chrome", chrome: {
      enabled: false, headless: false, isolated: true, channel: "beta",
      executablePath: "/usr/bin/google-chrome", browserUrl: "http://localhost:9222",
      viewport: "1280x800", args: ["--disable-gpu"],
    } });
    await project({ engine: "obscura", chrome: { headless: true, executablePath: null, args: ["--no-sandbox"] } });
    const result = await load();
    expect(result.errors).toEqual([]);
    expect(result.config.engine).toBe("obscura");
    expect(result.config.chrome).toEqual({
      enabled: false, headless: true, isolated: true, channel: "beta",
      executablePath: null, browserUrl: "http://localhost:9222", viewport: "1280x800", args: ["--no-sandbox"],
    });
  });

  it("preserves Chrome defaults and user settings when the project sets an empty object", async () => {
    await user({ chrome: { channel: "dev" } });
    await project({ chrome: {} });
    expect((await load()).config.chrome).toEqual({ ...DEFAULT_BROWSER_CONFIG.chrome, channel: "dev" });
  });

  it("does not apply nested settings from untrusted projects", async () => {
    await user({ chrome: { channel: "beta" } });
    await project({ engine: "chrome", chrome: { channel: "canary", args: ["--test"] } });
    expect((await load(false)).config).toMatchObject({
      engine: "auto", chrome: { ...DEFAULT_BROWSER_CONFIG.chrome, channel: "beta" },
    });
  });

  it("ignores an entire layer if a nested Chrome key is unknown", async () => {
    await user({ chrome: { channel: "beta" } });
    await project({ engine: "chrome", chrome: { channel: "dev", unknownSetting: true } });
    const result = await load();
    expect(result.config.engine).toBe("auto");
    expect(result.config.chrome.channel).toBe("beta");
    expect(result.errors[0]).toContain('unknown key "chrome.unknownSetting"');
    expect(result.sources).toEqual([join(agentDir, "browser.config.json")]);
  });

  it("ignores the entire user file on nested validation errors while applying the project", async () => {
    await user({ engine: "chrome", chrome: { headless: "yes", channel: "beta" } });
    await project({ chrome: { enabled: false } });
    const result = await load();
    expect(result.config).toMatchObject({ engine: "auto", chrome: { ...DEFAULT_BROWSER_CONFIG.chrome, enabled: false } });
    expect(result.errors[0]).toContain('chrome.headless must be "auto" or a boolean');
  });

  it.each(["stable", "beta", "dev", "canary"])("accepts Chrome channel %s", async (channel) => {
    await user({ chrome: { channel } });
    expect((await load()).config.chrome.channel).toBe(channel);
  });

  it.each(["auto", true, false])("accepts Chrome headless %j", async (headless) => {
    await user({ chrome: { headless } });
    expect((await load()).config.chrome.headless).toBe(headless);
  });

  it("accepts explicit null overrides for nullable Chrome keys", async () => {
    await user({ chrome: { executablePath: "/usr/bin/chrome", browserUrl: "http://localhost:9222", viewport: "800x600" } });
    await project({ chrome: { executablePath: null, browserUrl: null, viewport: null, args: [] } });
    expect((await load()).config.chrome).toEqual(DEFAULT_BROWSER_CONFIG.chrome);
  });

  it.each([
    ["enabled", "true"], ["enabled", null], ["isolated", 1],
    ["headless", "true"], ["headless", null], ["headless", 1],
    ["channel", "nightly"], ["channel", true],
    ["executablePath", ""], ["executablePath", "   "], ["executablePath", 123],
    ["browserUrl", false], ["browserUrl", ""], ["viewport", []], ["viewport", ""],
    ["args", "--headless"], ["args", [1]], ["args", ["--test", null]], ["args", null],
  ])("rejects invalid chrome.%s = %j", async (key, value) => {
    await user({ chrome: { [key as string]: value }, engine: "chrome" });
    const result = await load();
    expect(result.config).toEqual(DEFAULT_BROWSER_CONFIG);
    expect(result.sources).toEqual([]);
    expect(result.errors[0]).toContain(`chrome.${key} must be`);
  });

  it.each([null, [], "string", 123])("rejects a non-object chrome %j", async (chrome) => {
    await user({ chrome });
    const result = await load();
    expect(result.config).toEqual(DEFAULT_BROWSER_CONFIG);
    expect(result.errors[0]).toContain("chrome must be a JSON object");
  });

  it("exports validation for partial nested patches and reports multiple problems", () => {
    const patch = { engine: "chrome", chrome: { headless: false } };
    expect(validateBrowserConfig(patch)).toEqual(patch);
    expect(() => validateBrowserConfig({ chrome: { enabled: 1, channel: "nightly", unknown: true }, engine: "bad" }))
      .toThrow('chrome.enabled must be a boolean; chrome.channel must be "stable", "beta", "dev" or "canary"; unknown key "chrome.unknown"; engine must be "auto", "obscura" or "chrome"');
  });

  it.each([
    ["binaryPath", 123], ["binaryPath", ""], ["proxy", false], ["userAgent", []],
    ["version", "../elsewhere"], ["version", ""], ["variant", "no-render"],
    ["allowPrivateNetwork", "true"], ["stealth", 1], ["exposure", "hidden"],
    ["engine", "firefox"], ["engine", false], ["engine", null],
    ["timeoutMs", 0], ["timeoutMs", -1], ["evaluateTimeoutMs", 0.5],
    ["idleMs", 2_147_483_648], ["maxOutputChars", "100"],
    ["autoInstall", true], ["autoInstall", "always"], ["rawMcp", "true"],
    ["profile", ""], ["profile", "../escape"], ["profile", "a/b"], ["profile", "a".repeat(65)], ["profile", 1],
  ])("rejects invalid %s = %j", async (key, value) => {
    await user({ [key as string]: value });
    const result = await load();
    expect(result.config).toEqual(DEFAULT_BROWSER_CONFIG);
    expect(result.sources).toEqual([]);
    expect(result.errors[0]).toContain(`${key} must be`);
  });

  it.each([null, [], "string", 123])("rejects a non-object root %j", async (value) => {
    await user(value);
    expect((await load()).errors[0]).toContain("expected a JSON object");
  });

  it("accepts null profile overrides and validates names without coercion", async () => {
    await user({ profile: "test", autoInstall: "never", rawMcp: true });
    await project({ profile: null, autoInstall: "ask", rawMcp: false });
    expect((await load()).config).toMatchObject({ profile: null, autoInstall: "ask", rawMcp: false });
    for (const value of ["default", "a_1.-", "a".repeat(64)]) expect(isValidProfileName(value)).toBe(true);
    for (const value of [null, {}, "", "a b", "../x", "a".repeat(65)]) expect(isValidProfileName(value)).toBe(false);
  });

  it("collects read errors as well as malformed JSON errors", async () => {
    await mkdir(join(agentDir, "browser.config.json"));
    await writeFile(join(cwd, ".pi", "browser.config.json"), "{");
    const result = await load();
    expect(result.config).toEqual(DEFAULT_BROWSER_CONFIG);
    expect(result.errors).toHaveLength(2);
  });
});
