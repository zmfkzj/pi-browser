import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { managedBinaryPath, managedCacheDir, releaseAsset } from "./binary.js";
import { KNOWN_SHA256 } from "./checksums.js";
import type { BrowserConfig } from "./config.js";
import { buildChildEnv } from "./mcp-client.js";

export interface InstallProgress { receivedBytes: number; totalBytes: number | null }
export interface InstallObscuraOptions {
  version: string;
  variant: BrowserConfig["variant"];
  platform: NodeJS.Platform;
  arch: string;
  agentDir: string;
  fetch?: typeof fetch;
  downloadBaseUrl?: string;
  releaseApiUrl?: string;
  checksum?: string;
  tar?: (args: string[], options: { signal?: AbortSignal }) => Promise<void>;
  onProgress?: (p: InstallProgress) => void;
  /** Internal test seam: called after preserving an existing install, before swapping. */
  afterBackupMove?: (paths: { backup: string; destination: string; temp: string }) => void | Promise<void>;
  /** Internal test seam: override post-commit backup cleanup. */
  removeBackup?: (path: string) => Promise<void>;
  signal?: AbortSignal;
}
export interface InstallObscuraResult { path: string; version: string; asset: string; sha256: string; bytes: number }

const run = promisify(execFile);
let installing = false;

function sha256(value: string): string {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error("Expected a verified SHA-256 checksum (64 hex characters).");
  return value.toLowerCase();
}

async function trustedChecksum(o: InstallObscuraOptions, asset: string): Promise<string> {
  if (o.checksum !== undefined) return sha256(o.checksum);
  const pinned = KNOWN_SHA256[`${o.version}/${asset}`];
  if (pinned) return sha256(pinned);
  try {
    const response = await (o.fetch ?? fetch)(o.releaseApiUrl
      ?? `https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v${o.version}`, {
      signal: o.signal, headers: { Accept: "application/vnd.github+json" },
    });
    if (response.ok) {
      const release = await response.json() as { assets?: { name?: string; digest?: string }[] };
      const digest = Array.isArray(release?.assets)
        ? release.assets.find((entry) => entry?.name === asset)?.digest : undefined;
      if (typeof digest === "string" && /^sha256:[a-f\d]{64}$/i.test(digest)) return sha256(digest.slice(7));
    }
  } catch {
    // API errors cannot weaken the verification policy; cancellation still propagates.
    o.signal?.throwIfAborted();
  }
  o.signal?.throwIfAborted();
  throw new Error(`No trusted checksum for ${asset}; install manually (see README) or pass /browser install with a verified build.`);
}

async function extract(args: string[], options: { signal?: AbortSignal }): Promise<void> {
  await run("tar", args, { signal: options.signal, env: buildChildEnv(process.env), killSignal: "SIGKILL" });
}

/** Do not follow symlinks from an extracted archive. */
async function prepareBinary(dir: string, executable: string): Promise<string | undefined> {
  let binary: string | undefined;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name === "obscura-worker" || entry.name === "obscura-worker.exe") {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      const found = await prepareBinary(path, executable);
      binary ??= found;
    } else if (entry.isFile() && entry.name === executable) {
      binary ??= path;
    }
  }
  return binary;
}

async function verifyBinary(path: string, o: InstallObscuraOptions): Promise<void> {
  try {
    const { stdout, stderr } = await run(path, ["--version"], {
      timeout: 10_000, signal: o.signal, killSignal: "SIGKILL", env: buildChildEnv(process.env), maxBuffer: 1024 * 1024,
    });
    if (!`${stdout}\n${stderr}`.includes(o.version)) {
      throw new Error(`Installed obscura did not report version ${o.version}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (o.platform === "linux" && (/ELF|glibc|GLIBC|exec format|shared librar|dynamic linker/i.test(message)
      || code === "ENOEXEC" || code === "ENOENT")) {
      throw new Error(`${message}\nobscura release binaries need glibc 2.35+ (Ubuntu 22.04+)`);
    }
    throw error;
  }
}

/** Only old backup directories are garbage; never select them as installed versions. */
async function removeStaleBackups(cache: string, startedAt: number): Promise<void> {
  try {
    for (const entry of await readdir(cache, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.includes(".bak-")) continue;
      const path = join(cache, entry.name);
      try {
        if ((await stat(path)).mtimeMs < startedAt) await rm(path, { recursive: true, force: true });
      } catch { /* Startup hygiene must not prevent an install. */ }
    }
  } catch { /* Best effort, including unreadable cache directories. */ }
}

/** Install only a verified archive; at most one install runs in this process. */
export async function installObscura(o: InstallObscuraOptions): Promise<InstallObscuraResult> {
  if (installing) throw new Error("An obscura install is already in progress.");
  installing = true;
  let temp: string | undefined;
  const startedAt = Date.now();
  try {
    o.signal?.throwIfAborted();
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(o.version)) throw new Error("Invalid obscura release version.");
    const asset = releaseAsset(o);
    if (!asset) throw new Error(`No obscura release asset for ${o.platform}/${o.arch}. Install manually (see README).`);
    const cache = managedCacheDir(o.agentDir);
    await mkdir(cache, { recursive: true });
    await removeStaleBackups(cache, startedAt);
    const expected = await trustedChecksum(o, asset);
    o.signal?.throwIfAborted();
    temp = await mkdtemp(join(cache, "tmp-"));
    const archive = join(temp, asset);
    const response = await (o.fetch ?? fetch)(`${o.downloadBaseUrl
      ?? "https://github.com/h4ckf0r0day/obscura/releases/download"}/v${o.version}/${asset}`, { signal: o.signal });
    if (!response.ok || !response.body) throw new Error(`Download failed for ${asset}: HTTP ${response.status}.`);
    const length = response.headers.get("content-length");
    const totalBytes = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
    const hash = createHash("sha256");
    let bytes = 0;
    const file = await open(archive, "wx", 0o600);
    const reader = response.body.getReader();
    try {
      o.onProgress?.({ receivedBytes: 0, totalBytes });
      while (true) {
        o.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        o.signal?.throwIfAborted();
        hash.update(value);
        await file.writeFile(value);
        bytes += value.byteLength;
        o.onProgress?.({ receivedBytes: bytes, totalBytes });
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await file.close();
    }
    const actual = hash.digest("hex");
    if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    o.signal?.throwIfAborted();
    await (o.tar ?? extract)([o.platform === "win32" ? "-xf" : "-xzf", archive, "-C", temp], { signal: o.signal });
    o.signal?.throwIfAborted();
    await rm(archive);
    const name = o.platform === "win32" ? "obscura.exe" : "obscura";
    const extracted = await prepareBinary(temp, name);
    if (!extracted) throw new Error(`Archive ${asset} contains no ${name} executable.`);
    const rootBinary = join(temp, name);
    if (extracted !== rootBinary) await rename(extracted, rootBinary);
    await chmod(rootBinary, 0o755);
    await verifyBinary(rootBinary, o);
    o.signal?.throwIfAborted();
    const destination = join(cache, o.version);
    const backupPath = `${destination}.bak-${randomUUID()}`;
    let backup: string | undefined;
    try {
      try {
        await rename(destination, backupPath);
        backup = backupPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (backup) await o.afterBackupMove?.({ backup, destination, temp });
      o.signal?.throwIfAborted();
      await rename(temp, destination);
    } catch (error) {
      // Rollback does not use the aborted signal. Finally only cleans the staging path.
      if (backup) await rename(backup, destination);
      throw error;
    }
    // The atomic staging rename commits the install. Backup cleanup cannot roll it back,
    // especially if rm has already partially removed the old directory.
    if (backup) {
      try {
        if (o.removeBackup) await o.removeBackup(backup);
        else await rm(backup, { recursive: true, force: true });
      } catch { /* Best effort: startup hygiene removes leftover backups next time. */ }
    }
    const path = managedBinaryPath(o.agentDir, o.version, o.platform);
    return { path, version: o.version, asset, sha256: actual, bytes };
  } finally {
    try {
      if (temp) await rm(temp, { recursive: true, force: true });
    } finally {
      installing = false;
    }
  }
}
