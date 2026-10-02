import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { BrowserConfig } from "./config.js";

export type BinarySource = "config" | "env" | "path" | "cache";
export type BinaryResolution =
  | { ok: true; path: string; source: BinarySource }
  | { ok: false; message: string };

export interface BinaryFileSystem {
  accessSync: typeof accessSync;
  statSync: typeof statSync;
}

export function managedCacheDir(agentDir: string): string {
  return join(agentDir, "pi-browser", "obscura");
}

export function managedBinaryPath(agentDir: string, version: string, platform: NodeJS.Platform = process.platform): string {
  return join(managedCacheDir(agentDir), version, platform === "win32" ? "obscura.exe" : "obscura");
}

export function resolveObscuraBinary(options: {
  config: BrowserConfig;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  pathDirs?: string[];
  fs?: BinaryFileSystem;
}): BinaryResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? { accessSync, statSync };
  const executable = platform === "win32" ? "obscura.exe" : "obscura";
  const separator = platform === "win32" ? ";" : delimiter;
  const pathDirs = options.pathDirs ?? (env.PATH ?? "").split(separator).filter(Boolean);
  const candidates: { path: string; source: BinarySource }[] = [];
  if (options.config.binaryPath) candidates.push({ path: options.config.binaryPath, source: "config" });
  if (env.PI_BROWSER_OBSCURA_BIN) candidates.push({ path: env.PI_BROWSER_OBSCURA_BIN, source: "env" });
  candidates.push(...pathDirs.map((dir) => ({ path: join(dir, executable), source: "path" as const })));
  candidates.push({
    path: managedBinaryPath(options.agentDir, options.config.version, platform),
    source: "cache",
  });
  for (const candidate of candidates) {
    const path = resolve(candidate.path);
    try {
      if (!fs.statSync(path).isFile()) continue;
      fs.accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      return { ok: true, path, source: candidate.source };
    } catch {
      // A missing or non-executable candidate does not hide a later valid one.
    }
  }
  return {
    ok: false,
    message: "Obscura executable not found. Provide it by setting binaryPath in browser.config.json, "
      + "setting PI_BROWSER_OBSCURA_BIN, or placing obscura on PATH. "
      + `The managed cache was also checked (${candidates.at(-1)?.path}). `
      + "No binary is bundled with pi-browser. "
      + `Run /browser install to download the pinned release v${options.config.version}, or set autoInstall to "ask" to be prompted on first use.`,
  };
}

/** Names verified against the upstream v0.2.3 release assets (rendering enabled). */
export function releaseAsset(options: {
  platform: NodeJS.Platform;
  arch: string;
  variant: BrowserConfig["variant"];
}): string | null {
  const cpu = options.arch === "x64" ? "x86_64" : options.arch === "arm64" ? "aarch64" : null;
  const os = options.platform === "linux" ? "linux"
    : options.platform === "darwin" ? "macos"
    : options.platform === "win32" ? "windows" : null;
  if (!cpu || !os || (os === "windows" && cpu !== "x86_64")) return null;
  const suffix = options.variant === "stealth" ? "-stealth" : "";
  return `obscura-${cpu}-${os}${suffix}.${os === "windows" ? "zip" : "tar.gz"}`;
}
