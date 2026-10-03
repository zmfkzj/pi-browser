import type { ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserConfig } from "../config.js";
import { UnsupportedOperationError, type BrowserEngine, type Cookie, type EmulateOptions, type EngineCapabilities, type PageElement, type PageSummary, type PerfOptions, type TabAction, type Target } from "../engine.js";
import type { Availability } from "../manager.js";
import { McpStdioClient, type McpToolResult } from "../mcp-client.js";
import { contentText } from "../page.js";

const require = createRequire(import.meta.url);
export function resolveChromeServer(): string {
  const path = require.resolve("chrome-devtools-mcp/package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  return join(dirname(path), pkg.bin["chrome-devtools-mcp"]);
}
export interface ChromeAvailabilityOptions {
  exists?: (path: string) => boolean;
  resolveServer?: () => string;
  platform?: NodeJS.Platform;
  pathDirs?: string[];
}
export interface ChromeAvailability extends Availability { executablePath?: string; serverBin?: string; detail?: string }
function executable(path: string): boolean { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } }
export function chromeAvailability(config: BrowserConfig, env: NodeJS.ProcessEnv = process.env, overrides: ChromeAvailabilityOptions = {}): ChromeAvailability {
  if (!config.chrome.enabled) return { ok: false, reason: "chrome engine disabled in config" };
  let serverBin: string;
  try { serverBin = (overrides.resolveServer ?? resolveChromeServer)(); }
  catch { return { ok: false, reason: "chrome-devtools-mcp not found; run npm install in the pi-browser package" }; }
  const exists = overrides.exists ?? executable;
  const missing = () => ({ ok: false, reason: "Google Chrome not found; install Chrome or set chrome.executablePath / chrome.browserUrl" });
  if (config.chrome.executablePath) return exists(config.chrome.executablePath) ? { ok: true, executablePath: config.chrome.executablePath, serverBin } : missing();
  if (config.chrome.browserUrl) return { ok: true, serverBin, detail: `attached to ${config.chrome.browserUrl}` };
  const platform = overrides.platform ?? process.platform;
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  const candidates = (overrides.pathDirs ?? (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter)).filter(Boolean).flatMap(dir => names.map(name => join(dir, name + (platform === "win32" ? ".exe" : ""))));
  if (platform === "darwin") candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  else if (platform === "win32") for (const dir of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) if (dir) candidates.push(join(dir, "Google", "Chrome", "Application", "chrome.exe"));
  else candidates.push("/opt/google/chrome/chrome");
  const executablePath = candidates.find(exists);
  return executablePath ? { ok: true, executablePath, serverBin } : missing();
}
export function buildChromeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "TMPDIR", "TMP", "TEMP"];
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && (keys.includes(k) || /^(CHROME_|PUPPETEER_)/.test(k))));
}
export function buildChromeArgs(config: BrowserConfig, env: NodeJS.ProcessEnv = process.env, detectedExecutablePath?: string): string[] {
  const c = config.chrome, args: string[] = [];
  const executablePath = c.executablePath ?? (!c.browserUrl ? detectedExecutablePath : undefined);
  if (c.headless === true || (c.headless === "auto" && !env.DISPLAY && !env.WAYLAND_DISPLAY)) args.push("--headless");
  if (c.isolated) args.push("--isolated");
  if (executablePath) args.push("--executablePath", executablePath);
  if (c.browserUrl) args.push("--browserUrl", c.browserUrl);
  if (!executablePath && !c.browserUrl) args.push("--channel", c.channel);
  if (c.viewport) args.push("--viewport", c.viewport);
  // Keep this local adapter offline: upstream defaults otherwise send usage statistics and CrUX queries.
  args.push("--no-usage-statistics", "--no-performance-crux");
  return [...args, ...c.args];
}
export const CHROME_CAPABILITIES: EngineCapabilities = {
  selectors: true, pdf: false, storageState: false, cookies: false, markdown: true, search: true, schemaExtract: true, forms: true,
  fullPageScreenshot: true, hover: true, upload: true, dialog: true, emulate: true, performance: true, networkDetail: true,
};
const roles = new Set("button link textbox searchbox combobox listbox option checkbox radio switch slider spinbutton menuitem tab".split(" "));
export function parseChromeSnapshot(raw: string): PageElement[] {
  return raw.split("\n").flatMap(line => {
    const m = /^\s*uid=(\S+)\s+(\S+)(?:\s+("(?:[^"\\]|\\.)*"))?/.exec(line);
    if (!m || (!roles.has(m[2]!) && !/\b(focusable|clickable)\b/.test(line))) return [];
    // PageSummary labels are formatted literals, matching obscura's existing section renderer.
    return [{ ref: m[1]!, kind: m[2]!, label: m[3] ?? '""' }];
  });
}
export function decodeChromeEvaluation(raw: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(raw)?.[1];
  const payload = fenced ?? raw.replace(/^Script ran on page and returned:\s*/, "").trim();
  try { return JSON.parse(payload); } catch { throw new Error(`Chrome evaluation returned invalid JSON: ${raw}`); }
}
export function describeChromeError(message: string): string {
  return /(?:unknown uid|uid .*not found|stale.*(?:uid|snapshot)|not.*found.*snapshot)/i.test(message)
    ? `${message}\nRefs change after every action or navigation; call browser_snapshot and use a ref from the latest result.` : message;
}
function checked(result: McpToolResult): string {
  const text = contentText(result.content);
  if (result.isError || /^Error:/m.test(text)) throw new Error(describeChromeError(text || "Chrome reported a tool error"));
  return text;
}
export interface ChromeEngineOptions {
  config: BrowserConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  launch?: () => ChildProcess;
  command?: string;
  args?: string[];
  serverBin?: string;
  pathDirs?: string[];
  onStateChange?: (state: { running: boolean; pid: number | undefined }) => void;
}
export class ChromeEngine implements BrowserEngine {
  readonly name = "chrome" as const;
  readonly capabilities = { ...CHROME_CAPABILITIES };
  private client?: McpStdioClient;
  private pageId?: number;
  private idleTimer?: NodeJS.Timeout;
  private activeCalls = 0;
  private insightSetId?: string;
  constructor(private readonly options: ChromeEngineOptions) {}
  private flags() {
    const env = this.options.env ?? process.env;
    const detected = chromeAvailability(this.options.config, env, { pathDirs: this.options.pathDirs }).executablePath;
    return [...buildChromeArgs(this.options.config, env, detected), "--workspace", this.options.cwd ?? process.cwd()];
  }
  private getClient(): McpStdioClient {
    if (!this.client) {
      const bin = this.options.serverBin ?? resolveChromeServer();
      this.client = new McpStdioClient({ label: "chrome", command: this.options.command ?? process.execPath,
        args: this.options.args ?? [bin, ...this.flags()], env: buildChromeEnv(this.options.env ?? process.env),
        detached: !this.options.config.chrome.browserUrl,
        launch: this.options.launch, defaultDeadlineMs: this.options.config.timeoutMs,
        onStateChange: state => { if (!state.running) { this.pageId = undefined; this.insightSetId = undefined; } this.options.onStateChange?.(state); },
      });
    }
    return this.client;
  }
  private async raw(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal, deadlineMs?: number): Promise<McpToolResult> {
    clearTimeout(this.idleTimer); this.activeCalls++;
    try { return await this.getClient().callTool(name, args, { signal, deadlineMs }); }
    finally { if (--this.activeCalls === 0) { this.idleTimer = setTimeout(() => { void this.stop(); }, this.options.config.idleMs); this.idleTimer.unref(); } }
  }
  private async pages(signal?: AbortSignal) { return checked(await this.raw("list_pages", {}, signal)); }
  private rememberPage(text: string) { this.pageId = Number(/^([0-9]+):.*\[selected\]/m.exec(text)?.[1] ?? /^([0-9]+):/m.exec(text)?.[1]) || undefined; }
  private async currentPage(signal?: AbortSignal): Promise<number> {
    if (!this.client?.isRunning) this.pageId = undefined;
    if (this.pageId === undefined) { this.rememberPage(await this.pages(signal)); if (this.pageId === undefined) this.rememberPage(checked(await this.raw("new_page", { url: "about:blank" }, signal))); }
    if (this.pageId === undefined) throw new Error("Chrome returned no page id.");
    return this.pageId;
  }
  private async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal, deadlineMs?: number): Promise<string> {
    return checked(await this.raw(name, { pageId: await this.currentPage(signal), ...args }, signal, deadlineMs));
  }
  private uid(ref: string) { if (!/^\d+(?:_\d+)+$/.test(ref)) throw new Error("Chrome ref must be a snapshot uid (for example 1_12); call browser_snapshot."); return ref; }
  private async script(fn: string, signal?: AbortSignal, args?: string[]): Promise<unknown> {
    return decodeChromeEvaluation(await this.call("evaluate_script", { function: fn, ...(args ? { args } : {}) }, signal, this.options.config.evaluateTimeoutMs));
  }
  private expression(expression: string, signal?: AbortSignal) { return this.script(`() => { return (${expression}); }`, signal); }
  private async onTarget(t: Target, body: string, signal?: AbortSignal): Promise<unknown> {
    if ("ref" in t) return this.script(`(el) => { ${body} }`, signal, [this.uid(t.ref)]);
    if (!t.selector.trim()) throw new Error("selector must be a non-empty string.");
    return this.script(`() => { const el = document.querySelector(${JSON.stringify(t.selector)}); if (!el) throw new Error('Element not found: ' + ${JSON.stringify(t.selector)}); ${body} }`, signal);
  }
  private async targetUid(t: Target, signal?: AbortSignal): Promise<string> {
    if ("ref" in t) return this.uid(t.ref);
    const snapshot = await this.call("take_snapshot", {}, signal);
    const refs = parseChromeSnapshot(snapshot).map(e => e.ref);
    const index = await this.script(`(...els) => els.findIndex(el => el === document.querySelector(${JSON.stringify(t.selector)}))`, signal, refs);
    if (typeof index !== "number" || index < 0 || !refs[index]) throw new Error(`Element not found in Chrome snapshot: ${t.selector}; prefer refs on chrome.`);
    return refs[index]!;
  }
  async navigate(url: string, opts: { waitUntil?: string; signal?: AbortSignal }) {
    const text = await this.call("navigate_page", { url, timeout: this.options.config.timeoutMs }, opts.signal);
    if (/^Unable to navigate in the selected page:/m.test(text)) throw new Error(text);
    const title = await this.expression("document.title", opts.signal);
    return `Navigated (chrome) to ${url} — ${JSON.stringify(title)}`;
  }
  async summarize(opts: Parameters<BrowserEngine["summarize"]>[0]): Promise<PageSummary> {
    const raw = opts.includeInteractive === false ? undefined : await this.call("take_snapshot", {}, opts.signal);
    const page = await this.expression(`({ url: location.href, title: document.title, text: (document.body?.innerText ?? '').slice(0, ${opts.maxChars}) })`, opts.signal) as PageSummary;
    return { ...page, ...(raw !== undefined ? { raw, elements: parseChromeSnapshot(raw).slice(0, opts.limit ?? 60) } : {}) };
  }
  async click(t: Target, s?: AbortSignal) {
    if ("ref" in t) return this.call("click", { uid: this.uid(t.ref) }, s);
    await this.onTarget(t, "el.scrollIntoView(); el.click(); return true;", s);
    return "Clicked (chrome) (selector click emulated via script; prefer refs on chrome)";
  }
  async fill(t: Target, value: string, s?: AbortSignal) {
    if ("ref" in t) return this.call("fill", { uid: this.uid(t.ref), value }, s);
    await this.onTarget(t, `el.scrollIntoView(); el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* Not all input types support a text caret. */ } return true;`, s);
    return "Filled (chrome) (selector fill emulated via script; prefer refs on chrome)";
  }
  async fillForm(fields: Array<Partial<Target> & { value?: string; type?: string }>, submit?: Target, s?: AbortSignal) {
    const elements: { uid: string; value: string }[] = [];
    const headlines: string[] = [];
    for (const f of fields) {
      const t: Target = "ref" in f && f.ref !== undefined ? { ref: f.ref } : { selector: "selector" in f ? f.selector ?? "" : "" };
      const value = f.type === "check" ? "true" : f.type === "uncheck" ? "false" : f.value ?? "";
      if ("ref" in t && f.type !== "select") elements.push({ uid: this.uid(t.ref), value });
      else if (f.type === "select") headlines.push(await this.select(t, value, s));
      else if (f.type === "check" || f.type === "uncheck") { await this.onTarget(t, `el.scrollIntoView(); el.focus(); el.checked = ${f.type === "check"}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;`, s); headlines.push("Checkbox filled (selector emulated via script; prefer refs on chrome)"); }
      else headlines.push(await this.fill(t, value, s));
    }
    if (elements.length) headlines.unshift(await this.call("fill_form", { elements }, s));
    if (submit) headlines.push(await this.click(submit, s));
    return headlines.join("\n");
  }
  async type(t: Target, text: string, pressEnter: boolean, s?: AbortSignal) { let result = `${await this.fill(t, text, s)}\nChrome type is implemented as fill${pressEnter ? ' + Enter' : ''}.`; if (pressEnter) result += `\n${await this.pressKey("Enter", t, s)}`; return result; }
  async pressKey(key: string, t?: Target, s?: AbortSignal) { if (t) await this.onTarget(t, "el.scrollIntoView(); el.focus(); return true;", s); return this.call("press_key", { key }, s); }
  async select(t: Target, value: string, s?: AbortSignal) {
    // Upstream fill selects by visible label only; script preserves obscura's option-value semantics.
    await this.onTarget(t, `el.scrollIntoView(); el.focus(); const value = ${JSON.stringify(value)}; const option = Array.from(el.options).find(o => o.value === value || o.label === value || o.textContent === value); if (!option) throw new Error('Option not found: ' + value); el.value = option.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value;`, s);
    return "Selected (chrome) (select emulated via script; prefer refs on chrome)";
  }
  async scroll(opts: { direction?: string; amount?: number; target?: Target }, s?: AbortSignal) {
    const d = opts.direction ?? "down", a = opts.amount ?? 600;
    const body = d === "top" ? "el.scrollTo(0,0);" : d === "bottom" ? "el.scrollTo(0,el.scrollHeight ?? document.body.scrollHeight);" : `el.scrollBy(${d === "left" ? -a : d === "right" ? a : 0},${d === "up" ? -a : d === "down" ? a : 0});`;
    if (opts.target) await this.onTarget(opts.target, `el.scrollIntoView(); ${body} return true;`, s);
    else await this.script(`() => { const el = window; ${body} return true; }`, s);
    return "Scrolled (chrome) (emulated via script)";
  }
  async waitFor(opts: { selector?: string; text?: string; timeoutMs: number }, s?: AbortSignal) {
    if (opts.text !== undefined) return this.call("wait_for", { text: [opts.text], timeout: opts.timeoutMs }, s, opts.timeoutMs + 5000);
    const end = Date.now() + opts.timeoutMs;
    do { s?.throwIfAborted(); if (await this.expression(`!!document.querySelector(${JSON.stringify(opts.selector)})`, s)) return `Found selector ${opts.selector} (chrome)`; await sleep(Math.min(250, Math.max(0, end - Date.now())), undefined, { signal: s }); } while (Date.now() < end);
    throw new Error(`Timed out after ${opts.timeoutMs} ms waiting for selector ${opts.selector}.`);
  }
  async screenshot(opts: { width?: number; height?: number; fullPage?: boolean }, s?: AbortSignal) {
    if (opts.width !== undefined || opts.height !== undefined) { const viewport = await this.expression("({width:innerWidth,height:innerHeight})", s) as { width: number; height: number }; await this.call("resize_page", { width: opts.width ?? viewport.width, height: opts.height ?? viewport.height }, s); }
    const result = await this.raw("take_screenshot", { pageId: await this.currentPage(s), format: "png", fullPage: opts.fullPage ?? false }, s);
    const text = checked(result), image = result.content.find(c => c.type === "image" && c.mimeType === "image/png");
    if (!image || image.type !== "image") throw new Error("Chrome screenshot did not return a PNG image.");
    const png = Buffer.from(image.data, "base64");
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.toString("ascii",12,16) !== "IHDR") throw new Error("Chrome screenshot returned an invalid PNG.");
    return { png, text };
  }
  private unsupported(operation: string): never { const error = new UnsupportedOperationError("chrome", operation, "obscura"); error.message += " Chrome keeps its own persistent profile (chrome.isolated=false), so logins survive restarts."; throw error; }
  async pdf(_opts: Record<string, unknown>, _s?: AbortSignal): Promise<Buffer> { return this.unsupported("pdf"); }
  async evaluate(expression: string, s?: AbortSignal) { const value = await this.expression(expression, s); return typeof value === "string" ? value : JSON.stringify(value); }
  async markdown(maxChars: number, s?: AbortSignal) {
    const text = await this.script(`() => { const render = el => { const tag = el.tagName.toLowerCase(); const text = (el.innerText ?? el.textContent ?? '').trim(); if (/^h[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + text; if (tag === 'li') return '- ' + text; if (tag === 'a') return '[' + text + '](' + el.href + ')'; if (tag === 'pre') return '\u0060\u0060\u0060\\n' + text + '\\n\u0060\u0060\u0060'; if (tag === 'p') return Array.from(el.childNodes).map(n => n.nodeType === 1 && n.tagName.toLowerCase() === 'a' ? render(n) : n.textContent).join('').trim(); return text; }; const nodes = Array.from(document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,a,pre')).filter(el => !el.parentElement?.closest('p,li,pre')); return (nodes.length ? nodes.map(render).join('\\n\\n') : document.body.innerText).slice(0, ${maxChars}); }`, s);
    return String(text);
  }
  async links(limit = 100, internalOnly = false, s?: AbortSignal) { return JSON.stringify(await this.script(`() => Array.from(document.querySelectorAll('a[href]')).filter(a => ${internalOnly} ? new URL(a.href).origin === location.origin : true).slice(0,${limit}).map(a => ({text:a.innerText.trim(),href:a.href}))`, s), null, 2); }
  async search(opts: { query: string; caseSensitive?: boolean; limit?: number; contextChars?: number }, s?: AbortSignal) {
    return JSON.stringify(await this.script(`() => { const opts = ${JSON.stringify(opts)}; const text = document.body.innerText; const haystack = opts.caseSensitive ? text : text.toLowerCase(); const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase(); const results = []; let index = 0; while (needle && results.length < (opts.limit ?? 20) && (index = haystack.indexOf(needle,index)) !== -1) { results.push({index, context:text.slice(Math.max(0,index-(opts.contextChars ?? 100)),index+needle.length+(opts.contextChars ?? 100))}); index += needle.length; } return results; }`, s), null, 2);
  }
  async extract(schema: object, s?: AbortSignal) { return JSON.stringify(await this.script(`() => { const result = {}; for (const [field, spec] of Object.entries(${JSON.stringify(schema)})) { const at = spec.lastIndexOf('@'); const selector = at < 0 ? spec : spec.slice(0,at); const attr = at < 0 ? null : spec.slice(at+1); const read = el => attr ? el.getAttribute(attr) : (el.innerText ?? el.textContent ?? '').trim(); const all = Array.from(document.querySelectorAll(selector)); result[field.replace(/\\[\\]$/, '')] = field.endsWith('[]') ? all.map(read) : all.length ? read(all[0]) : null; } return result; }`, s), null, 2); }
  async forms(s?: AbortSignal) { return JSON.stringify(await this.script(`() => Array.from(document.forms).map(form => ({id:form.id, name:form.name, action:form.action, method:form.method, fields:Array.from(form.elements).map(el => ({name:el.name, type:el.type, label:Array.from(el.labels ?? []).map(l => l.innerText.trim()).join(' ') || el.getAttribute('aria-label') || el.placeholder || ''}))}))`, s), null, 2); }
  consoleMessages(s?: AbortSignal) { return this.call("list_console_messages", {}, s); }
  networkRequests(s?: AbortSignal) { return this.call("list_network_requests", {}, s); }
  async networkRequest(idOrUrl: string, s?: AbortSignal) {
    let reqid = /^(?:reqid=)?\d+$/.test(idOrUrl) ? Number(idOrUrl.replace("reqid=", "")) : undefined;
    if (reqid === undefined) {
      const requests = [...(await this.networkRequests(s)).matchAll(/^reqid=(\d+)\s+\S+\s+(\S+)\s/gm)];
      const match = requests.findLast(match => match[2] === idOrUrl);
      reqid = match ? Number(match[1]) : undefined;
    }
    if (reqid === undefined) throw new Error(`Network request not found: ${idOrUrl}; list network requests first.`);
    return this.call("get_network_request", { reqid }, s);
  }
  async tabs(action: TabAction, opts: { url?: string; tabId?: string }, s?: AbortSignal) {
    if (action === "list") return this.pages(s);
    if (["back", "forward", "reload"].includes(action)) return this.call("navigate_page", { type: action, timeout: this.options.config.timeoutMs }, s);
    if (action === "new") { const text = checked(await this.raw("new_page", { url: opts.url ?? "about:blank" }, s)); this.rememberPage(text); return text; }
    const id = opts.tabId === undefined ? await this.currentPage(s) : Number(opts.tabId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Chrome tabId must be a numeric page id from browser_tabs list.");
    const text = checked(await this.raw(action === "switch" ? "select_page" : "close_page", { pageId: id }, s)); this.rememberPage(text); return text;
  }
  async cookies(_domain?: string, _s?: AbortSignal): Promise<string> { return this.unsupported("cookies"); }
  async setCookie(_cookie: Cookie, _s?: AbortSignal): Promise<string> { return this.unsupported("setCookie"); }
  async clearCookies(_s?: AbortSignal): Promise<string> { return this.unsupported("clearCookies"); }
  async storageState(_s?: AbortSignal): Promise<unknown> { return this.unsupported("storageState"); }
  async setStorageState(_state: unknown, _s?: AbortSignal) { return "cookies skipped on chrome (not supported); storage entries are applied by script"; }
  hover(t: Target, s?: AbortSignal) { return this.targetUid(t, s).then(uid => this.call("hover", { uid }, s)); }
  async upload(t: Target, paths: string[], s?: AbortSignal) {
    if (!paths.length) throw new Error("paths must be non-empty.");
    const filePaths = paths.map(path => { if (!path.trim()) throw new Error("Upload path must be non-empty."); const full = resolve(this.options.cwd ?? process.cwd(), path); if (!statSync(full).isFile()) throw new Error(`Upload path is not a file: ${full}`); return full; });
    return this.call("upload_file", { uid: await this.targetUid(t, s), filePaths }, s);
  }
  dialog(action: "accept" | "dismiss", promptText?: string, s?: AbortSignal) { return this.call("handle_dialog", { action, ...(promptText !== undefined ? { promptText } : {}) }, s); }
  emulate(opts: EmulateOptions, s?: AbortSignal) { return this.call("emulate", { ...(opts.cpu !== undefined ? { cpuThrottlingRate: opts.cpu } : {}), ...(opts.network ? { networkConditions: opts.network } : {}), ...(opts.viewport ? { viewport: opts.viewport } : {}) }, s); }
  async perf(opts: PerfOptions, s?: AbortSignal) {
    if (opts.action === "insight") { if (!opts.insightName) throw new Error("insight action requires insightName."); const id = opts.insightSetId ?? this.insightSetId; if (!id) throw new Error("Stop a performance trace first to obtain an insight set."); return this.call("performance_analyze_insight", { insightName: opts.insightName, insightSetId: id }, s); }
    if (opts.action === "start") this.insightSetId = undefined;
    const text = await this.call(opts.action === "start" ? "performance_start_trace" : "performance_stop_trace", opts.action === "start" ? { reload: opts.reload ?? false, autoStop: opts.autoStop ?? false } : {}, s);
    this.insightSetId = /insight set id:\s*(\S+)/i.exec(text)?.[1] ?? this.insightSetId; return text;
  }
  async closeAll(s?: AbortSignal) {
    const ids = [...(await this.pages(s)).matchAll(/^(\d+):/gm)].map(m => Number(m[1]));
    // Chrome cannot close its last page. Create a neutral page and close ALL old task tabs,
    // rather than retaining an old tab's history behind about:blank.
    this.rememberPage(checked(await this.raw("new_page", { url: "about:blank" }, s)));
    for (const id of ids) checked(await this.raw("close_page", { pageId: id }, s));
  }
  async restart() { await this.stop(); await this.getClient().initialize(); }
  async stop() { clearTimeout(this.idleTimer); const client = this.client; this.client = undefined; this.pageId = undefined; this.insightSetId = undefined; await client?.close(); }
  status() { const c = this.options.config.chrome; const availability = chromeAvailability(this.options.config, this.options.env ?? process.env, { pathDirs: this.options.pathDirs }); return { running: this.client?.isRunning ?? false, pid: this.client?.pid, binary: c.executablePath ?? availability.executablePath, detail: `${c.browserUrl ? `attached to ${c.browserUrl}` : `${this.flags().includes('--headless') ? 'headless' : 'headed'} ${c.executablePath ?? availability.executablePath ?? c.channel}`} | flags: ${this.flags().join(' ')}${this.client?.stderrTail() ? ` | stderr: ${this.client.stderrTail()}` : ''}` }; }
}
