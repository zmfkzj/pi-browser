import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage as reply, getCurrentTools, type FauxResponseStep } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createHarness, tool, type Harness } from "./helpers/harness.js";

// Pi 1.3.0+ restores a resumed session's active tools from its transcript and keeps them across /reload; tools that
// register late (in session_start, like these) are activated once they register. These pin that the browser extension
// keeps such tools, including the deferred ones a tool_search loaded, and other extensions' late tools.

const direct = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_type",
  "browser_wait", "browser_screenshot", "browser_evaluate", "browser_fetch",
];
const sorted = (names: readonly string[]) => [...names].sort();
const browserNames = (names: readonly string[]) => sorted(names.filter(name => name.startsWith("browser_")));
const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0).reverse()) await h.dispose(); });
async function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness(options); open.push(h); return h;
}

/** Another extension's deferred tool, registered late like an MCP server's. */
const otherExtension = (pi: ExtensionAPI) => {
  pi.on("session_start", () => {
    pi.registerTool({
      name: "other_lookup", label: "Other lookup", description: "Another extension's deferred lookup tool.", exposure: "deferred",
      parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "looked up" }], details: undefined }; },
    });
  });
};

/** Faux steps that record the tools each request declares. */
function recorder() {
  const declared: string[][] = [];
  const capture = (text = "ok"): FauxResponseStep => (context) => {
    declared.push(getCurrentTools(context.messages).map(tool => tool.name));
    return reply(text);
  };
  return { declared, capture };
}

/**
 * A persisted session that loaded browser_tabs and other_lookup through tool_search (only a tool, when its exposure is
 * direct), then the same session resumed with `resumed`'s options.
 */
async function resumeAfterSearch(resumed: Parameters<typeof createHarness>[0] = {}, first: Parameters<typeof createHarness>[0] = {}) {
  const searched = first.config?.exposure !== "direct";
  const a = await harness({
    ...first, extensionFactories: [otherExtension],
    sessionManager: (cwd) => SessionManager.create(cwd, join(cwd, "..", "sessions")),
    steps: searched ? [
      tool("tool_search", { query: "browser_tabs", limit: 1 }),
      tool("tool_search", { query: "other_lookup", limit: 1 }),
      reply("done"),
    ] : [tool("browser_tabs", { action: "list" }), reply("done")],
  });
  await a.session.prompt("Load the tabs tool.");
  expect(a.session.getActiveToolNames()).toEqual(expect.arrayContaining(searched ? ["browser_tabs", "other_lookup"] : ["browser_tabs"]));
  const file = a.session.sessionManager.getSessionFile()!;
  await a.shutdown();
  a.session.dispose();
  const { declared, capture } = recorder();
  const b = await harness({
    ...resumed, root: a.root, extensionFactories: [otherExtension],
    sessionManager: () => SessionManager.open(file, join(a.root, "sessions")),
    steps: [capture()],
  });
  await b.session.prompt("Continue.");
  return { a, b, declared };
}

describe("browser tools of a restored or reloaded session (real Pi session)", () => {
  it("declares the defaults in a fresh session: direct tools and tool_search, no deferred tool", async () => {
    const { declared, capture } = recorder();
    const h = await harness({ steps: [capture()] });
    await h.session.prompt("Hello.");
    expect(browserNames(declared[0]!)).toEqual(sorted(direct));
    expect(declared[0]).toContain("tool_search");
    expect(h.errors).toEqual([]);
  });

  it("keeps tools tool_search loaded, and other extensions' late tools, when the session is resumed", async () => {
    const { b, declared } = await resumeAfterSearch();
    expect(browserNames(declared[0]!)).toEqual(sorted([...direct, "browser_tabs"]));
    expect(declared[0]).toEqual(expect.arrayContaining(["tool_search", "other_lookup", "read", "bash", "edit", "write"]));
    expect(b.errors).toEqual([]);
  });

  it("keeps them across /reload", async () => {
    const { declared, capture } = recorder();
    const h = await harness({ extensionFactories: [otherExtension], steps: [
      tool("tool_search", { query: "browser_tabs", limit: 1 }),
      tool("tool_search", { query: "other_lookup", limit: 1 }),
      reply("done"), capture(),
    ] });
    await h.session.prompt("Load the tabs tool.");
    await h.session.reload();
    await h.session.prompt("Continue.");
    expect(browserNames(declared[0]!)).toEqual(sorted([...direct, "browser_tabs"]));
    expect(declared[0]).toEqual(expect.arrayContaining(["tool_search", "other_lookup"]));
    expect(h.errors).toEqual([]);
  });

  it("applies an exposure change made between the sessions: the newly deferred tools are no longer declared", async () => {
    const { declared } = await resumeAfterSearch({ config: { exposure: "deferred" } });
    expect(browserNames(declared[0]!)).toEqual(["browser_tabs"]);
    expect(declared[0]).toEqual(expect.arrayContaining(["tool_search", "other_lookup"]));
  });

  it("applies a change from direct to hybrid exposure: the tools hybrid defers are dropped", async () => {
    const { declared } = await resumeAfterSearch({}, { config: { exposure: "direct" } });
    expect(browserNames(declared[0]!)).toEqual(sorted(direct));
    expect(declared[0]).toContain("tool_search");
  });

  it("applies an exposure change made before /reload", async () => {
    const { declared, capture } = recorder();
    const h = await harness({ steps: [tool("tool_search", { query: "browser_tabs", limit: 1 }), reply("done"), capture()] });
    await h.session.prompt("Load the tabs tool.");
    await import("node:fs/promises").then(fs => fs.writeFile(join(h.agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath, exposure: "deferred" })));
    await h.session.reload();
    await h.session.prompt("Continue.");
    expect(browserNames(declared[0]!)).toEqual(["browser_tabs"]);
  });

  it("honours an explicit exclusion of a restored tool", async () => {
    const { b, declared } = await resumeAfterSearch({ sessionOptions: { excludeTools: ["browser_tabs"] } });
    expect(browserNames(declared[0]!)).toEqual(sorted(direct));
    expect(b.session.getAllTools().some(info => info.name === "browser_tabs")).toBe(false);
  });

  it("starts a new session after a restored one with the defaults", async () => {
    const { a } = await resumeAfterSearch();
    const { declared, capture } = recorder();
    const fresh = await harness({ root: a.root, sessionManager: (cwd) => SessionManager.create(cwd, join(cwd, "..", "sessions")), steps: [capture()] });
    await fresh.session.prompt("Hello.");
    expect(browserNames(declared[0]!)).toEqual(sorted(direct));
  });
});
