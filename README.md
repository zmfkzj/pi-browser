# pi-browser

Curated [Pi](https://github.com/earendil-works/pi) tools over two engines: [obscura](https://github.com/h4ckf0r0day/obscura), a lightweight independent Rust + V8 headless browser (**not Chromium**), and real Google Chrome through Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp). One `browser_*` vocabulary handles navigation, interaction, extraction and debugging. `browser_fetch` reads a public page in a separate obscura one-shot process. A bundled `browser` skill teaches routing and the workflow.

## Install and start

Install only the browser package, or use the [oh-my-pi-extensions umbrella repo](https://github.com/zmfkzj/oh-my-pi-extensions) to load browser, orchestration, and computer-use extensions together:

```sh
# Browser only (choose this OR the batch package):
pi install git:github.com/zmfkzj/pi-browser
# Or from a standalone local checkout:
pi install /path/to/pi-browser
# Batch package:
pi install git:github.com/zmfkzj/oh-my-pi-extensions
# Temporary browser-only loading:
pi -e /path/to/pi-browser
```

Run `/browser status`, then ask the agent to open `https://example.com`.

After upgrading the package in a running Pi session, run `/reload` to load the updated extension.

### Binary provisioning

The obscura binary is not bundled. When a browser tool needs it and none is found, `autoInstall: "ask"` requests your consent in an interactive/RPC UI before downloading the configured release from GitHub (v0.2.3, about 70 MB, Apache-2.0). Declining, setting `autoInstall: "never"`, or running without a UI fails with manual-install instructions; there is no silent download.

At startup, a missing binary produces one short info notice with `autoInstall: "ask"`: `browser: obscura is not installed yet. Run /browser install, or accept the download prompt when a browser tool is first used.` With `autoInstall: "never"`, a short warning lists the resolution locations and suggests a manual install or `/browser install`. No binary notice appears when an executable resolves; full diagnostics remain available in tool-call errors.

You can explicitly run `/browser install` or `/browser install 0.2.3` without a confirmation dialog. Download progress appears in the status line; completion reports the path, archive size, and SHA-256. The installer verifies the archive **before extraction**, uses the system `tar`, removes the unused worker binary, and checks `obscura --version` **before swapping** the managed install. An existing version is atomically moved to a backup, restored if the swap fails or is aborted, and removed after success. Stale backup directories are cleaned up best effort; temporary/backup directories are never resolved as managed installs. Supported release targets are Linux/macOS x86_64 and aarch64, and Windows x86_64; Windows extraction requires a zip-capable `tar` (bsdtar). **Linux release binaries need glibc 2.35+ (Ubuntu 22.04+).**

Managed binaries live at `<agentDir>/pi-browser/obscura/<version>/obscura[.exe]`, normally under `~/.pi/agent`. A successful `/browser install <version>` persists a changed version in `<agentDir>/browser.config.json`, preserving unrelated keys, then reloads config. A trusted project `version` still wins; the command warns about that override.

For offline/manual provisioning, obtain or build obscura yourself, verify its provenance/checksum, make it executable, then choose one of:

```sh
export PI_BROWSER_OBSCURA_BIN=/absolute/path/to/obscura
# Or place obscura on PATH, or set binaryPath in browser.config.json.
```

Resolution order: executable `binaryPath` → `PI_BROWSER_OBSCURA_BIN` → `obscura` on PATH → managed cache for `version`. Missing/nonexecutable candidates fall through. After every successful install, the command warns if config/environment/PATH still selects a different binary and reports its source/path; clear those overrides to use the cache. Manual binaries are user-trusted and are not archive-verified by the extension.

### Checksum policy

`installObscura` uses, in order: an explicit verified `checksum` option (programmatic API), a pinned `<version>/<asset>` entry in `src/checksums.ts`, or the matching GitHub Releases API asset's `sha256:<hex>` digest. Without any of these it refuses to download/install an unverified archive. `/browser install` accepts only a version, **not a checksum argument**; for releases lacking trusted digests, provision a verified build manually. A mismatch fails and cleans temporary files. Trust in an API digest depends on GitHub and the upstream release account; this is not a signature verification scheme.

Pinned v0.2.3 assets (rendering-enabled builds only): all ten hashes below came from [`assets[].digest` in the release API](https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v0.2.3). The Linux x86_64 render hash was also computed with `sha256sum` on the existing 70,880,637-byte release archive and cross-checked against the API. No other archive was downloaded to establish these pins.

| Asset (version 0.2.3) | SHA-256 |
| --- | --- |
| `obscura-x86_64-linux.tar.gz` | `1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec` |
| `obscura-x86_64-linux-stealth.tar.gz` | `1283fff4b781eca438294ae1ba4bf986b63d7628097150a3910ed8f3e3e2142e` |
| `obscura-aarch64-linux.tar.gz` | `5ecf980bca3060236a7a86ec7ed83d943e6598ee87caa46d20325d90bc75f979` |
| `obscura-aarch64-linux-stealth.tar.gz` | `dab4184c6b08a6066eaa5b9935ee5c3776fbc9f0173edfae5bf67990a63bb62e` |
| `obscura-x86_64-macos.tar.gz` | `d7c48122debc2ad9b24842df44560860dba765ea928b3f636b7f053225245116` |
| `obscura-x86_64-macos-stealth.tar.gz` | `c779c3facf1b491fca139dd717bafd684cf9c7dea478a50e8f116b4de7605e6b` |
| `obscura-aarch64-macos.tar.gz` | `45653cfad226f1c9b415603a2ed59477fcbd6335c742338ce133c05de0bdd056` |
| `obscura-aarch64-macos-stealth.tar.gz` | `5d3127d9e8eedacb0e35cdb1d174ca837b80e79405074d0b16010fbe818f21d0` |
| `obscura-x86_64-windows.zip` | `781a1b8bd12b65ec5aba95842e75e6f56b3101d360397506c0e35fe3f78536e8` |
| `obscura-x86_64-windows-stealth.zip` | `4d7311c69c3263bb8376055f9cb846968b75c77c444d4b5efa74b1018b456fb9` |

## Engines and routing

Curated tools call `BrowserEngine`, not upstream MCP names. `ObscuraEngine` and `ChromeEngine` own protocol mapping, refs, decoding and capabilities. Both use the generic FIFO `McpStdioClient`; `EngineManager` owns sticky selection, independent tabs and per-engine origin-storage queues.

Use **obscura / browser_fetch** for light, repetitive public reading. Use **chrome** for the app under development, fidelity-sensitive pages and DevTools-style console/network/performance debugging. The engine is chosen per task/URL, not automatically switched per operation.

| Capability | obscura | chrome |
| --- | --- | --- |
| Navigate, snapshot, click, fill/form, keys, tabs/history | Native | Native (numeric page IDs; uid refs) |
| CSS selectors | Native | Script-emulated; prefer uid refs |
| Type | Native append + optional Enter | Fill (replace text) + optional Enter |
| Select option / scroll / selector wait | Native | Script-emulated / polling |
| Markdown, links, search, schema extract, forms | Native | Deterministic page scripts |
| Screenshot | Viewport PNG | Viewport or full-page PNG |
| PDF | Yes | Unsupported; use obscura |
| Cookie operations, storage export | Yes | Unsupported; use obscura |
| Storage import | Cookies + origin-storage workaround | Cookies skipped; local/session storage by script |
| Hover, file upload, dialog | Unsupported; use chrome | Native |
| CPU/network/viewport emulation, performance trace/insights | Unsupported; use chrome | Native |
| Console/network lists | Yes | Yes |
| Network request detail | Unsupported; use chrome | Headers/body/timing by ID or URL |

Unsupported operations explicitly name the alternative engine; they never silently move your session.

- Explicit `engine: "obscura" | "chrome"` on `browser_navigate` or `browser_tabs { action: "new" }` wins.
- Otherwise selection is **sticky**: keep the active engine. With none active, use config `engine`.
- `engine: "auto"` prefers available Chrome for loopback/private IPs or hosts ending `.localhost`, `.local`, `.test`; otherwise it prefers obscura, then any available engine. Routing is lexical (no DNS lookup). Obscura's private-network guard still requires its own opt-in; Chrome has no equivalent guard.
- `/browser engine <name>` sets a session-only default for the next navigation, overriding stickiness; it activates an engine immediately if it already has open pages. `/browser engine` shows active/default names.

### Chrome setup

Install Google Chrome yourself; this package never downloads Chromium. In a local package checkout, run `npm install` **inside the pi-browser package**: it pulls the exactly pinned `chrome-devtools-mcp` **1.10.1**. This version requires Node `^20.19.0 || ^22.12.0 || >=23` (Node 24 is supported). The extension resolves its bundled server entry and starts it with the current Node executable, never `npx`.

```json
{
  "engine": "auto",
  "chrome": {
    "enabled": true,
    "headless": "auto",
    "isolated": false,
    "channel": "stable",
    "executablePath": "/usr/bin/google-chrome",
    "viewport": "1280x800"
  }
}
```

`headless: "auto"` launches headed when `DISPLAY` or `WAYLAND_DISPLAY` is set, otherwise headless. Set `true` for CI or `false` for a visible browser. `executablePath` wins executable discovery; `browserUrl` attaches without probing; otherwise standard PATH/OS locations are checked. `channel` is passed only without an explicit executable or attach URL.

With `isolated: false`, chrome-devtools-mcp manages a persistent profile under `$HOME/.cache/chrome-devtools-mcp/chrome-profile` (non-stable channels use a suffix). Logins survive restart/stop/reset. `isolated: true` uses a temporary profile removed with the owned browser; use it for tests or disposable tasks. Pi's obscura `profile` setting does not manage Chrome profiles.

To attach to an existing **trusted** Chrome instance, start it yourself (modern Chrome requires a non-default user-data directory for remote debugging):

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir=/path/to/trusted-dev-profile
```

Then set `"chrome": { "browserUrl": "http://127.0.0.1:9222" }` and run `/browser restart`. Attach mode stops only the MCP server, never your Chrome process; tab actions still affect the attached browser. Do not expose the debugging port to untrusted networks.

`chrome.args` is additional **MCP argv**, not raw Chrome flags. For extra Chrome flags use e.g. `"--chrome-arg=--disable-gpu"`. Uploads must exist and resolve against the session cwd; upstream's filesystem guard allows temp paths and the adapter adds `--workspace <session cwd>`. Uploads elsewhere need explicit trusted roots in args, e.g. `["--workspace", "/trusted/uploads"]`. Usage statistics and CrUX requests are disabled by default by the adapter.

Tabs/state are independent between engines; switching does not migrate them. `browser_tabs list` returns `[obscura]` / `[chrome]` blocks for started engines and marks `(active)`. An optional `engine` filters list or targets switch/close; otherwise switch/close use the active engine. Navigation and snapshots identify the engine in `URL: … | Title: … | engine: obscura`.


## Configuration

User config: `<agentDir>/browser.config.json` (normally `~/.pi/agent/browser.config.json`). Trusted-project config: `<cwd>/.pi/browser.config.json`. Project values override user values per key, including individual nested `chrome` keys; `chrome.args` replaces the array. Untrusted project files are never read. Unknown keys (including nested keys), wrong types, and invalid ranges reject the entire file with warnings; defaults/other valid files still apply. Run `/browser restart` after editing config, or `/reload` to reload extensions.

```json
{
  "engine": "auto",
  "exposure": "hybrid",
  "autoInstall": "ask",
  "allowPrivateNetwork": false,
  "profile": "work"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `binaryPath` | `null` | Explicit executable path |
| `version` | `"0.2.3"` | Release to download and managed-cache version; semver such as `0.2.3` |
| `variant` | `"render"` | Download asset: `render` or `stealth`; not itself a launch flag |
| `autoInstall` | `"ask"` | `ask` requests download consent when missing; `never` requires explicit/manual install |
| `profile` | `null` | Auto-save/restore storage profile; name matching `/^[\w.-]{1,64}$/` |
| `rawMcp` | `false` | Also register a separate raw obscura MCP server with codemode exposure |
| `allowPrivateNetwork` | `false` | Pass `--allow-private-network`; permit local/private services |
| `stealth` | `false` | Pass `--stealth`; separate from the asset variant |
| `proxy` | `null` | Proxy URL (`--proxy`); credentials are visible in process argv |
| `userAgent` | `null` | User agent (`--user-agent`) |
| `timeoutMs` | `45000` | Per-MCP-call deadline, except evaluate and explicit waits; does not set fetch timeout |
| `evaluateTimeoutMs` | `30000` | Evaluate deadline |
| `idleMs` | `600000` | Stop the MCP child after inactivity |
| `maxOutputChars` | `12000` | Inline text budget before head/tail spill |
| `actionSummaryChars` | `3000` | Page-text budget for automatic action summaries |
| `artifactsDir` | `null` | Screenshot/PDF/state destination; null uses `<os.tmpdir()>/pi-browser/<spill key>/`; relative values resolve against session cwd |
| `engine` | `"auto"` | `auto`, `obscura` or `chrome`; initial engine selection |
| `exposure` | `"hybrid"` | `hybrid` minimal direct set; `direct` all direct; `deferred` all searchable via `tool_search` |
| `chrome.enabled` | `true` | Enable Chrome availability |
| `chrome.headless` | `"auto"` | Auto is headed only with DISPLAY/WAYLAND_DISPLAY; or explicit boolean |
| `chrome.isolated` | `false` | Temporary rather than persistent profile |
| `chrome.channel` | `"stable"` | `stable`, `beta`, `dev` or `canary`; omitted for executable/attach |
| `chrome.executablePath` | `null` | Explicit installed Chrome executable |
| `chrome.browserUrl` | `null` | Attach URL, e.g. `http://127.0.0.1:9222` |
| `chrome.viewport` | `null` | Viewport string, e.g. `"1280x800"` |
| `chrome.args` | `[]` | Additional MCP argv; Chrome flags use `--chrome-arg=...` |

Numeric config values are integers from 1 to 2147483647. Nullable strings must otherwise be nonempty; profile/version have the stricter validation above.

## Tool exposure

Default **hybrid** mode keeps the common workflow direct and defers specialist tools:

- **Direct (9):** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_type`, `browser_wait`, `browser_screenshot`, `browser_evaluate`, `browser_fetch`.
- **Deferred (13):** `browser_tabs`, `browser_extract`, `browser_state`, `browser_pdf`, `browser_press_key`, `browser_select`, `browser_scroll`, `browser_hover`, `browser_upload`, `browser_dialog`, `browser_emulate`, `browser_perf`, `browser_network_request`.

`direct` exposes all 22 tools; `deferred` initially exposes none. Deferred tools remain registered: use Pi's built-in `tool_search`, e.g. `{ "query": "browser_perf", "limit": 1 }`, to find and activate them. The extension enables `tool_search` when registered and browser tools are deferred. Direct tools include a guideline generated from the deferred table.


## Tools and workflow

Navigate → read the summary → act using a current ref → read the refreshed summary. Refs are engine-specific: obscura uses `e1`, Chrome uses snapshot uids like `1_5`. Treat refs as stale after **every action/navigation/tab change** even when unchanged Chrome nodes retain their uid. Never reuse refs across engines. Use the latest returned refs or call `browser_snapshot`. Targets accept exactly one of `ref` or CSS `selector`; on Chrome prefer refs because selector clicks/fills are script emulation, not native user events. Press-key/scroll targets are optional. Before navigation, page tools report `No page is open yet; call browser_navigate first.`

`?` means optional:

| Tool | Parameters | Returns |
| --- | --- | --- |
| `browser_fetch` | `url`, `format?` (`text`, `markdown`, `html`, `links`), `maxChars?`, `timeoutMs?`, `waitUntil?`, `selector?` | Bounded one-shot page output; **no session login state or refs** |
| `browser_navigate` | `url`, `engine?` (`obscura`, `chrome`), `waitUntil?` (`load`, `domcontentloaded`, `networkidle0`) | HTTP(S) page summary, engine name and fresh refs |
| `browser_snapshot` | `maxChars?`, `interactive?`, `limit?` | Current page summary; refs by default, limit 60 |
| `browser_evaluate` | `expression` | JSON `ok/value`; syntax/runtime errors fail the tool |
| `browser_click` | `ref?`, `selector?`, `snapshot?` | Click headline and optional summary |
| `browser_fill` | Single: `ref?`, `selector?`, `value`; form: `fields`, `submit?`; `snapshot?` | Fill headline, including partial field errors, and optional summary |
| `browser_type` | `ref?`, `selector?`, `text`, `pressEnter?`, `snapshot?` | Type/Enter headline and optional summary |
| `browser_press_key` | `key`, `ref?`, `selector?`, `snapshot?` | Key headline and optional summary |
| `browser_select` | `ref?`, `selector?`, `value`, `snapshot?` | Selected-option headline and optional summary |
| `browser_scroll` | `direction?` (`top`, `bottom`, `up`, `down`, `left`, `right`), `amount?`, `ref?`, `selector?`, `snapshot?` | Scroll headline and optional summary |
| `browser_wait` | Exactly one of `selector?`, `text?`, `ms?`; `timeoutMs?`, `snapshot?` | Wait headline; no summary by default |
| `browser_screenshot` | `width?`, `height?`, `fullPage?`, `path?` | Saved PNG path/dimensions/bytes and one image block; fullPage requires Chrome |
| `browser_pdf` | `path?`, `landscape?`, `printBackground?`, `scale?`, `paperWidth?`, `paperHeight?`, `marginTop?`, `marginBottom?`, `marginLeft?`, `marginRight?` | Saved PDF path/bytes, not its base64 payload |
| `browser_extract` | `mode` (`markdown`, `links`, `search`, `schema`, `forms`, `console`, `network`), `maxChars?`, `limit?`, `internalOnly?`, `query?`, `caseSensitive?`, `contextChars?`, `schema?` | Extracted text/JSON or console/network history |
| `browser_tabs` | `action` (`list`, `new`, `switch`, `close`, `back`, `forward`, `reload`), `engine?`, `url?`, `tabId?`, `snapshot?` | List: per-engine blocks; close: text; other actions: headline and optional summary |
| `browser_state` | `action` (`cookies`, `set_cookie`, `clear_cookies`, `export`, `import`, `reset`), `domain?`, `cookie?`, `path?` | Cookies or short headlines/counts; export/import files; reset restarts the browser |
| `browser_hover` | `ref?`, `selector?`, `snapshot?` | Chrome hover + optional summary |
| `browser_upload` | `ref?`, `selector?`, `paths: string[]`, `snapshot?` | Chrome file upload + optional summary |
| `browser_dialog` | `action` (`accept`, `dismiss`), `promptText?` | Chrome dialog result |
| `browser_emulate` | `cpuThrottling?` (1–20), `network?`, `viewport?` (`WxH`) | Chrome emulation settings |
| `browser_perf` | `action` (`start`, `stop`, `insight`), `reload?`, `autoStop?`, `insightName?` | Trace/insight text |
| `browser_network_request` | Exactly one of `id?`, `url?` | Chrome request headers/body/timing |

Chrome-only tools are deferred in hybrid mode. Network presets: `Offline`, `Slow 3G`, `Fast 3G`, `Slow 4G`, `Fast 4G`; omit network to disable throttling and use CPU 1 to reset CPU. Stop a performance trace (or auto-stop it) before requesting a named insight; the adapter remembers the insight-set ID. A native click opening a dialog suppresses its automatic summary: call `browser_dialog` before snapshot/evaluate, because upstream evaluation can auto-handle an open dialog. Prefer refs especially for dialogs.

- **Fetch:** prefer it for read-only docs/pages without authentication. Default format is `markdown`; timeout is 30000 ms, accepting 1000–120000 ms (CLI seconds round up). Uses the same private-network/stealth/proxy/user-agent settings as the session. Output beyond 8 MiB kills the child with an error; smaller output is bounded by `maxChars ?? maxOutputChars`. Exit 124 is reported as a timeout; upstream navigation deadlines can instead return exit 1 with a deadline diagnostic. Abort kills the child immediately. At the `timeoutMs + 10000` parent backstop, SIGTERM is followed by SIGKILL 2 s later if needed; the error reports the backstop duration. Programmatic `createBrowserExtension({ fetchKillGraceMs })` can override the default 10000 ms grace. Child errors also kill and settle even without a close event. Fetch is independent of MCP tabs, cookies, profiles, and refs.
- **Summaries:** click/fill/type/press-key/select/scroll and most tab actions return page text (`actionSummaryChars`) and up to 40 fresh refs. Use `snapshot: false` to save tokens while chaining CSS-selector actions; refresh refs before using them again. Wait defaults to `snapshot: false`; navigate always summarizes.
- **Fill:** choose single or form mode. `fields` is a nonempty array of `{ ref?, selector?, value?, type? }`; `type` is `text`, `check`, `uncheck`, or `select`. Optional `submit: { ref?, selector? }` is form-only. Inspect the headline for per-field errors even when the overall call succeeds.
- **Evaluate:** use a single JavaScript expression or IIFE, e.g. `(() => { return [...document.querySelectorAll('a')].map(a => a.href); })()`. Undefined becomes null; non-serializable values fall back to strings. Evaluation can mutate the page; refresh refs afterward.
- **Wait:** prefer selector/text conditions to fixed sleeps. Selector/text waits default to 30000 ms; native MCP deadline is `timeoutMs + 5000`; Chrome selectors poll scripts every 250 ms with timeout/abort. `ms` is an abortable 1–30000 ms delay. `waitUntil` controls obscura navigation/fetch readiness; Chrome manages readiness upstream and does not expose that option.
- **Extract:** `search` requires `query`; `schema` maps field names to CSS selectors, with `field[]` producing an array and `selector@attr` reading attributes, e.g. `{ "links[]": "a@href" }`. Forms/console/network need no mode-specific arguments.
- **Captures:** screenshots support integer dimensions 1–32768; obscura additionally caps captures at 16 Mpx. PDF scale is 0.1–2, paper sizes are positive and at most 200 inches, margins are nonnegative inches.
- **Tabs/state:** switch requires `tabId`; close defaults to the active tab. Set-cookie requires `{ name, value, domain, path?, secure?, httpOnly? }`. `browser_state import` requires `path` to JSON with `{ cookies: [], origins: [] }`; origin entries must be `{ origin: string, localStorage?: [string,string][], sessionStorage?: [string,string][] }`. Cookies restore via the engine; the extension applies localStorage/sessionStorage to the matching active origin and queues other origins **per engine** until navigation, tab-new/switch, or history/reload reaches them. Reports include cookie/storage counts and queued origins; navigation results mention applied queued entries. Opaque origins such as about:blank are queued rather than written. Exports contain only the active page's origin storage. Reset clears the active engine's cookies/queue, closes its tabs and restarts it; other engines are unaffected.
  On Chrome, cookies/export are unsupported. Import reports `cookies skipped on chrome (not supported); storage entries are applied by script` and still applies/queues origin storage. Reset clears queues/task tabs and restarts the server but retains a persistent Chrome profile (isolated profiles are disposable). Chrome cannot close its last page: closeAll temporarily creates a new neutral about:blank tab and closes every original task tab.

## `/browser` commands

```text
/browser status
/browser engine [obscura|chrome]
/browser stop
/browser restart
/browser install [version]
/browser allow-private-network on|off
/browser profile save|load|clear [name]
```

- `status`: show active/session-default/config-default engine, each engine's running/PID/binary information, Chrome config, config sources/errors, and artifact/cache paths. It does not download or start a browser.
- `engine [obscura|chrome]`: inspect active/default engine or set a session default for the next navigation; activate immediately if that engine already has pages. Unavailable engines report how to fix availability.
- `stop`: gracefully stop **all** curated engines; their tabs and queued storage are lost.
- `restart`: reload config and restart **only the active engine**, retaining other engines; with none active, select/start the default. The restarted engine loses tabs/old queued storage; configured profiles can restore fresh storage. Missing obscura binaries follow the consent policy.
- `install [version]`: explicit verified obscura download, without confirmation; defaults to configured version. Stops all curated engines and reports path/size/hash. A changed explicit version is saved to user `browser.config.json`; completion adds `version <v> saved to <path>`. No config write occurs when the version is unchanged. Status shows `cache` when no higher-priority binary override exists.
  - Trusted-project override: `browser: <project config path> sets version; the project value wins.`
  - Binary precedence: `Installed to <cache path>, but binary resolution currently uses <source>: <path>. Remove binaryPath / PI_BROWSER_OBSCURA_BIN / the PATH entry to use the managed binary.`
- `allow-private-network on|off`: preserve user-config keys, validate values, write pretty 2-space JSON plus a trailing newline with `0600`, reload config, and restart only if running. A trusted project setting wins; the command warns about that override. Invalid existing JSON is not overwritten.
- `profile save|load|clear [name]`: export to, import from, or delete a named profile. Name defaults to `config.profile ?? "default"` and must match `/^[\w.-]{1,64}$/`. Saving overwrites that profile; loading requires the file to exist. Clearing deletes the file, not the current cookie jar.

## Storage profiles

**Obscura only:** set `profile: "work"` to restore `<agentDir>/pi-browser/profiles/work.json` after each fresh MCP handshake (if it exists). Before graceful stop/restart, idle stop, or shutdown, the extension exports state there. Restore/save are best effort with 10 s/5 s deadlines; failures warn once per phase and do not intentionally block browsing. Dead processes or hang-triggered kills cannot export state. Directories use `0700`, files `0600`. Chrome instead uses its own persistent profile; `/browser profile save` requires obscura, while loading can apply storage with cookies skipped on Chrome.

Profiles use the same restore workaround as `browser_state import`: obscura restores cookies only upstream, so wrapped page evaluations restore localStorage/sessionStorage on the matching active origin. Other origins queue per engine until navigation/switch; a fresh start normally queues saved storage until navigation. Exports include cookies and only the active page's origin storage, not every tab. Profiles are not full session backups: tabs, timers and JavaScript variables are not restored. Verify important state with `browser_evaluate`; stop/reset clears queues, while restart clears old entries before queuing newly restored profile storage.

Clearing an auto-managed profile while the browser is running does not disable auto-save; a subsequent graceful stop may recreate it. Set `profile: null` and reload config if you want to disable future automatic persistence.

## Optional raw MCP

With `rawMcp: true`, the extension registers `obscura` at session start when a binary resolves, with **codemode** exposure and obscura's 37 raw MCP tools. It refreshes registration after config reload/restart when command/arguments change. This is a **second obscura process with its own tabs and cookies**, independent of curated `browser_*` tools and `browser_fetch`. Curated storage-profile hooks and the storage restore workaround do not apply to the raw process. Leave it disabled unless you need upstream tools directly.

## Artifacts

Screenshots, PDFs, and `browser_state export` use `artifactsDir` or `<os.tmpdir()>/pi-browser/<spill key>/` by default. Explicit `path` resolves against session cwd, not `artifactsDir`. Parent directories are created with `0700`; new files use `0600` and atomic `wx` **no-overwrite** writes. Default names are `screenshot-<n>.png`, `page-<n>.pdf`, and `state-<n>.json`. Results include `details.path`.

Text exceeding the inline budget is a head/tail preview; full output spills to the process-specific temporary directory, even with a configured `artifactsDir`. Results include `details.spilledPath` and instructions for inspecting the file with `read`/`grep`. Artifacts and spills are not automatically removed. They can contain sensitive page/authentication data: protect and delete them when no longer needed. PNG data also appears once as a model image; PDF/exported-state payloads stay in files.

## Security and limitations

- **Obscura's SSRF guard is on by default.** Private/loopback services need `/browser allow-private-network on` or trusted config opt-in. **Chrome has no equivalent private-network guard**; auto routing can access your development app. Navigate/fetch/tab-new permit only HTTP(S) URLs.
- **No OS sandbox is provided by pi-browser for either engine.** Run Pi and browsers inside OS isolation when needed. Chrome's minimal environment additionally forwards display/session/temp/locale variables plus `CHROME_*` / `PUPPETEER_*`; environment filtering is not a security boundary.
- Headed Chrome shows what the agent does, but visibility is not a permission boundary. **Attach mode exposes the logged-in browser and its pages to the agent**; use a separate trusted development profile, not your everyday browser.
- Treat page text and scripts as **untrusted input**, not instructions from the user. Do not send secrets or perform consequential actions just because a page asks.
- Stealth is **not permission to bypass site terms/access controls**. No CAPTCHA/challenge solving is provided. The engine differs from Chromium, and some sites will not work.
- **Obscura inactive tabs suspend JavaScript:** timers, in-memory variables and sessionStorage may be lost. Chrome uses normal real-browser tab behavior.
- Proxy credentials are visible in command-line arguments. Profiles, cookies, captures, and full-output spills may contain credentials or private data.
- Curated MCP calls execute sequentially and the browser starts lazily. Deadline/active MCP cancellation kills its process and loses tabs/state; failed calls are not replayed. The next call starts a fresh process. Graceful stop/restart also loses tabs, but can preserve configured storage profiles. Cancelling a fixed in-process wait does not itself kill MCP.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Private/internal IP blocked | Use `/browser allow-private-network on` for trusted local services; check whether a trusted project config overrides it |
| Hung page script or stale state | Run `/browser restart`; tabs are lost, then navigate again |
| Unknown/stale ref | Call `browser_snapshot` and use the latest refs |
| Binary not found/download declined | Run `/browser install`, set `binaryPath`/`PI_BROWSER_OBSCURA_BIN`, or add an executable to PATH; inspect `/browser status` |
| Chrome not found | Install Google Chrome or set `chrome.executablePath` / `chrome.browserUrl`; inspect availability in `/browser status` |
| Chrome MCP package missing | Run `npm install` inside pi-browser; the server is pinned and never launched via npx |
| Chrome server fails to start | Inspect the tool error's stderr tail and `/browser status` (flags/executable/stderr); check Node version and executable permissions |
| DISPLAY missing / headed launch fails | Use `chrome.headless: true`; auto is headless when both display variables are absent |
| Chrome upload denied | Use temp/session-cwd files or add an explicit trusted `--workspace` root via `chrome.args` |
| Chrome PDF/cookie/export unsupported | Use `engine: "obscura"`; Chrome logins persist in its own profile when isolated=false |
| ELF/glibc launch error | Use glibc 2.35+ (Ubuntu 22.04+) or a compatible locally built binary |
| No trusted checksum/mismatch | Do not bypass verification; use a provenance-verified manual binary or investigate the release/hash |
| Import success but missing local/session storage | Inspect queuedOrigins and navigate to the saved origin; the extension applies queued storage then. Export includes only the active origin, not all tabs. Check values with `browser_evaluate`; raw MCP does not use this workaround |
| Existing artifact path | Choose another path; artifact tools never overwrite files |

## Development and verification

With the existing development dependencies available, from `browser/`:

```sh
npx tsc --noEmit
npx vitest run
# Optional E2E using the already provisioned /tmp/obscura-investigation-bin/obscura:
npx vitest run test/e2e.test.ts
```

Unit/integration tests use deterministic fake CLI/MCP servers, fake archives, local HTTP servers, and temporary agent directories. The root-manifest test loads the extensions and verifies actual browser-skill discovery through Pi's resource loader. Raw-MCP tests inspect registrations through the real extension API's `getMcpServers()`.
Chrome adapter tests use a dedicated NDJSON fake reproducing the pinned real schemas, uid errors, fenced evaluation output, page IDs and DevTools lists. The AgentSession harness defaults Chrome unavailable unless a test explicitly injects it. Manager tests cover the actual Chrome adapter alongside legacy identity-only seam tests; exposure tests use Pi's real `createToolSearchExtension()`.

E2E uses only `/tmp/obscura-investigation-bin/obscura`, skipping if the file is absent or fails the executable-access check (`accessSync` with `X_OK`); there is no environment-variable override. It runs actual interactions, extracts, artifacts, tabs, cookie/storage export/import/reset (including empty stores after reset, matching-origin restoration, and queued restoration after navigation), hung-script recovery, and one-shot fetch (`text`, `markdown`, `links`, plus an unresponsive-route timeout) against local fixtures with explicit private-network opt-in. It never installs or downloads a real binary. Fixtures, temporary files, and processes are cleaned up; the suite normally completes in a few seconds, below 60 s.

`test/e2e-chrome.test.ts` runs real Chrome + pinned MCP headless/isolated against a local fixture, including interaction, full-page PNG, console/network detail, hover/upload/dialog/emulation/perf, tabs, waits, partial storage import, unsupported PDF, reset and process-group/profile cleanup. It skips when `/usr/bin/google-chrome` (or `PI_BROWSER_CHROME_BIN`) is missing, or `PI_BROWSER_SKIP_CHROME_E2E=1`; it never downloads a browser. Observed upstream schemas/formats are committed under `test/fixtures/chrome-devtools-mcp-*`.
