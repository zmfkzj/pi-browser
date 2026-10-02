# chrome-devtools-mcp 1.10.1 observed formats

Local real Chrome fixture. All payloads below are actual requests/responses. Screenshot base64 omitted.

## Adapter observations

- Version 1.10.1 requires numeric `pageId` on every page-scoped tool; the initial page is `1`. `list_pages`/`new_page`/`select_page`/`close_page` return `## Pages` followed by `1: Title (URL) [selected]`. IDs are retained verbatim, not normalized.
- Snapshots use lines such as `uid=1_5 button "Go"`; unnamed roles omit the quoted label. Interactive nodes can carry `focusable`/`focused`. UIDs have numeric underscore-separated components. Some unchanged nodes retain IDs across actions; modified nodes get new prefixes. Treat all refs as potentially stale after every action/navigation.
- `evaluate_script` returns `Script ran on page and returned:` then a `json` code fence. Objects are JSON; strings are JSON-quoted, including wrapped evaluation JSON strings (the adapter decodes the fence and exactly one quoting layer).
- `evaluate_script.args` is an array of uid **strings**, not `{ uid }` objects; the function receives corresponding DOM elements. This enables ref focus/select/scroll and selector-to-uid matching for hover/upload.
- `fill_form.elements` is an array of `{uid,value}`. `fill` on `<select>` accepts visible text (`Beta`), NOT option value (`b`); curated select is therefore script-emulated and matches value or label.
- `wait_for.text` is a nonempty string array; `timeout` is milliseconds. Native navigation history is `navigate_page {type:"back"|"forward"|"reload"}`. There is no `waitUntil` parameter (the server manages readiness).
- `upload_file.filePaths` is a nonempty string array. This version defaults filesystem access to the OS temp directory: the adapter adds `--workspace <session cwd>` for project uploads. Additional trusted roots can be passed via `chrome.args` (`--workspace`, `/other/directory`).
- Combined `emulate` uses `cpuThrottlingRate`, `networkConditions` (`Offline`, `Slow 3G`, `Fast 3G`, `Slow 4G`, `Fast 4G`), and string `viewport` (`800x600` works). Omit network conditions to reset; rate 1 resets CPU.
- Trace insights require both `insightSetId` and `insightName`; the adapter remembers the first `## insight set id: NAVIGATION_0` from stop/auto-stop output.
- Native click returns an open-dialog notice without waiting for dismissal. Do not evaluate/summarize before `handle_dialog`: evaluate auto-handles dialogs upstream. Handling with no open dialog returns `Error: No open dialog found`.
- Last-page close is refused without killing the browser: `The last open page cannot be closed. It is fine to keep it open.` The adapter's closeAll creates one neutral about:blank tab and closes every prior task tab.
- New upstream extras (`type_text`, `get_css_styles`, `get_console_message`, `take_heapsnapshot`, `lighthouse_audit`, `drag`) were exercised below but are not exposed as additional curated tools in Step B. Curated type deliberately remains fill + optional Enter.
- `--chromeArg` / `--chrome-arg` is the real flag for extra Chrome flags; `chrome.args` is additional MCP argv, so use e.g. `"--chrome-arg=--disable-gpu"`. The adapter disables usage statistics and CrUX queries with `--no-usage-statistics` / `--no-performance-crux`.


## list_pages
Request: `{}`

```
## Pages
1: about:blank [selected]
```

## navigate_page
Request: `{"pageId":1,"url":"http://127.0.0.1:43307/"}`

```
Successfully navigated to http://127.0.0.1:43307/.
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name"
  uid=1_5 button "Go"
  uid=1_6 StaticText "Ready"
  uid=1_7 form
    uid=1_8 textbox
    uid=1_9 combobox expandable haspopup="menu" value="Alpha"
      uid=1_10 option "Alpha" selectable selected value="Alpha"
      uid=1_11 option "Beta" selectable value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## evaluate_script
Request: `{"pageId":1,"function":"() => ({title:document.title, url:location.href})"}`

```
Script ran on page and returned:
```json
{"title":"Chrome Fixture","url":"http://127.0.0.1:43307/"}
```
```

## evaluate_script
Request: `{"pageId":1,"function":"() => JSON.stringify({ok:true,value:document.title})"}`

```
Script ran on page and returned:
```json
"{\"ok\":true,\"value\":\"Chrome Fixture\"}"
```
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name"
  uid=1_5 button "Go"
  uid=1_6 StaticText "Ready"
  uid=1_7 form
    uid=1_8 textbox
    uid=1_9 combobox expandable haspopup="menu" value="Alpha"
      uid=1_10 option "Alpha" selectable selected value="Alpha"
      uid=1_11 option "Beta" selectable value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## fill
Request: `{"pageId":1,"uid":"1_4","value":"Alice"}`

```
Successfully filled out the element
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name" focusable focused value="Alice"
  uid=1_5 button "Go"
  uid=1_6 StaticText "Ready"
  uid=1_7 form
    uid=1_8 textbox
    uid=1_9 combobox expandable haspopup="menu" value="Alpha"
      uid=1_10 option "Alpha" selectable selected value="Alpha"
      uid=1_11 option "Beta" selectable value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## click
Request: `{"pageId":1,"uid":"1_5"}`

```
Successfully clicked on the element
```

## click
Request: `{"pageId":1,"uid":"0_99999"}`

```
Error: Element uid "0_99999" not found on page 1.
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name" value="Alice"
  uid=1_5 button "Go" focusable focused
  uid=4_0 StaticText "Clicked"
  uid=1_7 form
    uid=1_8 textbox
    uid=1_9 combobox expandable haspopup="menu" value="Alpha"
      uid=1_10 option "Alpha" selectable selected value="Alpha"
      uid=1_11 option "Beta" selectable value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## fill_form
Request: `{"pageId":1,"elements":[{"uid":"1_8","value":"Bob"}]}`

```
Successfully filled out the form
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name" value="Alice"
  uid=1_5 button "Go"
  uid=4_0 StaticText "Clicked"
  uid=1_7 form
    uid=1_8 textbox focusable focused value="Bob"
    uid=1_9 combobox expandable haspopup="menu" value="Alpha"
      uid=1_10 option "Alpha" selectable selected value="Alpha"
      uid=1_11 option "Beta" selectable value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## fill
Request: `{"pageId":1,"uid":"1_9","value":"b"}`

```
Error: Failed to interact with the element with uid 1_9. Could not find option with text "b"
```

## evaluate_script
Request: `{"pageId":1,"function":"() => document.querySelector('#choice').value"}`

```
Script ran on page and returned:
```json
"a"
```
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name" value="Alice"
  uid=1_5 button "Go"
  uid=4_0 StaticText "Clicked"
  uid=1_7 form
    uid=1_8 textbox focusable focused value="Bob"
    uid=1_9 combobox expandable haspopup="menu" value="Alpha"
      uid=1_10 option "Alpha" selectable selected value="Alpha"
      uid=1_11 option "Beta" selectable value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## fill
Request: `{"pageId":1,"uid":"1_9","value":"Beta"}`

```
Successfully filled out the element
```

## press_key
Request: `{"pageId":1,"key":"Enter"}`

```
Successfully pressed key: Enter
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name" value="Alice"
  uid=1_5 button "Go"
  uid=4_0 StaticText "Clicked"
  uid=1_7 form
    uid=1_8 textbox focusable focused value="Bob"
    uid=1_9 combobox expandable haspopup="menu" value="Beta"
      uid=1_10 option "Alpha" selectable value="Alpha"
      uid=1_11 option "Beta" selectable selected value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## hover
Request: `{"pageId":1,"uid":"1_5"}`

```
Successfully hovered over the element
```

## take_screenshot
Request: `{"pageId":1,"format":"png","fullPage":true}`

```
Took a screenshot of the full current page.
[image/png image block, 107084 base64 chars]
```

## list_console_messages
Request: `{"pageId":1}`

```
## Console messages
Showing 1-2 of 2 (Page 1 of 1).
msgid=1 [log] hello from fixture (1 args)
msgid=2 [issue] An element doesn’t have an autocomplete attribute (count: 1)
```

## list_network_requests
Request: `{"pageId":1}`

```
## Network requests
Showing 1-2 of 2 (Page 1 of 1).
reqid=1 GET http://127.0.0.1:43307/ [200]
reqid=2 GET http://127.0.0.1:43307/favicon.ico [200]
```

## get_network_request
Request: `{"pageId":1,"reqid":1}`

```
## Request http://127.0.0.1:43307/
Status: 200
### Request Headers
- upgrade-insecure-requests:1
- user-agent:Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36
- sec-ch-ua:"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"
- sec-ch-ua-mobile:?0
- sec-ch-ua-platform:"Linux"
- accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
- accept-encoding:gzip, deflate, br, zstd
- accept-language:en-US,en;q=0.9
- connection:keep-alive
- host:127.0.0.1:43307
- sec-fetch-dest:document
- sec-fetch-mode:navigate
- sec-fetch-site:none
- sec-fetch-user:?1
### Response Headers
- connection:keep-alive
- content-length:584
- content-type:text/html
- date:Fri, 02 Oct 2026 01:24:17 GMT
- keep-alive:timeout=5
### Response Body
<!doctype html><title>Chrome Fixture</title><h1>Heading</h1><p>Hello fixture</p><label>Name<input id="name"></label><button onclick="document.querySelector('#result').textContent='Clicked'">Go</button><div id="result">Ready</div><form onsubmit="event.preventDefault()"><input id="second"><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select><button>Submit</button></form><input id="file" type="file" multiple><button onclick="prompt('Question','default')">Dialog</button><a href="/next">Next</a><script>console.log('hello from fixture')</script>
```

## get_console_message
Request: `{"pageId":1,"msgid":1}`

```
ID: 1
Message: log> hello from fixture
### Arguments
Arg #0: hello from fixture
### Stack trace
at  (VM7 127.0.0.1:43307:1:9)
Note: line and column numbers use 1-based indexing
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name" value="Alice"
  uid=1_5 button "Go"
  uid=4_0 StaticText "Clicked"
  uid=1_7 form
    uid=1_8 textbox focusable focused value="Bob"
    uid=1_9 combobox expandable haspopup="menu" value="Beta"
      uid=1_10 option "Alpha" selectable value="Alpha"
      uid=1_11 option "Beta" selectable selected value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## get_css_styles
Request: `{"pageId":1,"uid":"1_5"}`

```
Showing 1-1 of 1 (Page 1 of 1).
Styles for button (uid: "1_5"):

  button (user agent stylesheet) {
    appearance: auto;
    font-style: ;
    font-variant-ligatures: ;
    font-variant-caps: ;
    font-variant-numeric: ;
    font-variant-east-asian: ;
    font-variant-alternates: ;
    font-variant-position: ;
    font-variant-emoji: ;
    font-weight: ;
    font-stretch: ;
    font-size: ;
    font-family: ;
    font-optical-sizing: ;
    font-size-adjust: ;
    font-kerning: ;
    font-feature-settings: ;
    font-variation-settings: ;
    font-language-override: ;
    text-rendering: auto;
    color: buttontext;
    letter-spacing: normal;
    word-spacing: normal;
    line-height: normal;
    text-transform: none;
    text-indent: 0px;
    text-shadow: none;
    display: inline-block;
    text-align: center;
    cursor: default;
    box-sizing: border-box;
    background-color: buttonface;
    margin: 0em 0em 0em 0em;
    padding-block: 1px;
    padding-inline: 6px;
    border-width: 2px;
    border-style: outset;
    border-color: buttonborder;
    border-image: none;
  }
```

## new_page
Request: `{"url":"http://127.0.0.1:43307/next"}`

```
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/)
2: Chrome Fixture (http://127.0.0.1:43307/next) [selected]
```

## select_page
Request: `{"pageId":1}`

```
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
2: Chrome Fixture (http://127.0.0.1:43307/next)
```

## close_page
Request: `{"pageId":2}`

```
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```

## wait_for
Request: `{"pageId":1,"text":["Clicked"],"timeout":2000}`

```
Element matching one of ["Clicked"] found.
## Latest page snapshot
uid=1_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=1_1 heading "Heading" level="1"
  uid=1_2 StaticText "Hello fixture"
  uid=1_3 StaticText "Name"
  uid=1_4 textbox "Name" value="Alice"
  uid=1_5 button "Go"
  uid=4_0 StaticText "Clicked"
  uid=1_7 form
    uid=1_8 textbox focusable focused value="Bob"
    uid=1_9 combobox expandable haspopup="menu" value="Beta"
      uid=1_10 option "Alpha" selectable value="Alpha"
      uid=1_11 option "Beta" selectable selected value="Beta"
    uid=1_12 button "Submit"
  uid=1_13 button "Choose Files" value="No file chosen"
  uid=1_14 button "Dialog"
  uid=1_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=1_16 StaticText "Next"

```

## resize_page
Request: `{"pageId":1,"width":640,"height":480}`

```
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```

## emulate
Request: `{"pageId":1,"cpuThrottlingRate":2,"networkConditions":"Fast 3G","viewport":"800x600"}`

```
Emulation configured successfully
Emulating network conditions: Fast 3G
Default navigation timeout set to 100000 ms
Emulating viewport: {"isMobile":false,"hasTouch":false,"isLandscape":false,"width":800,"height":600}
Emulating CPU throttling: 2x slowdown
```

## emulate
Request: `{"pageId":1,"cpuThrottlingRate":1}`

```
Emulation configured successfully
```

## performance_start_trace
Request: `{"pageId":1,"reload":true,"autoStop":false}`

```
The performance trace is being recorded. Use performance_stop_trace to stop it.
```

## performance_stop_trace
Request: `{"pageId":1}`

```
The performance trace has been stopped.
## Summary of Performance trace findings:
URL: http://127.0.0.1:43307/
Trace bounds: {min: 2816863794780µs, max: 2816864838150µs}
CPU throttling: 1x
Network throttling: none

# Available insight sets

The following is a list of insight sets. An insight set covers a specific part of the trace, split by navigations. The insights within each insight set are specific to that part of the trace. Be sure to consider the insight set id and bounds when calling functions. If no specific insight set or navigation is mentioned, assume the user is referring to the first one.

## insight set id: NAVIGATION_0

URL: http://127.0.0.1:43307/
Bounds: {min: 2816863798653µs, max: 2816864838150µs}
Metrics (lab / observed):
  - LCP: 44 ms, event: (eventKey: r-1852, ts: 2816863842820), nodeId: 7
  - LCP breakdown:
    - TTFB: 4 ms, bounds: {min: 2816863798653µs, max: 2816863802515µs}
    - Render delay: 40 ms, bounds: {min: 2816863802515µs, max: 2816863842820µs}
  - CLS: 0.00
Metrics (field / real users): n/a – no data for this page in CrUX
Available insights:
  - insight name: LCPBreakdown
    description: Each [subpart has specific improvement strategies](https://developer.chrome.com/docs/performance/insights/lcp-breakdown). Ideally, most of the LCP time should be spent on loading the resources, not within delays.
    relevant trace bounds: {min: 2816863798653µs, max: 2816863842820µs}
    example question: Help me optimize my LCP score
    example question: Which LCP subpart was most problematic?
    example question: What can I do to reduce the LCP time for this page load?
  - insight name: CharacterSet
    description: A character encoding declaration is required. It can be done with a meta charset tag in the first 1024 bytes of the HTML or in the Content-Type HTTP response header. [Learn more about declaring the character encoding](https://developer.chrome.com/docs/insights/charset/).
    relevant trace bounds: {min: 2816863799603µs, max: 2816863819165µs}
    example question: How do I declare a character encoding for my page?

## Details on call tree & network request formats:
Information on performance traces may contain main thread activity represented as call frames and network requests.

Each call frame is presented in the following format:

'id;eventKey;name;duration;selfTime;urlIndex;childRange;[line];[column];[S]'

Key definitions:

* id: A unique numerical identifier for the call frame. Never mention this id in the output to the user.
* eventKey: String that uniquely identifies this event in the flame chart.
* name: A concise string describing the call frame (e.g., 'Evaluate Script', 'render', 'fetchData').
* duration: The total execution time of the call frame, including its children.
* selfTime: The time spent directly within the call frame, excluding its children's execution.
* urlIndex: Index referencing the "All URLs" list. Empty if no specific script URL is associated.
* childRange: Specifies the direct children of this node using their IDs. If empty ('' or 'S' at the end), the node has no children. If a single number (e.g., '4'), the node has one child with that ID. If in the format 'firstId-lastId' (e.g., '4-5'), it indicates a consecutive range of child IDs from 'firstId' to 'lastId', inclusive.
* line: An optional field for a call frame's line number. This is where the function is defined.
* column: An optional field for a call frame's column number. This is where the function is defined.
* S: _Optional_. The letter 'S' terminates the line if that call frame was selected by the user.

Example Call Tree:

1;r-123;main;500;100;0;1;;
2;r-124;update;200;50;;3;0;1;
3;p-49575-15428179-2834-374;animate;150;20;0;4-5;0;1;S
4;p-49575-15428179-3505-1162;calculatePosition;80;80;0;1;;
5;p-49575-15428179-5391-2767;applyStyles;50;50;0;1;;


Network requests are formatted like this:
`urlIndex;eventKey;queuedTime;requestSentTime;downloadCompleteTime;processingCompleteTime;totalDuration;downloadDuration;mainThreadProcessingDuration;statusCode;mimeType;priority;initialPriority;finalPriority;renderBlocking;protocol;fromServiceWorker;initiators;redirects:[[redirectUrlIndex|startTime|duration]];responseHeaders:[header1Value|header2Value|...]`

- `urlIndex`: Numerical index for the request's URL, referencing the "All URLs" list.
- `eventKey`: String that uniquely identifies this request's trace event.
Timings (all in milliseconds, relative to navigation start):
- `queuedTime`: When the request was queued.
- `requestSentTime`: When the request was sent.
- `downloadCompleteTime`: When the download completed.
- `processingCompleteTime`: When main thread processing finished.
Durations (all in milliseconds):
- `totalDuration`: Total time from the request being queued until its main thread processing completed.
- `downloadDuration`: Time spent actively downloading the resource.
- `mainThreadProcessingDuration`: Time spent on the main thread after the download completed.
- `statusCode`: The HTTP status code of the response (e.g., 200, 404).
- `mimeType`: The MIME type of the resource (e.g., "text/html", "application/javascript").
- `priority`: The final network request priority (e.g., "VeryHigh", "Low").
- `initialPriority`: The initial network request priority.
- `finalPriority`: The final network request priority (redundant if `priority` is always final, but kept for clarity if `initialPriority` and `priority` differ).
- `renderBlocking`: 't' if the request was render-blocking, 'f' otherwise.
- `protocol`: The network protocol used (e.g., "h2", "http/1.1").
- `fromServiceWorker`: 't' if the request was served from a service worker, 'f' otherwise.
- `initiators`: A list (separated by ,) of URL indices for the initiator chain of this request. Listed in order starting from the root request to the request that directly loaded this one. This represents the network dependencies necessary to load this request. If there is no initiator, this is empty.
- `redirects`: A comma-separated list of redirects, enclosed in square brackets. Each redirect is formatted as
`[redirectUrlIndex|startTime|duration]`, where: `redirectUrlIndex`: Numerical index for the redirect's URL. `startTime`: The start time of the redirect in milliseconds, relative to navigation start. `duration`: The duration of the redirect in milliseconds.
- `responseHeaders`: A list (separated by '|') of values for specific, pre-defined response headers, enclosed in square brackets.
The order of headers corresponds to an internal fixed list. If a header is not present, its value will be empty.

```

## performance_analyze_insight
Request: `{"pageId":1,"insightSetId":"NAVIGATION_0","insightName":"LCPBreakdown"}`

```
## Insight Title: LCP breakdown

## Insight Summary:
This insight is used to analyze the time spent that contributed to the final LCP time and identify which of the 4 subparts (or 2 if there was no LCP resource) are contributing most to the delay in rendering the LCP element.

## Detailed analysis:
The Largest Contentful Paint (LCP) time for this navigation was 44 ms.
The LCP element (BODY, nodeId: 7) is text and was not fetched from the network.

We can break this time down into the 2 subparts that combine to make the LCP time:

- Time to first byte: 4 ms (8.7% of total LCP time)
- Element render delay: 40 ms (91.3% of total LCP time)

## Estimated savings: none

## External resources:
- https://developer.chrome.com/docs/performance/insights/lcp-breakdown
- https://web.dev/articles/lcp
- https://web.dev/articles/optimize-lcp
```

## navigate_page
Request: `{"pageId":1,"type":"reload"}`

```
Successfully reloaded the page.
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```

## navigate_page
Request: `{"pageId":1,"url":"http://127.0.0.1:43307/next"}`

```
Successfully navigated to http://127.0.0.1:43307/next.
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/next) [selected]
```

## navigate_page
Request: `{"pageId":1,"type":"back"}`

```
Successfully navigated back to http://127.0.0.1:43307/.
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```

## navigate_page
Request: `{"pageId":1,"type":"forward"}`

```
Successfully navigated forward to http://127.0.0.1:43307/next.
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/next) [selected]
```

## navigate_page
Request: `{"pageId":1,"url":"http://127.0.0.1:43307/"}`

```
Successfully navigated to http://127.0.0.1:43307/.
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=10_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=10_1 heading "Heading" level="1"
  uid=10_2 StaticText "Hello fixture"
  uid=10_3 StaticText "Name"
  uid=10_4 textbox "Name"
  uid=10_5 button "Go"
  uid=10_6 StaticText "Ready"
  uid=10_7 form
    uid=10_8 textbox
    uid=10_9 combobox expandable haspopup="menu" value="Alpha"
      uid=10_10 option "Alpha" selectable selected value="Alpha"
      uid=10_11 option "Beta" selectable value="Beta"
    uid=10_12 button "Submit"
  uid=10_13 button "Choose Files" value="No file chosen"
  uid=10_14 button "Dialog"
  uid=10_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=10_16 StaticText "Next"

```

## upload_file
Request: `{"pageId":1,"uid":"10_13","filePaths":["/home/arthur/Code/pi-orche/browser/package.json"]}`

```
File uploaded from /home/arthur/Code/pi-orche/browser/package.json.
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=10_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=10_1 heading "Heading" level="1"
  uid=10_2 StaticText "Hello fixture"
  uid=10_3 StaticText "Name"
  uid=10_4 textbox "Name"
  uid=10_5 button "Go"
  uid=10_6 StaticText "Ready"
  uid=10_7 form
    uid=10_8 textbox
    uid=10_9 combobox expandable haspopup="menu" value="Alpha"
      uid=10_10 option "Alpha" selectable selected value="Alpha"
      uid=10_11 option "Beta" selectable value="Beta"
    uid=10_12 button "Submit"
  uid=10_13 button "Choose Files" value="package.json"
  uid=10_14 button "Dialog"
  uid=10_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=10_16 StaticText "Next"

```

## click
Request: `{"pageId":1,"uid":"10_14"}`

```
The element was clicked and it opened a dialog.
# Open dialog
prompt: Question (default value: "default").
Call handle_dialog to handle it before continuing.
```

## handle_dialog
Request: `{"pageId":1,"action":"accept","promptText":"Answer"}`

```
Successfully accepted the dialog
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```

## handle_dialog
Request: `{"pageId":1,"action":"dismiss"}`

```
Error: No open dialog found
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=10_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=10_1 heading "Heading" level="1"
  uid=10_2 StaticText "Hello fixture"
  uid=10_3 StaticText "Name"
  uid=10_4 textbox "Name"
  uid=10_5 button "Go"
  uid=10_6 StaticText "Ready"
  uid=10_7 form
    uid=10_8 textbox
    uid=10_9 combobox expandable haspopup="menu" value="Alpha"
      uid=10_10 option "Alpha" selectable selected value="Alpha"
      uid=10_11 option "Beta" selectable value="Beta"
    uid=10_12 button "Submit"
  uid=10_13 button "Choose Files" value="package.json"
  uid=10_14 button "Dialog" focusable focused
  uid=10_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=10_16 StaticText "Next"

```

## click
Request: `{"pageId":1,"uid":"10_4"}`

```
Successfully clicked on the element
```

## type_text
Request: `{"pageId":1,"text":" Native","submitKey":"Tab"}`

```
Typed text " Native + Tab"
```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=10_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=10_1 heading "Heading" level="1"
  uid=10_2 StaticText "Hello fixture"
  uid=10_3 StaticText "Name"
  uid=10_4 textbox "Name" value=" Native"
  uid=10_5 button "Go" focusable focused
  uid=10_6 StaticText "Ready"
  uid=10_7 form
    uid=10_8 textbox
    uid=10_9 combobox expandable haspopup="menu" value="Alpha"
      uid=10_10 option "Alpha" selectable selected value="Alpha"
      uid=10_11 option "Beta" selectable value="Beta"
    uid=10_12 button "Submit"
  uid=10_13 button "Choose Files" value="package.json"
  uid=10_14 button "Dialog"
  uid=10_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=10_16 StaticText "Next"

```

## take_snapshot
Request: `{"pageId":1}`

```
## Latest page snapshot
uid=10_0 RootWebArea "Chrome Fixture" url="http://127.0.0.1:43307/"
  uid=10_1 heading "Heading" level="1"
  uid=10_2 StaticText "Hello fixture"
  uid=10_3 StaticText "Name"
  uid=10_4 textbox "Name" value=" Native"
  uid=10_5 button "Go" focusable focused
  uid=10_6 StaticText "Ready"
  uid=10_7 form
    uid=10_8 textbox
    uid=10_9 combobox expandable haspopup="menu" value="Alpha"
      uid=10_10 option "Alpha" selectable selected value="Alpha"
      uid=10_11 option "Beta" selectable value="Beta"
    uid=10_12 button "Submit"
  uid=10_13 button "Choose Files" value="package.json"
  uid=10_14 button "Dialog"
  uid=10_15 link "Next" url="http://127.0.0.1:43307/next"
    uid=10_16 StaticText "Next"

```

## drag
Request: `{"pageId":1,"from_uid":"10_5","to_uid":"10_12"}`

```
Successfully dragged an element
```

## take_heapsnapshot
Request: `{"pageId":1,"filePath":"/home/arthur/Code/pi-orche/browser/scripts/discovery.heapsnapshot"}`

```
Heap snapshot saved to /home/arthur/Code/pi-orche/browser/scripts/discovery.heapsnapshot
```

## lighthouse_audit
Request: `{"pageId":1,"mode":"snapshot","outputDirPath":"/home/arthur/Code/pi-orche/browser/scripts/discovery-lighthouse"}`

```
## Lighthouse Audit Results
Mode: snapshot
Device: desktop
URL: http://127.0.0.1:43307/
### Category Scores
- Accessibility: 57.99999999999999 (accessibility)
- Best Practices: 100 (best-practices)
- SEO: 60 (seo)
- Agentic Browsing: 0 (agentic-browsing)
### Audit Summary
Passed: 13
Failed: 9
Total Timing: 1693.7ms
### Reports
- /home/arthur/Code/pi-orche/browser/scripts/discovery-lighthouse/report.json
- /home/arthur/Code/pi-orche/browser/scripts/discovery-lighthouse/report.html
```

## close_page
Request: `{"pageId":1}`

```
The last open page cannot be closed. It is fine to keep it open.
## Pages
1: Chrome Fixture (http://127.0.0.1:43307/) [selected]
```
