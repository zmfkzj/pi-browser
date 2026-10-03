import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedBinaryPath, managedCacheDir, resolveObscuraBinary } from "../src/binary.js";
import { KNOWN_SHA256 } from "../src/checksums.js";
import { DEFAULT_BROWSER_CONFIG } from "../src/config.js";
import { installObscura, type InstallObscuraOptions, type InstallProgress } from "../src/install.js";

const run = promisify(execFile);
const version = "9.8.7";
const asset = "obscura-x86_64-linux.tar.gz";
let root: string;
let agentDir: string;
let server: Server;
let baseUrl: string;
let archive: Buffer;
let checksum: string;
let downloads: number;
let apiRequests: number;
let apiBody: unknown;

async function makeArchive(script = `#!/bin/sh\necho obscura ${version}\n`): Promise<Buffer> {
  const dir = await mkdtemp(join(root, "archive-"));
  const nested = join(dir, "package", "bin");
  await mkdir(nested, { recursive: true });
  await mkdir(join(dir, "extra"));
  await writeFile(join(nested, "obscura"), script, { mode: 0o644 });
  await writeFile(join(nested, "obscura-worker"), "unused worker");
  await writeFile(join(dir, "extra", "obscura-worker.exe"), "unused Windows worker");
  const path = join(root, `archive-${Date.now()}-${Math.random()}.tar.gz`);
  await run("tar", ["-czf", path, "-C", dir, "."]);
  return readFile(path);
}

function options(extra: Partial<InstallObscuraOptions> = {}): InstallObscuraOptions {
  return {
    version, variant: "render", platform: "linux", arch: "x64", agentDir, checksum,
    downloadBaseUrl: baseUrl, releaseApiUrl: `${baseUrl}/api`, ...extra,
  };
}

async function cacheEntries(): Promise<string[]> {
  try { return await readdir(managedCacheDir(agentDir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

const previousBinary = "#!/bin/sh\necho previous working install\n";
async function seedPreviousInstall(): Promise<string> {
  const binary = managedBinaryPath(agentDir, version, "linux");
  await mkdir(join(managedCacheDir(agentDir), version), { recursive: true });
  await writeFile(binary, previousBinary, { mode: 0o755 });
  return binary;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-browser-install-"));
  agentDir = join(root, "agent");
  downloads = 0;
  apiRequests = 0;
  archive = await makeArchive();
  checksum = createHash("sha256").update(archive).digest("hex");
  apiBody = { assets: [{ name: asset, digest: `sha256:${checksum}` }] };
  server = createServer((request, response) => {
    if (request.url === "/api") {
      apiRequests++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(apiBody));
      return;
    }
    downloads++;
    response.setHeader("Content-Length", archive.length);
    if (request.url?.startsWith("/slow/")) {
      response.write(archive.subarray(0, 16));
      const timer = setTimeout(() => response.end(archive.subarray(16)), 30_000);
      response.once("close", () => clearTimeout(timer));
    } else response.end(archive);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("installObscura", () => {
  it("streams a verified archive, removes workers, flattens the executable and resolves the managed cache", async () => {
    const progress: InstallProgress[] = [];
    const result = await installObscura(options({ onProgress: (p) => progress.push(p) }));
    expect(result).toEqual({ path: managedBinaryPath(agentDir, version, "linux"), version, asset, sha256: checksum, bytes: archive.length });
    await access(result.path, constants.X_OK);
    expect((await stat(result.path)).mode & 0o777).toBe(0o755);
    expect((await run(result.path, ["--version"])).stdout.trim()).toBe(`obscura ${version}`);
    await expect(access(join(managedCacheDir(agentDir), version, "package", "bin", "obscura-worker"))).rejects.toThrow();
    await expect(access(join(managedCacheDir(agentDir), version, "extra", "obscura-worker.exe"))).rejects.toThrow();
    await expect(access(join(managedCacheDir(agentDir), version, asset))).rejects.toThrow();
    expect(await cacheEntries()).toEqual([version]);
    expect(progress[0]).toEqual({ receivedBytes: 0, totalBytes: archive.length });
    expect(progress.at(-1)).toEqual({ receivedBytes: archive.length, totalBytes: archive.length });
    expect(resolveObscuraBinary({ config: { ...DEFAULT_BROWSER_CONFIG, version }, agentDir, pathDirs: [], env: {} }))
      .toEqual({ ok: true, path: result.path, source: "cache" });
    expect(downloads).toBe(1);
    expect(apiRequests).toBe(0);
  });

  it("replaces an existing binary only after verification and leaves no backup", async () => {
    const binary = await seedPreviousInstall();
    await installObscura(options());
    expect(await readFile(binary, "utf8")).toBe(`#!/bin/sh\necho obscura ${version}\n`);
    expect(await cacheEntries()).toEqual([version]);
  });

  it("keeps the committed install when backup removal fails after partially deleting the backup", async () => {
    const binary = await seedPreviousInstall();
    let leftover: string | undefined;
    const removeBackup = vi.fn(async (backup: string) => {
      leftover = backup;
      // The new executable is already committed before cleanup starts.
      expect(await readFile(binary, "utf8")).toBe(`#!/bin/sh\necho obscura ${version}\n`);
      await rm(join(backup, "obscura"));
      throw new Error("test backup removal failure");
    });
    await expect(installObscura(options({ removeBackup }))).resolves.toMatchObject({ path: binary, version });
    expect(removeBackup).toHaveBeenCalledOnce();
    expect(await readFile(binary, "utf8")).toBe(`#!/bin/sh\necho obscura ${version}\n`);
    await access(binary, constants.X_OK);
    expect((await cacheEntries()).filter((entry) => entry.includes(".bak-"))).toHaveLength(1);
    await expect(access(join(leftover!, "obscura"))).rejects.toThrow();
    // A later install safely cleans the partially removed, stale backup.
    await utimes(leftover!, new Date(0), new Date(0));
    await installObscura(options());
    expect(await cacheEntries()).toEqual([version]);
  });

  it("keeps the previous binary intact when --version verification fails", async () => {
    const binary = await seedPreviousInstall();
    archive = await makeArchive("#!/bin/sh\necho obscura 1.0.0\n");
    checksum = createHash("sha256").update(archive).digest("hex");
    await expect(installObscura(options())).rejects.toThrow(`did not report version ${version}`);
    expect(await readFile(binary, "utf8")).toBe(previousBinary);
    expect(await cacheEntries()).toEqual([version]);
  });

  it("restores the previous install after an abort between backup and swap, including finally cleanup", async () => {
    const binary = await seedPreviousInstall();
    const controller = new AbortController();
    const afterBackupMove = vi.fn(async ({ backup, destination }: { backup: string; destination: string }) => {
      expect(await readFile(join(backup, "obscura"), "utf8")).toBe(previousBinary);
      await expect(access(destination)).rejects.toThrow();
      controller.abort();
    });
    await expect(installObscura(options({ signal: controller.signal, afterBackupMove })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(afterBackupMove).toHaveBeenCalledOnce();
    expect(await readFile(binary, "utf8")).toBe(previousBinary);
    await access(binary, constants.X_OK);
    expect(await cacheEntries()).toEqual([version]);
    // Rollback also releases the installer lock.
    await installObscura(options());
  });

  it("restores the previous install if staging-to-destination rename fails", async () => {
    const binary = await seedPreviousInstall();
    // Remove the staging directory after preserving the old install: rename must fail with ENOENT.
    await expect(installObscura(options({
      afterBackupMove: async ({ temp }) => { await rm(temp, { recursive: true, force: true }); },
    }))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(binary, "utf8")).toBe(previousBinary);
    expect(await cacheEntries()).toEqual([version]);
  });

  it("cleans stale backup directories at startup without removing other installs or temp directories", async () => {
    const cache = managedCacheDir(agentDir);
    const owner = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(() => process.kill(owner, 0)).toThrow();
    const stale = join(cache, `${version}.bak-${owner}-stale`);
    const other = join(cache, "0.2.3");
    const strayTemp = join(cache, "tmp-stray");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "obscura"), previousBinary);
    await utimes(stale, new Date(0), new Date(0));
    await mkdir(other);
    await mkdir(strayTemp);
    // Cleanup precedes checksum lookup/download, even if the install cannot proceed.
    await expect(installObscura(options({ checksum: "invalid" }))).rejects.toThrow("verified SHA-256");
    expect(await cacheEntries()).toEqual(["0.2.3", "tmp-stray"]);
    await installObscura(options());
    expect(await cacheEntries()).toEqual(["0.2.3", version, "tmp-stray"]);
  });

  it("preserves another process's live rollback backup even when rename keeps an old mtime", async () => {
    const binary = await seedPreviousInstall();
    const destination = join(managedCacheDir(agentDir), version);
    await utimes(destination, new Date(0), new Date(0));
    const script = `const { renameSync } = require('node:fs');
      const destination = process.argv[1];
      const backup = destination + '.bak-' + process.pid + '-live';
      renameSync(destination, backup);
      process.send(backup);
      process.on('message', () => { renameSync(backup, destination); process.disconnect(); });`;
    const owner = spawn(process.execPath, ["-e", script, destination], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = new Promise<number | null>(resolve => owner.once("close", resolve));
    try {
      const backup = await new Promise<string>((resolve, reject) => {
        owner.once("message", value => resolve(String(value)));
        owner.once("error", reject);
        owner.once("exit", () => reject(new Error("Backup owner exited before preserving the install")));
      });
      expect((await stat(backup)).mtimeMs).toBe(0);
      await expect(installObscura(options({ checksum: "invalid" }))).rejects.toThrow("verified SHA-256");
      expect(await readFile(join(backup, "obscura"), "utf8")).toBe(previousBinary);
      owner.send("rollback");
      expect(await exited).toBe(0);
      expect(await readFile(binary, "utf8")).toBe(previousBinary);
    } finally {
      owner.kill("SIGKILL");
      await exited;
    }
  });

  it("retains backups with unknown owners or inaccessible live owner pids", async () => {
    const cache = managedCacheDir(agentDir);
    const names = [`${version}.bak-legacy`, `${version}.bak-123456789-protected`];
    for (const name of names) await mkdir(join(cache, name), { recursive: true });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    try {
      await expect(installObscura(options({ checksum: "invalid" }))).rejects.toThrow("verified SHA-256");
      expect(await cacheEntries()).toEqual([...names].sort());
    } finally { kill.mockRestore(); }
  });

  it("rejects checksum mismatches and leaves no temporary or installed directory", async () => {
    const wrong = "0".repeat(64);
    await expect(installObscura(options({ checksum: wrong }))).rejects
      .toThrow(`Checksum mismatch for ${asset}: expected ${wrong}, got ${checksum}`);
    expect(await cacheEntries()).toEqual([]);
  });

  it("uses the pinned checksum ahead of the API, and an explicit checksum ahead of the pin", async () => {
    await expect(installObscura(options({ version: "0.2.3", checksum: undefined }))).rejects
      .toThrow(`expected ${KNOWN_SHA256[`0.2.3/${asset}`]}`);
    expect(apiRequests).toBe(0);
    // Our fake archive prints 9.8.7, so verification still fails even with a trusted explicit checksum.
    await expect(installObscura(options({ version: "0.2.3" }))).rejects.toThrow("did not report version 0.2.3");
    expect(apiRequests).toBe(0);
    expect(await cacheEntries()).toEqual([]);
  });

  it("fails before downloading when no trusted checksum is available", async () => {
    apiBody = { assets: [{ name: asset }] };
    await expect(installObscura(options({ checksum: undefined }))).rejects
      .toThrow(`No trusted checksum for ${asset}; install manually (see README) or pass /browser install with a verified build.`);
    expect(downloads).toBe(0);
    expect(apiRequests).toBe(1);
    expect(await cacheEntries()).toEqual([]);
  });

  it("uses a matching release API SHA-256 digest", async () => {
    const result = await installObscura(options({ checksum: undefined }));
    expect(result.sha256).toBe(checksum);
    expect(apiRequests).toBe(1);
    expect(downloads).toBe(1);
  });

  it.each(["md5:abc", "sha256:bad", "sha256:" + "z".repeat(64)])("refuses an untrusted API digest %s", async (digest) => {
    apiBody = { assets: [{ name: asset, digest }] };
    await expect(installObscura(options({ checksum: undefined }))).rejects.toThrow("No trusted checksum");
    expect(downloads).toBe(0);
  });

  it("requires the exact asset name in the API", async () => {
    apiBody = { assets: [{ name: "other.tar.gz", digest: `sha256:${checksum}` }] };
    await expect(installObscura(options({ checksum: undefined }))).rejects.toThrow("No trusted checksum");
    expect(downloads).toBe(0);
  });

  it("rejects an invalid explicit checksum without requesting the API or archive", async () => {
    await expect(installObscura(options({ checksum: "not verified" }))).rejects.toThrow("verified SHA-256");
    expect(apiRequests).toBe(0);
    expect(downloads).toBe(0);
  });

  it("accepts uppercase verified hex checksums", async () => {
    expect((await installObscura(options({ checksum: checksum.toUpperCase() }))).sha256).toBe(checksum);
  });

  it("cleans up when the injectable tar fails", async () => {
    const tar = vi.fn(async () => { throw new Error("test tar failure"); });
    await expect(installObscura(options({ tar }))).rejects.toThrow("test tar failure");
    expect(tar.mock.calls).toHaveLength(1);
    expect(await cacheEntries()).toEqual([]);
  });

  it("cleans up on an aborted partial download", async () => {
    const controller = new AbortController();
    await expect(installObscura(options({
      downloadBaseUrl: `${baseUrl}/slow`, signal: controller.signal,
      onProgress: (p) => { if (p.receivedBytes > 0) controller.abort(); },
    }))).rejects.toThrow();
    expect(downloads).toBe(1);
    expect(await cacheEntries()).toEqual([]);
    // A failed/aborted install releases the module-level lock.
    expect((await installObscura(options())).sha256).toBe(checksum);
  });

  it("refuses concurrent installs", async () => {
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = installObscura(options({ tar: async (args) => { ready(); await gate; await run("tar", args); } }));
    try {
      await entered;
      await expect(installObscura(options())).rejects.toThrow("An obscura install is already in progress.");
    } finally { release(); }
    expect((await first).sha256).toBe(checksum);
    expect(await cacheEntries()).toEqual([version]);
  });

  it("removes the staging directory when --version reports the wrong version", async () => {
    archive = await makeArchive("#!/bin/sh\necho obscura 1.0.0\n");
    checksum = createHash("sha256").update(archive).digest("hex");
    await expect(installObscura(options())).rejects.toThrow(`did not report version ${version}`);
    expect(await cacheEntries()).toEqual([]);
  });

  it("adds the Linux glibc hint for a missing dynamic interpreter", async () => {
    archive = await makeArchive("#!/nonexistent-obscura-interpreter\n");
    checksum = createHash("sha256").update(archive).digest("hex");
    await expect(installObscura(options())).rejects.toThrow("obscura release binaries need glibc 2.35+ (Ubuntu 22.04+)");
    expect(await cacheEntries()).toEqual([]);
  });

  it("rejects unsafe versions and unsupported platforms before requesting anything", async () => {
    await expect(installObscura(options({ version: "../escape" }))).rejects.toThrow("Invalid obscura release version");
    await expect(installObscura(options({ platform: "freebsd" }))).rejects.toThrow("No obscura release asset");
    expect(downloads).toBe(0);
    expect(apiRequests).toBe(0);
  });

  it("pins all ten rendering-enabled v0.2.3 digests with the locally cross-checked Linux x64 entry", () => {
    expect(Object.keys(KNOWN_SHA256)).toHaveLength(10);
    expect(KNOWN_SHA256[`0.2.3/${asset}`]).toBe("1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec");
    for (const value of Object.values(KNOWN_SHA256)) expect(value).toMatch(/^[a-f\d]{64}$/);
  });
});
