import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managedBinaryPath, managedCacheDir, releaseAsset, resolveObscuraBinary } from "../src/binary.js";
import { DEFAULT_BROWSER_CONFIG } from "../src/config.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-browser-binary-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function executable(path: string, mode = 0o755): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, mode);
  return path;
}
const resolve = (extra: Partial<Parameters<typeof resolveObscuraBinary>[0]> = {}) => resolveObscuraBinary({
  config: { ...DEFAULT_BROWSER_CONFIG }, agentDir: root, env: {}, pathDirs: [], platform: "linux", arch: "x64", ...extra,
});

describe("resolveObscuraBinary", () => {
  it("selects config, env, PATH, then cache in that order", async () => {
    const configPath = await executable(join(root, "explicit"));
    const envPath = await executable(join(root, "environment"));
    const path = await executable(join(root, "bin", "obscura"));
    const cache = await executable(join(root, "pi-browser", "obscura", "0.2.3", "obscura"));
    const options = { env: { PI_BROWSER_OBSCURA_BIN: envPath }, pathDirs: [join(root, "bin")] };
    expect(resolve({ ...options, config: { ...DEFAULT_BROWSER_CONFIG, binaryPath: configPath } }))
      .toEqual({ ok: true, path: configPath, source: "config" });
    expect(resolve(options)).toEqual({ ok: true, path: envPath, source: "env" });
    expect(resolve({ pathDirs: options.pathDirs })).toEqual({ ok: true, path, source: "path" });
    expect(resolve()).toEqual({ ok: true, path: cache, source: "cache" });
  });

  it("skips missing, directory, and non-executable candidates", async () => {
    await mkdir(join(root, "directory"));
    await executable(join(root, "bin1", "obscura"), 0o644);
    const path = await executable(join(root, "bin2", "obscura"));
    expect(resolve({
      config: { ...DEFAULT_BROWSER_CONFIG, binaryPath: join(root, "missing") },
      env: { PI_BROWSER_OBSCURA_BIN: join(root, "directory") },
      pathDirs: [join(root, "bin1"), join(root, "bin2")],
    })).toEqual({ ok: true, path, source: "path" });
  });

  it("uses PATH from the supplied environment when pathDirs is omitted", async () => {
    const path = await executable(join(root, "bin", "obscura"));
    expect(resolve({ pathDirs: undefined, env: { PATH: join(root, "bin") } })).toEqual({ ok: true, path, source: "path" });
  });

  it("uses .exe and existence rather than Unix execute permission for Windows", async () => {
    const path = await executable(join(root, "bin", "obscura.exe"), 0o644);
    expect(resolve({ platform: "win32", pathDirs: [join(root, "bin")] })).toEqual({ ok: true, path, source: "path" });
  });

  it("uses the configured pinned version for the cache directory", async () => {
    const path = await executable(join(root, "pi-browser", "obscura", "0.2.4", "obscura"));
    expect(resolve({ config: { ...DEFAULT_BROWSER_CONFIG, version: "0.2.4" } })).toEqual({ ok: true, path, source: "cache" });
  });

  it("ignores stray backup and temporary directories rather than falling back to their binaries", async () => {
    const cache = managedCacheDir(root);
    await executable(join(cache, `${DEFAULT_BROWSER_CONFIG.version}.bak-abandoned`, "obscura"));
    await executable(join(cache, "tmp-abandoned", "obscura"));
    expect(resolve().ok).toBe(false);
    const binary = await executable(managedBinaryPath(root, DEFAULT_BROWSER_CONFIG.version, "linux"));
    expect(resolve()).toEqual({ ok: true, path: binary, source: "cache" });
  });

  it("supports an injected filesystem", () => {
    const result = resolve({
      config: { ...DEFAULT_BROWSER_CONFIG, binaryPath: join(root, "virtual") },
      fs: {
        accessSync: () => {},
        statSync: (() => ({ isFile: () => true })) as unknown as typeof import("node:fs").statSync,
      },
    });
    expect(result).toEqual({ ok: true, path: join(root, "virtual"), source: "config" });
  });

  it.each(["0.2.3", "0.2.4"])("explains provisioning, the managed cache, and installing pinned v%s on failure", (version) => {
    const result = resolve({ config: { ...DEFAULT_BROWSER_CONFIG, version } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    for (const hint of ["binaryPath", "PI_BROWSER_OBSCURA_BIN", "PATH", "No binary is bundled", managedBinaryPath(root, version, "linux")]) {
      expect(result.message).toContain(hint);
    }
    expect(result.message).not.toContain("later milestone");
    expect(result.message.endsWith(`Run /browser install to download the pinned release v${version}, or set autoInstall to "ask" to be prompted on first use.`)).toBe(true);
  });
});

describe("managed cache paths", () => {
  it("uses the resolver's cache layout on Unix and Windows", () => {
    expect(managedCacheDir(root)).toBe(join(root, "pi-browser", "obscura"));
    expect(managedBinaryPath(root, "0.2.3", "linux")).toBe(join(managedCacheDir(root), "0.2.3", "obscura"));
    expect(managedBinaryPath(root, "0.2.3", "win32")).toBe(join(managedCacheDir(root), "0.2.3", "obscura.exe"));
    expect(managedBinaryPath(root, "0.2.3")).toBe(join(managedCacheDir(root), "0.2.3", process.platform === "win32" ? "obscura.exe" : "obscura"));
  });
});

describe("releaseAsset (upstream v0.2.3 names)", () => {
  const targets = [
    ["linux", "x64", "obscura-x86_64-linux"],
    ["linux", "arm64", "obscura-aarch64-linux"],
    ["darwin", "x64", "obscura-x86_64-macos"],
    ["darwin", "arm64", "obscura-aarch64-macos"],
    ["win32", "x64", "obscura-x86_64-windows"],
  ] as const;
  it.each(targets)("maps %s/%s render and stealth archives", (platform, arch, prefix) => {
    const extension = platform === "win32" ? ".zip" : ".tar.gz";
    expect(releaseAsset({ platform, arch, variant: "render" })).toBe(prefix + extension);
    expect(releaseAsset({ platform, arch, variant: "stealth" })).toBe(prefix + "-stealth" + extension);
  });
  it("rejects unsupported targets rather than inventing asset names", () => {
    expect(releaseAsset({ platform: "win32", arch: "arm64", variant: "render" })).toBeNull();
    expect(releaseAsset({ platform: "linux", arch: "ia32", variant: "render" })).toBeNull();
    expect(releaseAsset({ platform: "freebsd", arch: "x64", variant: "render" })).toBeNull();
  });
});
