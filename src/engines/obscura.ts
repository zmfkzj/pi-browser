import type { BrowserConfig } from "../config.js";
import type { BrowserEngine, Cookie, EngineCapabilities, EngineName, PageSummary, TabAction, Target } from "../engine.js";
import { UnsupportedOperationError } from "../engine.js";
import type { CallOptions, McpToolResult } from "../mcp-client.js";
import { BrowserSession, type BrowserSessionOptions, type SessionHookCall } from "../session.js";
import { contentText } from "../page.js";
import { httpUrl } from "../actions.js";
import type { FetchParams } from "../fetch.js";

export interface PageSession { call(tool: string, args: Record<string, unknown>, options?: CallOptions): Promise<McpToolResult> }
/** Obscura-only launch policy; the transport never filters environments. */
export function obscuraGlobalArgs(config: BrowserConfig): string[] {
  const args: string[] = [];
  if (config.allowPrivateNetwork) args.push("--allow-private-network");
  if (config.stealth) args.push("--stealth");
  if (config.proxy) args.push("--proxy", config.proxy);
  return args;
}
export function buildObscuraArgs(config: BrowserConfig): string[] {
  const args = ["mcp", ...obscuraGlobalArgs(config)];
  if (config.userAgent) args.push("--user-agent", config.userAgent);
  return args;
}
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parentEnv).filter(([key, value]) =>
    value !== undefined && (["PATH", "HOME", "TMPDIR", "TMP", "TEMP"].includes(key) || key.startsWith("OBSCURA_"))));
}
export function describeError(message: string, cwd?: string): string {
  if (/unknown ref/i.test(message)) {
    message += "\nRefs change after every action or navigation; call browser_snapshot and use a ref from the latest result.";
  }
  if (/private\/internal IP|private.*address.*block/i.test(message)) {
    message += `\nPrivate/loopback addresses are blocked by default. Set "allowPrivateNetwork": true in ${cwd ? `${cwd}/.pi/browser.config.json` : ".pi/browser.config.json"} (trusted project) or ~/.pi/agent/browser.config.json, then /browser restart.`;
  }
  return message;
}

export function checkedText(result: McpToolResult, cwd?: string): string {
  const text = contentText(result.content);
  if (result.isError) throw new Error(describeError(text || "Obscura reported a tool error", cwd));
  return text;
}

export function targetArgs({ ref, selector }: { ref?: string; selector?: string }): { ref: string } | { selector: string } {
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

export function optionalTarget(params: { ref?: string; selector?: string }): Record<string, string> {
  return params.ref === undefined && params.selector === undefined ? {} : targetArgs(params);
}

export function selectorTarget(params: { ref?: string; selector?: string }): { selector: string } {
  const target = targetArgs(params);
  return { selector: "ref" in target ? refToSelector(target.ref) : target.selector };
}

/** Build argv without a shell; validate even when called outside the tool schema. */
export function buildFetchArgs(url: string, params: FetchParams, config: BrowserConfig): string[] {
  httpUrl(url, "browser_fetch");
  const timeoutMs = params.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1000 to 120000.");
  const format = params.format ?? "markdown";
  if (!["text", "markdown", "html", "links"].includes(format)) throw new Error("Unsupported fetch format.");
  if (params.maxChars !== undefined && (!Number.isSafeInteger(params.maxChars) || params.maxChars < 1)) throw new Error("maxChars must be a positive integer.");
  if (params.waitUntil !== undefined && !["load", "domcontentloaded", "networkidle0"].includes(params.waitUntil)) throw new Error("Unsupported waitUntil value.");
  if (params.selector !== undefined && !params.selector.trim()) throw new Error("selector must be a non-empty string.");
  const args = ["fetch", url, "--dump", format, "--timeout", String(Math.ceil(timeoutMs / 1000))];
  if (params.waitUntil !== undefined) args.push("--wait-until", params.waitUntil);
  if (params.selector !== undefined) args.push("--selector", params.selector);
  args.push(...obscuraGlobalArgs(config));
  if (config.userAgent) args.push("--user-agent", config.userAgent);
  return args;
}

/** Listing must be LAST: both calls rebuild obscura's ref table. */
export async function obscuraSummary(session: PageSession, options: Parameters<BrowserEngine["summarize"]>[0]): Promise<PageSummary> {
  const raw = checkedText(await session.call("browser_snapshot", { max_chars: options.maxChars }, { signal: options.signal }));
  const match = /^URL: ([^\n]*)\r?\nTitle: ([^\n]*)\r?\n\r?\n([\s\S]*)$/.exec(raw);
  const result: PageSummary = { url: match?.[1]?.trim() ?? "", title: match?.[2]?.trim() ?? "", text: match ? (match[3] ?? "").replace(/\n\n\d+ interactive element\(s\) registered\. Call browser_interactive_elements[^\n]*\s*$/, "") : raw, raw };
  if (options.includeInteractive !== false) {
    const listing = checkedText(await session.call("browser_interactive_elements", { limit: options.limit ?? 60 }, { signal: options.signal }));
    result.elements = listing.split("\n").map(line => {
      const m = /^\s*ref=(\S+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
      return m ? { ref: m[1]!, kind: m[2]!, label: m[3]! } : { ref: "", kind: "", label: line };
    });
  }
  return result;
}
export const OBSCURA_CAPABILITIES: EngineCapabilities = {
  selectors: true, pdf: true, storageState: true, cookies: true, markdown: true, search: true, schemaExtract: true, forms: true,
  fullPageScreenshot: false, hover: false, upload: false, dialog: false, emulate: false, performance: false, networkDetail: false,
};
export interface ObscuraEngineOptions extends BrowserSessionOptions {
  config: BrowserConfig;
  session?: BrowserSession;
  cwd?: string;
  onRestore?: (engine: BrowserEngine) => Promise<void>;
  onSave?: (engine: BrowserEngine) => Promise<void>;
}
export class ObscuraEngine implements BrowserEngine {
  readonly name: EngineName = "obscura";
  readonly capabilities = { ...OBSCURA_CAPABILITIES };
  readonly session: BrowserSession;
  constructor(private readonly options: ObscuraEngineOptions) {
    this.session = options.session ?? new BrowserSession({ ...options,
      label: "obscura", args: buildObscuraArgs(options.config), env: buildChildEnv(options.env ?? process.env),
      defaultDeadlineMs: options.config.timeoutMs, idleMs: options.config.idleMs,
      deadlines: { browser_evaluate: options.config.evaluateTimeoutMs },
      ...(options.onRestore ? { onAfterStart: (call: SessionHookCall) => options.onRestore!(this.hookEngine(call)) } : {}),
      ...(options.onSave ? { onBeforeStop: (call: SessionHookCall) => options.onSave!(this.hookEngine(call)) } : {}),
    });
  }
  /** A hook facade bypasses session initialization, avoiding recursive profile restore. */
  private hookEngine(call: SessionHookCall): BrowserEngine {
    return new ObscuraEngine({ ...this.options, session: { call } as BrowserSession, onRestore: undefined, onSave: undefined });
  }
  private async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal, deadlineMs?: number): Promise<string> {
    return checkedText(await this.session.call(name, args, { signal, ...(deadlineMs !== undefined ? { deadlineMs } : {}) }), this.options.cwd);
  }
  navigate(url: string, opts: { waitUntil?: string; signal?: AbortSignal }) {
    return this.call("browser_navigate", { url, ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}) }, opts.signal);
  }
  summarize(opts: Parameters<BrowserEngine["summarize"]>[0]) { return obscuraSummary(this.session, opts); }
  click(t: Target, s?: AbortSignal) { return this.call("browser_click", targetArgs(t), s); }
  fill(t: Target, value: string, s?: AbortSignal) { return this.call("browser_fill", { ...targetArgs(t), value }, s); }
  fillForm(fields: Array<Partial<Target> & { value?: string; type?: string }>, submit?: Target, s?: AbortSignal) {
    const mapped = fields.map(f => ({ ...targetArgs(f), ...(f.value !== undefined ? { value: f.value } : {}), ...(f.type !== undefined ? { type: f.type } : {}) }));
    const t = submit ? targetArgs(submit) : undefined;
    return this.call("browser_fill_form", { fields: mapped, ...(t && "ref" in t ? { submit_ref: t.ref } : {}), ...(t && "selector" in t ? { submit_selector: t.selector } : {}) }, s);
  }
  async type(t: Target, text: string, pressEnter: boolean, s?: AbortSignal) {
    let headline = await this.call("browser_type", { ...targetArgs(t), text }, s);
    if (pressEnter) headline += `\n${await this.pressKey("Enter", t, s)}`;
    return headline;
  }
  pressKey(key: string, t?: Target, s?: AbortSignal) { return this.call("browser_press_key", { key, ...(t ? selectorTarget(t) : {}) }, s); }
  select(t: Target, value: string, s?: AbortSignal) { return this.call("browser_select_option", { ...selectorTarget(t), value }, s); }
  scroll(opts: { direction?: string; amount?: number; target?: Target }, s?: AbortSignal) {
    return this.call("browser_scroll", { ...(opts.target ? targetArgs(opts.target) : {}), ...(opts.direction !== undefined ? { direction: opts.direction } : {}), ...(opts.amount !== undefined ? { amount: opts.amount } : {}) }, s);
  }
  waitFor(opts: { selector?: string; text?: string; timeoutMs: number }, s?: AbortSignal) {
    // Upstream truncates fractional seconds, so send rounded-up integer seconds.
    return this.call(opts.selector !== undefined ? "browser_wait_for" : "browser_wait_for_text", { ...(opts.selector !== undefined ? { selector: opts.selector } : { text: opts.text }), timeout: Math.max(1, Math.ceil(opts.timeoutMs / 1000)) }, s, opts.timeoutMs + 5000);
  }
  async screenshot(opts: { width?: number; height?: number; fullPage?: boolean }, s?: AbortSignal) {
    if (opts.fullPage) throw new UnsupportedOperationError(this.name, "full-page screenshot", "chrome");
    const raw = await this.session.call("browser_screenshot", { ...(opts.width !== undefined ? { width: opts.width } : {}), ...(opts.height !== undefined ? { height: opts.height } : {}) }, { signal: s });
    const text = checkedText(raw, this.options.cwd);
    const image = raw.content.find(i => i.type === "image" && i.mimeType === "image/png");
    if (!image || image.type !== "image") throw new Error("Obscura screenshot did not return a PNG image.");
    const png = Buffer.from(image.data, "base64");
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString("ascii", 12, 16) !== "IHDR") throw new Error("Obscura screenshot returned an invalid PNG.");
    return { png, text };
  }
  async pdf(opts: Record<string, unknown>, s?: AbortSignal) {
    const mapping: Record<string, string> = { landscape: "landscape", printBackground: "print_background", scale: "scale", paperWidth: "paper_width", paperHeight: "paper_height", marginTop: "margin_top", marginBottom: "margin_bottom", marginLeft: "margin_left", marginRight: "margin_right" };
    const args = Object.fromEntries(Object.entries(opts).filter(([key, v]) => key in mapping && v !== undefined).map(([key, v]) => [mapping[key]!, v]));
    const raw = await this.session.call("browser_pdf", args, { signal: s });
    checkedText(raw, this.options.cwd);
    const item = raw.content.find(i => i.type === "resource" && i.resource.blob !== undefined && (i.resource.mimeType === "application/pdf" || i.resource.uri === "obscura://capture/current-page.pdf"));
    if (!item || item.type !== "resource" || item.resource.blob === undefined) throw new Error("Obscura PDF did not return an embedded PDF resource.");
    const bytes = Buffer.from(item.resource.blob, "base64");
    if (bytes.toString("ascii", 0, 4) !== "%PDF") throw new Error("Obscura PDF returned an invalid PDF.");
    return bytes;
  }
  evaluate(expression: string, s?: AbortSignal) { return this.call("browser_evaluate", { expression }, s, this.options.config.evaluateTimeoutMs); }
  markdown(maxChars: number, s?: AbortSignal) { return this.call("browser_markdown", { max_chars: maxChars }, s); }
  links(limit?: number, internalOnly?: boolean, s?: AbortSignal) { return this.call("browser_links", { ...(limit !== undefined ? { limit } : {}), ...(internalOnly !== undefined ? { internal_only: internalOnly } : {}) }, s); }
  search(opts: { query: string; caseSensitive?: boolean; limit?: number; contextChars?: number }, s?: AbortSignal) {
    return this.call("browser_search", { query: opts.query, ...(opts.caseSensitive !== undefined ? { case_sensitive: opts.caseSensitive } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}), ...(opts.contextChars !== undefined ? { context_chars: opts.contextChars } : {}) }, s);
  }
  extract(schema: object, s?: AbortSignal) { return this.call("browser_extract", { schema }, s); }
  forms(s?: AbortSignal) { return this.call("browser_detect_forms", {}, s); }
  consoleMessages(s?: AbortSignal) { return this.call("browser_console_messages", {}, s); }
  networkRequests(s?: AbortSignal) { return this.call("browser_network_requests", {}, s); }
  tabs(action: TabAction, opts: { url?: string; tabId?: string }, s?: AbortSignal) {
    const names: Record<TabAction, string> = { list: "browser_tab_list", new: "browser_tab_new", switch: "browser_tab_switch", close: "browser_tab_close", back: "browser_back", forward: "browser_forward", reload: "browser_reload" };
    return this.call(names[action], { ...(opts.url !== undefined ? { url: opts.url } : {}), ...(opts.tabId !== undefined ? { tab_id: opts.tabId } : {}) }, s);
  }
  cookies(domain?: string, s?: AbortSignal) { return this.call("browser_get_cookies", domain !== undefined ? { domain } : {}, s); }
  setCookie(c: Cookie, s?: AbortSignal) {
    const { httpOnly, ...rest } = c;
    return this.call("browser_set_cookie", { ...rest, ...(httpOnly !== undefined ? { http_only: httpOnly } : {}) }, s);
  }
  clearCookies(s?: AbortSignal) { return this.call("browser_clear_cookies", {}, s); }
  async storageState(s?: AbortSignal): Promise<unknown> { return JSON.parse(await this.call("browser_storage_state", {}, s)); }
  /** Upstream restores cookies only; state.ts handles origin storage through evaluate. */
  setStorageState(state: unknown, s?: AbortSignal) { return this.call("browser_set_storage_state", { state }, s); }
  async hover(_t: Target, _s?: AbortSignal): Promise<string> { throw new UnsupportedOperationError("obscura", "hover", "chrome"); }
  async upload(_t: Target, _paths: string[], _s?: AbortSignal): Promise<string> { throw new UnsupportedOperationError("obscura", "upload", "chrome"); }
  async dialog(_action: "accept" | "dismiss", _promptText?: string, _s?: AbortSignal): Promise<string> { throw new UnsupportedOperationError("obscura", "dialog", "chrome"); }
  async emulate(_opts: import("../engine.js").EmulateOptions, _s?: AbortSignal): Promise<string> { throw new UnsupportedOperationError("obscura", "emulate", "chrome"); }
  async perf(_opts: import("../engine.js").PerfOptions, _s?: AbortSignal): Promise<string> { throw new UnsupportedOperationError("obscura", "performance", "chrome"); }
  async networkRequest(_idOrUrl: string, _s?: AbortSignal): Promise<string> { throw new UnsupportedOperationError("obscura", "network detail", "chrome"); }
  async closeAll(s?: AbortSignal) { await this.call("browser_close", {}, s); }
  restart() {
    this.session.configure({ args: buildObscuraArgs(this.options.config), defaultDeadlineMs: this.options.config.timeoutMs,
      deadlines: { browser_evaluate: this.options.config.evaluateTimeoutMs }, idleMs: this.options.config.idleMs });
    return this.session.restart();
  }
  stop() { return this.session.stop(); }
  status() { const state = this.session.status(); return { ...state, detail: `${state.binary ?? "unresolved"} (${state.source ?? "unknown"})` }; }
}
