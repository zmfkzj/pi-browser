import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_USAGE } from "../src/extension/index.js";
import { BROWSER_COMPLETIONS, completeBrowserArguments } from "../src/extension/completions.js";
import { createHarness, type Harness } from "./helpers/harness.js";

const values = (prefix: string) => completeBrowserArguments(prefix)?.map(item => item.value) ?? null;
const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.dispose(); });

describe("/browser argument completions", () => {
  it("offers every subcommand on empty input, without duplicates", () => {
    const all = values("")!;
    expect(all).toEqual(BROWSER_COMPLETIONS.map(item => item.value));
    expect(new Set(all).size).toBe(all.length);
  });

  it("completes the whole argument string, including nested choices", () => {
    expect(values("en")).toEqual(["engine", "engine obscura", "engine chrome"]);
    expect(values("engine c")).toEqual(["engine chrome"]);
    expect(values("allow")).toEqual(["allow-private-network on", "allow-private-network off"]);
    expect(values("allow-private-network of")).toEqual(["allow-private-network off"]);
    expect(values("profile l")).toEqual(["profile load"]);
    expect(values("  st")).toEqual(["status", "stop"]);
  });

  it("offers nothing for unknown tokens, a lone exact match or free arguments", () => {
    expect(values("xyz")).toBeNull();
    expect(values("restart")).toBeNull();
    expect(values("engine chrome")).toBeNull();
    expect(values("install 0.2")).toBeNull();
    expect(values("profile load work")).toBeNull();
    expect(values("engine  c")).toBeNull();
  });

  it("keeps an exact match selectable when longer candidates exist", () => {
    expect(values("engine")).toEqual(["engine", "engine obscura", "engine chrome"]);
  });

  it("is wired to the registered command, and every candidate passes the handler's grammar", async () => {
    const install = async () => ({ path: process.execPath, version: "0.2.3", asset: "fake.tar.gz", bytes: 1, sha256: "a".repeat(64) });
    const h = await createHarness({ chrome: true, extension: { install } }); open.push(h);
    const command = h.session.extensionRunner.getCommand("browser")!;
    expect(command.getArgumentCompletions).toBe(completeBrowserArguments);
    for (const { value } of BROWSER_COMPLETIONS) {
      const before = h.notifications.length;
      await h.session.prompt(`/browser ${value}`);
      expect(h.notifications.slice(before).map(n => n.message), value).not.toContain(BROWSER_USAGE);
    }
  });
});
