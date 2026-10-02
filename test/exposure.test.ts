import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import type { Exposure } from "../src/config.js";
import {
  BROWSER_TOOL_EXPOSURE, DEFERRED_TOOL_NAMES, DIRECT_TOOL_NAMES,
  deferredToolGuideline, deferredToolNames, toolExposure,
} from "../src/exposure.js";
import { createHarness, tool, type Harness } from "./helpers/harness.js";

const direct = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_type",
  "browser_wait", "browser_screenshot", "browser_evaluate", "browser_fetch",
];
const deferred = [
  "browser_tabs", "browser_extract", "browser_state", "browser_pdf",
  "browser_press_key", "browser_select", "browser_scroll",
  "browser_hover", "browser_upload", "browser_dialog", "browser_emulate", "browser_perf", "browser_network_request",
];
const guideline = `More browser tools are available through tool_search: ${deferred.join(", ")}.`;
const builtins = ["bash", "edit", "read", "write"];
const sorted = (names: readonly string[]) => [...names].sort();
const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.dispose(); });
async function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness(options); open.push(h); return h;
}

describe("browser hybrid exposure policy", () => {
  it("defines exactly nine direct and thirteen deferred tools in guideline order", () => {
    expect(DIRECT_TOOL_NAMES).toEqual(direct);
    expect(DEFERRED_TOOL_NAMES).toEqual(deferred);
    expect(deferredToolNames()).toEqual(deferred);
    expect(deferredToolGuideline()).toBe(guideline);
    expect(deferredToolGuideline("direct")).toBe("");
    expect(deferredToolNames("deferred")).toEqual([...direct, ...deferred]);
  });

  it.each(["hybrid", "direct", "deferred"] as const)("maps every tool in %s mode", (mode) => {
    for (const name of [...direct, ...deferred]) {
      expect(toolExposure(name, mode)).toBe(mode === "hybrid" ? direct.includes(name) ? "direct" : "deferred" : mode);
    }
  });

  it("defaults future engine tools to deferred and generates guidance from the extensible table", () => {
    expect(toolExposure("browser_future_chrome_tool", "hybrid")).toBe("deferred");
    BROWSER_TOOL_EXPOSURE.browser_future_chrome_tool = "deferred";
    try {
      expect(deferredToolNames()).toEqual([...deferred, "browser_future_chrome_tool"]);
      expect(deferredToolGuideline()).toBe(`${guideline.slice(0, -1)}, browser_future_chrome_tool.`);
    } finally { delete BROWSER_TOOL_EXPOSURE.browser_future_chrome_tool; }
  });
});

describe("browser exposure in the real Pi harness", () => {
  it.each([
    ["hybrid", direct, [...builtins, "tool_search"]],
    ["direct", [...direct, ...deferred], builtins],
    ["deferred", [], [...builtins, "tool_search"]],
  ] as [Exposure, string[], string[]][])("has the exact active set for %s", async (exposure, browserNames, builtinNames) => {
    const h = await harness({ config: { exposure } });
    expect(sorted(h.session.getActiveToolNames())).toEqual(sorted([...browserNames, ...builtinNames]));
    const registered = h.session.getAllTools().filter(info => info.name.startsWith("browser_"));
    expect(sorted(registered.map(info => info.name))).toEqual(sorted([...direct, ...deferred]));
    for (const info of registered) expect(info.exposure).toBe(toolExposure(info.name, exposure));
    expect(h.children).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it("defaults to hybrid, with the exact deferred guidance on every direct tool", async () => {
    const h = await harness();
    expect(sorted(h.session.getActiveToolNames().filter(name => name.startsWith("browser_")))).toEqual(sorted(direct));
    for (const name of direct) {
      const info = h.session.getAllTools().find(info => info.name === name)!;
      expect(info.promptGuidelines).toContain(guideline);
    }
    for (const name of deferred) {
      const info = h.session.getAllTools().find(info => info.name === name)!;
      expect(info.promptGuidelines).not.toContain(guideline);
    }
  });

  it.each(["hybrid", "deferred"] as const)("uses Pi's real tool_search to activate and execute browser_tabs in %s mode", async (exposure) => {
    const h = await harness({ config: { exposure }, steps: [
      tool("tool_search", { query: "browser_tabs", limit: 1 }),
      tool("browser_tabs", { action: "list" }),
      reply("done"),
    ] });
    expect(h.session.getActiveToolNames()).toContain("tool_search");
    expect(h.session.getAllTools().find(info => info.name === "tool_search")?.exposure).toBe("model-only");
    expect(h.session.getActiveToolNames()).not.toContain("browser_tabs");
    await h.session.prompt("Find the browser_tabs tool and list tabs.");
    const results = h.session.messages.filter(message => message.role === "toolResult");
    expect(results[0]).toMatchObject({ toolName: "tool_search", isError: false, details: { loaded: ["browser_tabs"] } });
    expect(results[1]).toMatchObject({ toolName: "browser_tabs", isError: false, details: { tool: "browser_tabs", action: "list" } });
    expect(results[1]?.content).toContainEqual({ type: "text", text: "No open tabs." });
    expect(h.session.getActiveToolNames()).toContain("browser_tabs");
    expect(sorted(h.session.getActiveToolNames().filter(name => name.startsWith("browser_"))))
      .toEqual(sorted([...(exposure === "hybrid" ? direct : []), "browser_tabs"]));
    expect(h.manager.active()).toBeUndefined();
    expect(h.children).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });
});

it('discovers a Chrome-only deferred tool through real tool_search and executes it on fake Chrome',async ()=> {
  const h=await harness({chrome:true,steps:[
    tool('browser_navigate',{url:'http://127.0.0.1:3000/',engine:'chrome'}),
    tool('tool_search',{query:'browser_perf',limit:1}),
    tool('browser_perf',{action:'start',reload:false,autoStop:false}),reply('done'),
  ]});
  expect(h.session.getActiveToolNames()).not.toContain('browser_perf');
  await h.session.prompt('Trace the local app');
  const results=h.session.messages.filter(m=>m.role==='toolResult');
  expect(results.map(r=>r.isError)).toEqual([false,false,false]);
  expect(results[1]).toMatchObject({details:{loaded:['browser_perf']}});
  expect(results[2]?.content).toContainEqual({type:'text',text:'The performance trace is being recorded. Use performance_stop_trace to stop it.'});
  expect(h.session.getActiveToolNames()).toContain('browser_perf');
  expect(h.children).toHaveLength(1);
});
