import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortableSleep, actionResult, artifactPath, httpUrl, optionalTarget, storageState, targetArgs, writeArtifact } from "../actions.js";
import type { BrowserConfig } from "../config.js";
import { mcpContentToToolContent, type McpContent } from "../output.js";
import { UnsupportedOperationError, type BrowserEngine } from "../engine.js";
import type { EngineManager } from "../manager.js";
import { toolExposure, deferredToolGuideline } from "../exposure.js";
import { applyPendingStorage, restoreStorageState } from "../state.js";

const string = () => Type.String({ minLength: 1 });
const integer = (minimum = 1, maximum = 2147483647) => Type.Integer({ minimum, maximum });
const target = { ref: Type.Optional(string()), selector: Type.Optional(string()) };
const snapshot = { snapshot: Type.Optional(Type.Boolean()) };
const literals = <T extends string>(...values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
interface ToolOutput { text?: string; content?: McpContent[]; details?: Record<string, unknown> }

export function registerInteractionTools(pi: ExtensionAPI, options: {
  config: () => BrowserConfig;
  getManager: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<EngineManager>;
  now: () => number;
  guideline: string;
}): string[] {
  const names: string[] = [];
  const config = options.config;
  function register<T extends TSchema>(name: string, description: string, parameters: T, readOnly: boolean,
    run: (params: Static<T>, browser: BrowserEngine, signal: AbortSignal | undefined, ctx: ExtensionContext) => Promise<ToolOutput>) {
    names.push(name);
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      exposure: toolExposure(name, config().exposure), executionMode: "sequential", promptGuidelines: [options.guideline, ...(toolExposure(name, config().exposure) === "direct" && deferredToolGuideline(config().exposure) ? [deferredToolGuideline(config().exposure)] : [])],
      promptSnippet: description, annotations: { openWorldHint: true, readOnlyHint: readOnly },
      async execute(_id, params, signal, _update, ctx) {
        const start = options.now();
        const manager = await options.getManager(ctx, signal);
        // Tabs new/list can run before the first navigation. Other tools require an active engine.
        const browser = name === "browser_tabs" ? manager.active() : manager.require();
        const output = await run(params, browser as BrowserEngine, signal, ctx);
        const bounded = await mcpContentToToolContent(output.content ?? [{ type: "text", text: output.text ?? "" }], { maxChars: config().maxOutputChars, label: name });
        return { content: bounded.content, details: { tool: name, durationMs: Math.max(0, options.now() - start), ...(bounded.spilledPath ? { spilledPath: bounded.spilledPath } : {}), ...output.details } };
      },
    });
  }
  async function action(browser: BrowserEngine, headline: Promise<string>, params: { snapshot?: boolean }, signal?: AbortSignal): Promise<ToolOutput> {
    const text = await headline;
    // Snapshot/evaluate while a native dialog is open would auto-handle it upstream.
    if (browser.name === "chrome" && /# Open dialog|opened a dialog/i.test(text)) return { text: `${text}\nUse browser_dialog before requesting a snapshot.` };
    return { text: await actionResult(browser, text, params, config(), signal) };
  }
  function supported(browser: BrowserEngine, capability: keyof BrowserEngine["capabilities"], operation: string) {
    if (!browser.capabilities[capability]) {
      const error = new UnsupportedOperationError(browser.name, operation, browser.name === "chrome" ? "obscura" : "chrome");
      if (browser.name === "chrome" && (capability === "cookies" || capability === "storageState")) error.message += " Chrome keeps its own persistent profile (chrome.isolated=false), so logins survive restarts.";
      throw error;
    }
  }
  register("browser_click", "Click an element by its current ref or CSS selector and return a fresh page summary unless snapshot is false.",
    Type.Object({ ...target, ...snapshot }), false, async (params, browser, signal, ctx) => action(browser, browser.click(targetArgs(params, browser), signal), params, signal));

  register("browser_fill", "Fill one target with value, or fill a non-empty fields array with an optional submit target. Form results include any per-field errors verbatim, followed by a summary unless snapshot is false.",
    Type.Object({ ...target, value: Type.Optional(Type.String()), fields: Type.Optional(Type.Array(Type.Object({ ...target, value: Type.Optional(Type.String()), type: Type.Optional(literals("text", "check", "uncheck", "select")) }), { minItems: 1 })), submit: Type.Optional(Type.Object(target)), ...snapshot }), false,
    async (params, browser, signal, ctx) => {
      const single = params.ref !== undefined || params.selector !== undefined || params.value !== undefined;
      const form = params.fields !== undefined;
      if (single === form) throw new Error("Provide exactly one fill mode: ref or selector with value, or a non-empty fields array.");
      if (form) {
        if (!params.fields!.length) throw new Error("fields must be non-empty.");
        const fields = params.fields!.map((field) => ({ ...targetArgs(field, browser), ...(field.value !== undefined ? { value: field.value } : {}), ...(field.type !== undefined ? { type: field.type } : {}) }));
        const submit = params.submit ? targetArgs(params.submit, browser) : undefined;
        supported(browser, "forms", "form fill");
        return action(browser, browser.fillForm(fields, submit, signal), params, signal);
      }
      const selected = targetArgs(params, browser);
      if (params.value === undefined) throw new Error("Single fill mode requires value.");
      if (params.submit !== undefined) throw new Error("submit is only supported in form fill mode.");
      return action(browser, browser.fill(selected, params.value, signal), params, signal);
    });

  register("browser_type", "Type text into a ref or selector, optionally press Enter, and return a page summary unless snapshot is false. On chrome, type is implemented as fill + Enter (replaces existing text)." ,
    Type.Object({ ...target, text: Type.String(), pressEnter: Type.Optional(Type.Boolean()), ...snapshot }), false, async (params, browser, signal, ctx) => {
      const selected = targetArgs(params, browser);
      return action(browser, browser.type(selected, params.text, params.pressEnter ?? false, signal), params, signal);
    });

  register("browser_press_key", "Press a key on an optional ref or selector and return a page summary unless snapshot is false.",
    Type.Object({ key: string(), ...target, ...snapshot }), false, async (params, browser, signal, ctx) => {
      const selected = optionalTarget(params, browser);
      return action(browser, browser.pressKey(params.key, selected, signal), params, signal);
    });

  register("browser_select", "Select an option value in a ref or selector and return a page summary unless snapshot is false.",
    Type.Object({ ...target, value: Type.String(), ...snapshot }), false, async (params, browser, signal, ctx) => action(browser, browser.select(targetArgs(params, browser), params.value, signal), params, signal));

  register("browser_scroll", "Scroll the page or an optional target and return a page summary unless snapshot is false.",
    Type.Object({ direction: Type.Optional(literals("top", "bottom", "up", "down", "left", "right")), amount: Type.Optional(Type.Number({ minimum: 0 })), ...target, ...snapshot }), false,
    async (params, browser, signal, ctx) => action(browser, browser.scroll({ target: optionalTarget(params, browser), direction: params.direction, amount: params.amount }, signal), params, signal));

  register("browser_wait", "Wait for exactly one selector, text, or a 1–30000 ms delay. No summary is returned unless snapshot is true.",
    Type.Object({ selector: Type.Optional(string()), text: Type.Optional(string()), ms: Type.Optional(integer(1, 30000)), timeoutMs: Type.Optional(integer(1, 2147478647)), ...snapshot }), true,
    async (params, browser, signal, ctx) => {
      if ([params.selector, params.text, params.ms].filter((value) => value !== undefined).length !== 1) throw new Error("Provide exactly one of selector, text or ms.");
      let headline: string;
      if (params.ms !== undefined) {
        await abortableSleep(params.ms, signal);
        headline = `Waited ${params.ms} ms.`;
      } else {
        const timeoutMs = params.timeoutMs ?? 30000;
        if (params.selector !== undefined) targetArgs({ selector: params.selector }, browser);
        headline = await browser.waitFor({ selector: params.selector, text: params.text, timeoutMs }, signal);
      }
      return { text: await actionResult(browser, headline, { snapshot: params.snapshot ?? false }, config(), signal) };
    });

  register("browser_screenshot", "Save a PNG screenshot and return its path, actual pixel dimensions, and one image block. fullPage is supported on chrome only.",
    Type.Object({ width: Type.Optional(integer(1, 32768)), height: Type.Optional(integer(1, 32768)), fullPage: Type.Optional(Type.Boolean()), path: Type.Optional(string()) }), true,
    async (params, browser, signal, ctx) => {
      const { png: bytes } = await browser.screenshot({ width: params.width, height: params.height, fullPage: params.fullPage }, signal);
      const image: McpContent = { type: "image", mimeType: "image/png", data: bytes.toString("base64") };
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      const path = await artifactPath(config(), ctx.cwd, "screenshot", "png", params.path);
      await writeArtifact(path, bytes);
      return { content: [{ type: "text", text: `Screenshot saved to ${path} (${width}×${height} px, ${bytes.length} bytes)` }, image], details: { path, width, height, bytes: bytes.length } };
    });

  register("browser_pdf", "Save the current page as a PDF and return only its path and byte count.",
    Type.Object({ path: Type.Optional(string()), landscape: Type.Optional(Type.Boolean()), printBackground: Type.Optional(Type.Boolean()), scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 2 })), paperWidth: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 200 })), paperHeight: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 200 })), marginTop: Type.Optional(Type.Number({ minimum: 0 })), marginBottom: Type.Optional(Type.Number({ minimum: 0 })), marginLeft: Type.Optional(Type.Number({ minimum: 0 })), marginRight: Type.Optional(Type.Number({ minimum: 0 })) }), true,
    async (params, browser, signal, ctx) => {
      supported(browser, "pdf", "PDF");
      const { path: _path, ...opts } = params;
      const bytes = await browser.pdf(opts, signal);
      const path = await artifactPath(config(), ctx.cwd, "page", "pdf", params.path);
      await writeArtifact(path, bytes);
      return { text: `PDF saved to ${path} (${bytes.length} bytes)`, details: { path, bytes: bytes.length } };
    });

  register("browser_extract", "Read markdown, links, search results, schema data, forms, console messages, or network requests. Schema maps field names to CSS selectors: field[] produces an array and selector@attr reads an attribute.",
    Type.Object({ mode: literals("markdown", "links", "search", "schema", "forms", "console", "network"), maxChars: Type.Optional(integer()), limit: Type.Optional(integer()), internalOnly: Type.Optional(Type.Boolean()), query: Type.Optional(string()), caseSensitive: Type.Optional(Type.Boolean()), contextChars: Type.Optional(integer(0)), schema: Type.Optional(Type.Record(Type.String(), Type.String())) }), true,
    async (params, browser, signal, ctx) => {
      let text: string;
      switch (params.mode) {
        case "markdown": supported(browser, "markdown", "markdown"); text = await browser.markdown(params.maxChars ?? config().maxOutputChars, signal); break;
        case "links": text = await browser.links(params.limit, params.internalOnly, signal); break;
        case "search":
          if (!params.query?.trim()) throw new Error("Search mode requires query.");
          supported(browser, "search", "search");
          text = await browser.search({ query: params.query, caseSensitive: params.caseSensitive, limit: params.limit, contextChars: params.contextChars }, signal); break;
        case "schema":
          if (params.schema === undefined || params.schema === null || Array.isArray(params.schema)) throw new Error("Schema mode requires a schema object.");
          supported(browser, "schemaExtract", "schema extraction"); text = await browser.extract(params.schema, signal); break;
        case "forms": supported(browser, "forms", "forms"); text = await browser.forms(signal); break;
        case "console": text = await browser.consoleMessages(signal); break;
        case "network": text = await browser.networkRequests(signal); break;
        default: throw new Error("Unknown extract mode.");
      }
      return { text, details: { mode: params.mode } };
    });

  register("browser_tabs", "List, new, switch, close, back, forward, or reload tabs; actions except list/close return a summary unless snapshot is false. On obscura, inactive tabs keep their DOM but JavaScript state is suspended: timers, in-memory variables, and sessionStorage may be lost. Chrome page IDs are numeric strings from the listing.",
    Type.Object({ action: literals("list", "new", "switch", "close", "back", "forward", "reload"), url: Type.Optional(string()), tabId: Type.Optional(string()), engine: Type.Optional(literals("obscura", "chrome")), ...snapshot }), false,
    async (params, browser, signal, ctx) => {
      const manager = await options.getManager(ctx, signal);
      if (params.action === "list") return { text: await manager.listTabs(params.engine, signal), details: { action: params.action } };
      if (params.action === "new" && params.url !== undefined) httpUrl(params.url, "browser_tabs new");
      if (params.action === "switch" && !params.tabId?.trim()) throw new Error("Switch action requires tabId.");
      browser = params.action === "new" ? await manager.select({ engine: params.engine, url: params.url }) : params.engine ? manager.activate(params.engine) : manager.require();
      let headline = await browser.tabs(params.action, { url: params.url, tabId: params.tabId }, signal);
      if (params.action !== "close") {
        const applied = await applyPendingStorage(browser, manager.pendingFor(browser.name), { signal });
        if (applied) headline += `\n${applied}`;
      }
      return { text: params.action === "close" ? headline : await actionResult(browser, headline, params, config(), signal), details: { action: params.action } };
    });

  register("browser_state", "Read or modify cookies, export/import JSON storage state, or reset the browser (reset loses all tabs and restarts the process). Cookies/export require obscura. Chrome imports skip cookies and apply origin storage by script; reset retains its persistent profile. Exports include only the active page's origin storage; imports apply matching origin storage and queue other origins until navigation there.",
    Type.Object({ action: literals("cookies", "set_cookie", "clear_cookies", "export", "import", "reset"), domain: Type.Optional(string()), cookie: Type.Optional(Type.Object({ name: string(), value: Type.String(), domain: string(), path: Type.Optional(string()), secure: Type.Optional(Type.Boolean()), httpOnly: Type.Optional(Type.Boolean()) })), path: Type.Optional(string()) }), false,
    async (params, browser, signal, ctx) => {
      const manager = await options.getManager(ctx, signal);
      const pendingStorage = manager.pendingFor(browser.name);
      const details: Record<string, unknown> = { action: params.action };
      switch (params.action) {
        case "cookies": supported(browser, "cookies", "cookies"); return { text: await browser.cookies(params.domain, signal), details };
        case "set_cookie": {
          if (!params.cookie) throw new Error("set_cookie action requires cookie.");
          supported(browser, "cookies", "cookies");
          return { text: await browser.setCookie(params.cookie, signal), details };
        }
        case "clear_cookies": supported(browser, "cookies", "cookies"); return { text: await browser.clearCookies(signal), details };
        case "export": {
          supported(browser, "storageState", "storage state");
          const state = storageState(await browser.storageState(signal));
          const path = await artifactPath(config(), ctx.cwd, "state", "json", params.path);
          await writeArtifact(path, JSON.stringify(state, null, 2));
          return { text: `Storage state saved to ${path} (${state.cookies.length} cookies, ${state.origins.length} origins). Only the active page's origin storage is included.`, details: { ...details, path, cookies: state.cookies.length, origins: state.origins.length } };
        }
        case "import": {
          if (!params.path?.trim()) throw new Error("Import action requires path.");
          const path = resolve(ctx.cwd, params.path);
          const state = JSON.parse(await readFile(path, "utf8"));
          const report = await restoreStorageState(browser, state, { signal, cwd: ctx.cwd, pending: pendingStorage });
          const { text, ...counts } = report;
          return { text, details: { ...details, path, origins: state.origins.length, ...counts } };
        }
        case "reset": {
          pendingStorage.clear();
          const previousPid = browser.status().pid;
          if (browser.capabilities.cookies) await browser.clearCookies(signal);
          await browser.closeAll(signal);
          await browser.restart();
          pendingStorage.clear();
          return { text: browser.name === "chrome" ? "Browser reset: tabs closed, process restarted; cookies skipped on chrome (not supported). Persistent Chrome profile is retained (chrome.isolated=false)." : "Browser reset: cookies cleared, tabs closed, process restarted.", details: { ...details, previousPid, pid: browser.status().pid } };
        }
        default: throw new Error("Unknown state action.");
      }
    });
  register("browser_hover", "Hover a target on Chrome; return a fresh summary unless snapshot is false.",
    Type.Object({ ...target, ...snapshot }), false, async (p, b, s) => { supported(b, "hover", "hover"); return action(b, b.hover!(targetArgs(p, b), s), p, s); });
  register("browser_upload", "Upload one or more existing local files to a Chrome file input or chooser target. Paths resolve against the session cwd.",
    Type.Object({ ...target, paths: Type.Array(string(), { minItems: 1 }), ...snapshot }), false, async (p, b, s) => { supported(b, "upload", "upload"); return action(b, b.upload!(targetArgs(p, b), p.paths, s), p, s); });
  register("browser_dialog", "Accept or dismiss the open Chrome dialog; optionally supply prompt text.",
    Type.Object({ action: literals("accept", "dismiss"), promptText: Type.Optional(Type.String()) }), false, async (p, b, s) => { supported(b, "dialog", "dialog"); return { text: await b.dialog!(p.action, p.promptText, s) }; });
  register("browser_emulate", "Configure Chrome CPU, network and viewport emulation. Omit network to disable network throttling; CPU 1 resets CPU throttling.",
    Type.Object({ cpuThrottling: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })), network: Type.Optional(literals("Offline", "Slow 3G", "Fast 3G", "Slow 4G", "Fast 4G")), viewport: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*x[1-9][0-9]*$" })) }), false,
    async (p, b, s) => { supported(b, "emulate", "emulate"); return { text: await b.emulate!({ cpu: p.cpuThrottling, network: p.network, viewport: p.viewport }, s) }; });
  register("browser_perf", "Start/stop a Chrome performance trace or analyze a named insight from the most recent trace. Use tool_search to discover this tool.",
    Type.Object({ action: literals("start", "stop", "insight"), reload: Type.Optional(Type.Boolean()), autoStop: Type.Optional(Type.Boolean()), insightName: Type.Optional(string()) }), false,
    async (p, b, s) => { supported(b, "performance", "performance"); return { text: await b.perf!(p, s) }; });
  register("browser_network_request", "Read one Chrome network request's headers, body and timing by id or URL from browser_extract network.",
    Type.Object({ id: Type.Optional(string()), url: Type.Optional(string()) }), true,
    async (p, b, s) => { supported(b, "networkDetail", "network detail"); if ((p.id !== undefined) === (p.url !== undefined)) throw new Error("Provide exactly one of id or url."); return { text: await b.networkRequest!(p.id ?? p.url!, s) }; });
  return names;
}
