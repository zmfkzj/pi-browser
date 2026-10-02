import { isIP } from "node:net";
import type { BrowserConfig, EngineSetting } from "./config.js";
import type { BrowserEngine, EngineName, EngineStatus } from "./engine.js";
import type { PendingStorage } from "./state.js";

export interface Availability { ok: boolean; reason?: string }
/** Compatibility helper for consumers that deliberately disable Chrome. */
export const chromeUnavailable = (): Availability => ({ ok: false, reason: "chrome engine disabled in config" });
export interface EngineManagerOptions {
  config: Pick<BrowserConfig, "engine">;
  factories: Partial<Record<EngineName, () => BrowserEngine>>;
  availability: Record<EngineName, () => Availability>;
  onStateChange?: () => void;
}
/** URL routing is lexical: no DNS/network access or private-network permission changes. */
export function isDevelopmentUrl(url?: string): boolean {
  if (!url) return false;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""); } catch { return false; }
  if (host === "localhost" || [".localhost", ".local", ".test"].some(s => host.endsWith(s))) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(host) === 6) {
    if (host === "::1" || host === "::" || /^(fc|fd)/.test(host) || /^fe[89ab]/.test(host)) return true;
    // WHATWG URL canonicalizes IPv4-mapped IPv6 to hexadecimal words.
    const m = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(host);
    if (m) {
      const hi = parseInt(m[1]!, 16), lo = parseInt(m[2]!, 16);
      return isDevelopmentUrl(`http://${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return false;
}
export class EngineManager {
  private engines = new Map<EngineName, BrowserEngine>();
  private activeName?: EngineName;
  private nextName?: EngineName;
  private sessionDefault?: EngineName;
  private pending = new Map<EngineName, PendingStorage>();
  constructor(private readonly options: EngineManagerOptions) {}
  active(): BrowserEngine | undefined { return this.activeName ? this.engines.get(this.activeName) : undefined; }
  require(): BrowserEngine {
    const engine = this.active();
    if (!engine) throw new Error("No page is open yet; call browser_navigate first.");
    return engine;
  }
  private available(name: EngineName): Availability {
    const result = this.options.availability[name]();
    return result.ok && !this.options.factories[name] ? { ok: false, reason: `No factory registered for the ${name} engine.` } : result;
  }
  private check(name: EngineName): void {
    const result = this.available(name);
    if (!result.ok) throw new Error(`Cannot use engine "${name}": ${result.reason ?? "unavailable"} ${name === "obscura" ? "Configure binaryPath or PI_BROWSER_OBSCURA_BIN, put obscura on PATH, or run /browser install." : "Install/enable the chrome engine or use engine \"obscura\"."}`);
  }
  private get(name: EngineName): BrowserEngine {
    this.check(name);
    let engine = this.engines.get(name);
    if (!engine) { engine = this.options.factories[name]!(); this.engines.set(name, engine); }
    return engine;
  }
  async select(opts: { engine?: EngineName; url?: string } = {}): Promise<BrowserEngine> {
    let name = opts.engine ?? this.nextName ?? this.activeName;
    if (!name) {
      const setting = this.sessionDefault ?? this.options.config.engine;
      if (setting !== "auto") name = setting;
      else {
        const chrome = this.available("chrome"), obscura = this.available("obscura");
        if (chrome.ok && isDevelopmentUrl(opts.url)) name = "chrome";
        else if (obscura.ok) name = "obscura";
        else if (chrome.ok) name = "chrome";
        else throw new Error(`No browser engine is available. obscura: ${obscura.reason ?? "unavailable"}; chrome: ${chrome.reason ?? "unavailable"}. Configure binaryPath or run /browser install.`);
      }
    }
    const engine = this.get(name);
    this.activeName = name;
    this.nextName = undefined;
    this.options.onStateChange?.();
    return engine;
  }
  /** Target an existing engine for tab switch/close without consuming the next-navigation default. */
  activate(name: EngineName): BrowserEngine {
    const engine = this.get(name);
    this.activeName = name;
    this.options.onStateChange?.();
    return engine;
  }
  async switchTo(name: EngineName): Promise<void> {
    this.check(name);
    this.sessionDefault = name;
    this.nextName = name;
    // Running engines may have pages; asking them is engine-agnostic and does not start new ones.
    const engine = this.engines.get(name);
    if (engine?.status().running && !/^No open (tabs|pages)\.?$/i.test((await engine.tabs("list", {})).trim())) {
      this.activeName = name; this.nextName = undefined;
    }
    this.options.onStateChange?.();
  }
  pendingFor(name: EngineName): PendingStorage {
    let queue = this.pending.get(name);
    if (!queue) { queue = new Map(); this.pending.set(name, queue); }
    return queue;
  }
  clearPending(name?: EngineName): void {
    if (name) this.pending.get(name)?.clear();
    else for (const queue of this.pending.values()) queue.clear();
  }
  async stopAll(): Promise<void> {
    this.clearPending();
    try { await Promise.all([...this.engines.values()].map(e => e.stop())); }
    finally { this.clearPending(); this.activeName = undefined; this.options.onStateChange?.(); }
  }
  async restartActive(): Promise<void> {
    const engine = this.require();
    this.clearPending(engine.name);
    // Clear the old queue; a configured profile may enqueue freshly restored storage.
    try { await engine.restart(); } finally { this.options.onStateChange?.(); }
  }
  /** Notify after idle/crash/deadline termination as well as explicit lifecycle commands. */
  engineStopped(name: EngineName): void { this.clearPending(name); this.options.onStateChange?.(); }
  async listTabs(name?: EngineName, signal?: AbortSignal): Promise<string> {
    if (name) this.check(name);
    const entries = [...this.engines].filter(([n, e]) => (!name || name === n) && e.status().running);
    return entries.length ? (await Promise.all(entries.map(async ([n, e]) => `[${n}]${n === this.activeName ? " (active)" : ""}\n${await e.tabs("list", {}, signal)}`))).join("\n\n") : "No open tabs.";
  }
  status(): { active?: EngineName; default: EngineSetting; configDefault: EngineSetting; engines: Partial<Record<EngineName, EngineStatus & { available: boolean; reason?: string }>> } {
    const engines: Partial<Record<EngineName, EngineStatus & { available: boolean; reason?: string }>> = {};
    for (const name of ["obscura", "chrome"] as const) {
      const availability = this.available(name);
      engines[name] = { ...(this.engines.get(name)?.status() ?? { running: false, detail: availability.reason ?? "not started" }), available: availability.ok, reason: availability.reason };
    }
    return { active: this.activeName, default: this.sessionDefault ?? this.options.config.engine, configDefault: this.options.config.engine, engines };
  }
}
