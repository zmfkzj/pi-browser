import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserConfig } from "./config.js";
import { defaultSpillDir } from "./output.js";
import { summarizePage } from "./page.js";
import { UnsupportedOperationError, type BrowserEngine, type Target } from "./engine.js";

export { describeError } from "./engines/obscura.js";
export function targetArgs({ ref, selector }: { ref?: string; selector?: string }, engine?: BrowserEngine): Target {
  if ((ref !== undefined) === (selector !== undefined)) throw new Error("Provide exactly one of ref or selector.");
  if (ref !== undefined) return { ref };
  if (!selector?.trim()) throw new Error("selector must be a non-empty string.");
  // TODO: engines may emulate selectors via evaluate; expose that through capabilities.selectors.
  if (engine && !engine.capabilities.selectors) throw new UnsupportedOperationError(engine.name, "CSS selectors", engine.name === "chrome" ? "obscura" : "chrome");
  return { selector };
}
export function optionalTarget(params: { ref?: string; selector?: string }, engine?: BrowserEngine): Target | undefined {
  return params.ref === undefined && params.selector === undefined ? undefined : targetArgs(params, engine);
}
export async function actionResult(session: BrowserEngine, headline: string, params: { snapshot?: boolean }, config: BrowserConfig, signal?: AbortSignal): Promise<string> {
  return params.snapshot === false ? headline : `${headline}\n\n${await summarizePage(session, { maxChars: config.actionSummaryChars, limit: 40, signal })}`;
}

let artifactSequence = 0;
/** Resolve a destination; writeArtifact owns the atomic no-overwrite write. */
export async function artifactPath(config: BrowserConfig, cwd: string, kind: string, ext: string, requestedPath?: string): Promise<string> {
  if (requestedPath !== undefined && !requestedPath.trim()) throw new Error("path must be a non-empty string.");
  const dir = config.artifactsDir === null ? defaultSpillDir() : resolve(cwd, config.artifactsDir);
  const path = requestedPath === undefined ? join(dir, `${kind}-${++artifactSequence}.${ext}`) : resolve(cwd, requestedPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}

export async function writeArtifact(path: string, data: string | Uint8Array): Promise<void> {
  try { await writeFile(path, data, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`File already exists: ${path}. Pick another path; browser artifacts never overwrite files.`);
    throw error;
  }
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await sleep(ms, undefined, { signal });
}

export function httpUrl(url: string, tool: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${tool} requires a valid http: or https: URL.`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${tool} supports only http: and https: URLs; other schemes are not allowed.`);
}

export function storageState(value: unknown): { cookies: unknown[]; origins: unknown[] } {
  if (value === null || typeof value !== "object" || !("cookies" in value) || !("origins" in value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new Error("Storage state must be a JSON object with cookies and origins arrays: { cookies: [], origins: [] }.");
  }
  return value as { cookies: unknown[]; origins: unknown[] };
}
