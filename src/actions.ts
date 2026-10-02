import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserConfig } from "./config.js";
import { defaultSpillDir } from "./output.js";
import { summarizePage, type PageSession } from "./page.js";

export { describeError } from "./page.js";
export interface Target { ref?: string; selector?: string }

export function targetArgs({ ref, selector }: Target): { ref: string } | { selector: string } {
  if ((ref !== undefined) === (selector !== undefined)) throw new Error("Provide exactly one of ref or selector.");
  if (ref !== undefined) {
    if (!/^e\d+$/.test(ref)) throw new Error("ref must match /^e\\d+$/ (for example e1).");
    return { ref };
  }
  if (!selector?.trim()) throw new Error("selector must be a non-empty string.");
  return { selector };
}

export function refToSelector(ref: string): string {
  targetArgs({ ref });
  return `[data-obscura-ref="${ref}"]`;
}

export function optionalTarget(params: Target): Record<string, string> {
  return params.ref === undefined && params.selector === undefined ? {} : targetArgs(params);
}

export function selectorTarget(params: Target): { selector: string } {
  const target = targetArgs(params);
  return { selector: "ref" in target ? refToSelector(target.ref) : target.selector };
}

export async function actionResult(session: PageSession, headline: string, params: { snapshot?: boolean }, config: BrowserConfig, signal?: AbortSignal): Promise<string> {
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
