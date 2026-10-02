import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_CONFIG, isValidProfileName, loadBrowserConfig } from "../src/config.js";

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
    result.config.timeoutMs = 10;
    expect((await load()).config.timeoutMs).toBe(45_000);
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

  it.each([
    ["binaryPath", 123], ["binaryPath", ""], ["proxy", false], ["userAgent", []],
    ["version", "../elsewhere"], ["version", ""], ["variant", "no-render"],
    ["allowPrivateNetwork", "true"], ["stealth", 1], ["exposure", "hidden"],
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
