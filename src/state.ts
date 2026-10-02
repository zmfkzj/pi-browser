import { storageState } from "./actions.js";
import { decodeEvaluation, wrapExpression } from "./evaluate.js";
import type { BrowserEngine } from "./engine.js";
export type StorageEngine = Pick<BrowserEngine, "evaluate" | "setStorageState">;

export interface OriginStorage {
  origin: string;
  localStorage?: [string, string][];
  sessionStorage?: [string, string][];
}
export interface RestorableState { cookies: unknown[]; origins: OriginStorage[] }
export interface StorageEntries { localStorage: [string, string][]; sessionStorage: [string, string][] }
export type PendingStorage = Map<string, StorageEntries>;
export interface StorageRestoreReport {
  cookies: number;
  storageApplied: number;
  storageOrigin: string | null;
  queuedOrigins: string[];
  text: string;
}

/** Reject malformed origin data before calling obscura or modifying the pending queue. */
export function validateRestorableState(value: unknown): RestorableState {
  const state = storageState(value);
  for (const [index, entry] of state.origins.entries()) {
    const error = () => new Error(`Storage state origins[${index}] must be { origin: string, localStorage?: [string,string][], sessionStorage?: [string,string][] }.`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("origin" in entry) || typeof entry.origin !== "string" || Object.keys(entry).some((key) => !["origin", "localStorage", "sessionStorage"].includes(key))) throw error();
    for (const key of ["localStorage", "sessionStorage"] as const) {
      if (!(key in entry)) continue;
      const pairs = (entry as Record<string, unknown>)[key];
      if (!Array.isArray(pairs) || pairs.some((pair) => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string")) throw error();
    }
  }
  return state as RestorableState;
}

async function evaluate(session: StorageEngine, expression: string, signal?: AbortSignal, _cwd?: string): Promise<unknown> {
  const raw = await session.evaluate(wrapExpression(expression), signal);
  return JSON.parse(decodeEvaluation(raw)).value;
}

async function activeOrigin(session: StorageEngine, signal?: AbortSignal, cwd?: string): Promise<string> {
  const origin = await evaluate(session, "location.origin", signal, cwd);
  if (typeof origin !== "string") throw new Error("Browser evaluation did not return a string for location.origin.");
  return origin;
}

async function applyStorage(session: StorageEngine, entries: StorageEntries, signal?: AbortSignal, cwd?: string): Promise<number> {
  // Only JSON literals are embedded; quotes, newlines, and script-like values stay data.
  const expression = `(() => { const data = ${JSON.stringify(entries)}; for (const [k, v] of data.localStorage) localStorage.setItem(k, v); for (const [k, v] of data.sessionStorage) sessionStorage.setItem(k, v); return { localStorage: data.localStorage.length, sessionStorage: data.sessionStorage.length }; })()`;
  const result = await evaluate(session, expression, signal, cwd);
  if (!result || typeof result !== "object" || !("localStorage" in result) || !("sessionStorage" in result) || result.localStorage !== entries.localStorage.length || result.sessionStorage !== entries.sessionStorage.length) throw new Error("Browser evaluation did not confirm restored storage entry counts.");
  return entries.localStorage.length + entries.sessionStorage.length;
}

/** Engines restore cookies; wrapped evaluations restore origin storage safely. */
export async function restoreStorageState(session: StorageEngine, value: unknown, options: {
  signal?: AbortSignal;
  cwd?: string;
  pending: PendingStorage;
}): Promise<StorageRestoreReport> {
  const state = validateRestorableState(value);
  const restoreText = await session.setStorageState(state, options.signal);
  const cookiesSkipped = /cookies skipped on chrome/i.test(restoreText);
  const origin = await activeOrigin(session, options.signal, options.cwd);
  let storageApplied = 0;
  const queued = new Set<string>();
  for (const entry of state.origins) {
    const entries = { localStorage: entry.localStorage ?? [], sessionStorage: entry.sessionStorage ?? [] };
    if (origin !== "null" && entry.origin === origin) {
      storageApplied += await applyStorage(session, entries, options.signal, options.cwd);
      options.pending.delete(origin);
    } else {
      const previous = options.pending.get(entry.origin);
      options.pending.set(entry.origin, {
        localStorage: [...(previous?.localStorage ?? []), ...entries.localStorage],
        sessionStorage: [...(previous?.sessionStorage ?? []), ...entries.sessionStorage],
      });
      queued.add(entry.origin);
    }
  }
  const storageOrigin = origin === "null" ? null : origin;
  const cookies = cookiesSkipped ? 0 : state.cookies.length;
  const text = `${cookiesSkipped ? `${restoreText};` : `Restored ${cookies} cookies;`} applied ${storageApplied} storage entries${storageOrigin ? ` to ${storageOrigin}` : " (no active non-opaque origin)"}${queued.size ? `; queued storage for ${queued.size} other origin${queued.size === 1 ? "" : "s"} (applied on the next navigation there)` : ""}.`;
  return { cookies, storageApplied, storageOrigin, queuedOrigins: [...queued], text };
}

export async function applyPendingStorage(session: StorageEngine, pending: PendingStorage, options: { signal?: AbortSignal } = {}): Promise<string | undefined> {
  if (!pending.size) return undefined;
  const origin = await activeOrigin(session, options.signal);
  if (origin === "null") return undefined;
  const entries = pending.get(origin);
  if (!entries) return undefined;
  const count = await applyStorage(session, entries, options.signal);
  pending.delete(origin);
  return `Applied ${count} queued storage entries for ${origin}.`;
}
