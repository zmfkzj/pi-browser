import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BROWSER_CONFIG, type BrowserConfig, type ChromeConfig } from '../src/config.js';
import { ChromeEngine, buildChromeArgs, buildChromeEnv, chromeAvailability, decodeChromeEvaluation, parseChromeSnapshot } from '../src/engines/chrome.js';
import { UnsupportedOperationError } from '../src/engine.js';
import { decodeEvaluation, wrapExpression } from '../src/evaluate.js';
import { restoreStorageState, applyPendingStorage, type PendingStorage } from '../src/state.js';
const fake = fileURLToPath(new URL('./helpers/fake-chrome-mcp.mjs', import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const config = (chrome: Partial<ChromeConfig> = {}): BrowserConfig => ({ ...DEFAULT_BROWSER_CONFIG, timeoutMs: 2000, evaluateTimeoutMs: 2000, chrome: { ...DEFAULT_BROWSER_CONFIG.chrome, ...chrome } });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'chrome-fake-'));
  const record = join(cwd, 'calls.jsonl');
  const engine = new ChromeEngine({ config: config(), cwd, launch: () => spawn(process.execPath, [fake], { stdio: 'pipe', detached: true, env: { ...process.env, CHROME_FAKE_RECORD: record } }) });
  cleanup.push(async () => { await engine.stop(); await rm(cwd, {recursive:true,force:true}); });
  const calls = async () => (await readFile(record,'utf8')).trim().split('\n').map(line => JSON.parse(line) as {name:string;args:Record<string,unknown>});
  const summary = () => engine.summarize({maxChars:4000});
  const ref = async (label: string) => (await summary()).elements!.find(e => e.label === JSON.stringify(label))!.ref;
  const evaluate = async (expression: string) => JSON.parse(decodeEvaluation(await engine.evaluate(wrapExpression(expression)))).value;
  await engine.navigate('http://127.0.0.1:3000/',{});
  return {engine,cwd,calls,summary,ref,evaluate};
}
describe('Chrome MCP mapping (real stdio fake)', () => {
  it('navigates, parses interactive uid roles and combines one snapshot with one bounded evaluation', async () => {
    const {engine,calls} = await fixture();
    expect(await engine.navigate('https://example.com/',{waitUntil:'networkidle0'})).toBe('Navigated (chrome) to https://example.com/ — "Chrome Fixture"');
    const before = (await calls()).length;
    const page = await engine.summarize({maxChars:15,limit:2});
    expect(page).toMatchObject({url:'https://example.com/',title:'Chrome Fixture',text:'Heading\nHello f'});
    expect(page.elements).toHaveLength(2);
    expect(page.elements![0]).toMatchObject({ref:expect.stringMatching(/^\d+_\d+$/),kind:'textbox',label:'"Name"'});
    expect((await calls()).slice(before).map(c=>c.name)).toEqual(['take_snapshot','evaluate_script']);
    expect((await calls()).filter(c=>c.name==='navigate_page').at(-1)?.args).toEqual({pageId:1,url:'https://example.com/',timeout:2000});
    expect((await engine.summarize({maxChars:10,includeInteractive:false})).elements).toBeUndefined();
  });
  it('maps native ref fill/click and surfaces the real stale uid error with refresh guidance', async () => {
    const {engine,ref,evaluate,calls} = await fixture();
    await engine.fill({ref:await ref('Name')},'Alice');
    expect(await evaluate("document.getElementById('name').value")).toBe('Alice');
    const go=await ref('Go');
    expect(await engine.click({ref:go})).toContain('Successfully clicked');
    expect(await evaluate("document.getElementById('result').textContent")).toBe('Clicked');
    await expect(engine.click({ref:go})).rejects.toThrow(`Element uid "${go}" not found on page 1.`);
    await expect(engine.click({ref:go})).rejects.toThrow('call browser_snapshot and use a ref');
    await expect(engine.click({ref:'e2'})).rejects.toThrow('snapshot uid');
    await engine.click({ref:await ref('Go')});
    expect((await calls()).find(c=>c.name==='fill')?.args).toMatchObject({pageId:1,value:'Alice',uid:expect.any(String)});
  });
  it('emulates selector fill/click and select by value OR label, with truthful headlines', async () => {
    const {engine,evaluate,ref} = await fixture();
    expect(await engine.fill({selector:'#name'},'Alice')).toContain('selector fill emulated via script');
    expect(await engine.click({selector:'#go'})).toContain('selector click emulated via script; prefer refs on chrome');
    expect(await evaluate("document.getElementById('name').value")).toBe('Alice');
    expect(await engine.select({selector:'#choice'},'b')).toContain('select emulated');
    expect(await evaluate("document.getElementById('choice').value")).toBe('b');
    await engine.select({ref:await ref('Choice')},'Alpha');
    expect(await evaluate("document.getElementById('choice').value")).toBe('a');
    await expect(engine.fill({selector:'#missing'},'no')).rejects.toThrow('Element not found');
    await expect(engine.select({selector:'#choice'},'missing')).rejects.toThrow('Option not found');
  });
  it('fills mixed native/script forms, clicks submit and implements type as fill plus Enter', async () => {
    const {engine,ref,calls,evaluate} = await fixture();
    const name=await ref('Name');
    await engine.fillForm([{ref:name,value:'Alice'},{selector:'#second',value:'Bob'},{selector:'#choice',value:'b',type:'select'}],{selector:'#submit'});
    expect((await calls()).find(c=>c.name==='fill_form')?.args).toEqual({pageId:1,elements:[{uid:name,value:'Alice'}]});
    expect(await evaluate("document.getElementById('result').textContent")).toBe('Submitted');
    expect(await engine.type({selector:'#name'},'New',true)).toContain('Chrome type is implemented as fill + Enter');
    expect(await evaluate("document.getElementById('name').value")).toBe('New');
    expect((await calls()).at(-2)?.name).toBe('press_key');
    await engine.pressKey('Tab',{ref:await ref('Name')});
    await engine.pressKey('Escape',{selector:'#name'});
    await engine.pressKey('Enter');
    expect((await calls()).at(-1)?.args).toEqual({pageId:1,key:'Enter'});
  });
  it.each(['selector','ref'] as const)('focuses the %s type/pressKey target before sending the native key (regression)',async mode=> {
    const {engine,ref,calls,evaluate}=await fixture();
    const target=mode==='selector' ? {selector:'#second'} : {ref:await ref('Second')};
    await engine.pressKey('End',{selector:'#go'});
    expect(await evaluate('document.activeElement.id')).toBe('go');
    await engine.type(target,'Bob',true);
    const typed=await calls();
    expect(typed.at(-1)).toMatchObject({name:'press_key',args:{pageId:1,key:'Enter'}});
    expect(typed.at(-2)).toMatchObject({name:'evaluate_script',args:{function:expect.stringContaining('el.focus()')}});
    expect(await evaluate('document.activeElement.id')).toBe('second');
    expect(await evaluate("document.getElementById('result').textContent")).toBe('Submitted');
    if(mode==='selector') expect(await evaluate('document.activeElement.selectionEnd')).toBe(3);
    await engine.pressKey('End',{selector:'#go'});
    await engine.pressKey('End',target);
    const keyed=await calls();
    expect(keyed.at(-1)).toMatchObject({name:'press_key',args:{key:'End'}});
    expect(keyed.at(-2)).toMatchObject({name:'evaluate_script',args:{function:expect.stringContaining('el.focus()')}});
    expect(await evaluate('document.activeElement.id')).toBe('second');
  });
  it.each(['up','down','left','right','top','bottom'])('emulates %s scrolling on page and a target', async direction => {
    const {engine,calls,ref}=await fixture();
    expect(await engine.scroll({direction,amount:120})).toContain('emulated via script');
    await engine.scroll({direction,target:{ref:await ref('Name')}});
    expect((await calls()).at(-1)?.args).toMatchObject({pageId:1,args:[expect.any(String)]});
  });
  it('waits by native text array, polls selector until present, times out, and honors abort', async () => {
    const {engine,calls}=await fixture();
    expect(await engine.waitFor({text:'Hello fixture',timeoutMs:100})).toContain('Element matching one of ["Hello fixture"] found');
    expect((await calls()).at(-1)?.args).toEqual({pageId:1,text:['Hello fixture'],timeout:100});
    expect(await engine.waitFor({selector:'#later',timeoutMs:800})).toContain('Found selector');
    const start=Date.now();
    await expect(engine.waitFor({selector:'#never',timeoutMs:60})).rejects.toThrow('Timed out after 60 ms');
    expect(Date.now()-start).toBeGreaterThanOrEqual(50);
    const controller=new AbortController();
    const wait=engine.waitFor({selector:'#never',timeoutMs:2000},controller.signal);
    setTimeout(()=>controller.abort(),30);
    await expect(wait).rejects.toThrow(/abort/i);
  });
  it('resizes before PNG screenshot, passes fullPage and returns image bytes', async () => {
    const {engine,calls}=await fixture();
    const {png,text}=await engine.screenshot({width:320,height:200,fullPage:true});
    expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(text).toContain('full current page');
    expect((await calls()).at(-2)).toEqual({name:'resize_page',args:{pageId:1,width:320,height:200},order:expect.any(Number)});
    expect((await calls()).at(-1)?.args).toEqual({pageId:1,format:'png',fullPage:true});
    await engine.screenshot({height:400});
    expect((await calls()).at(-2)?.args).toEqual({pageId:1,width:320,height:400});
  });
  it('decodes exactly one upstream string quoting layer for wrapped evaluations and errors', async () => {
    const {evaluate}=await fixture();
    expect(await evaluate('({ok:true,n:42})')).toEqual({ok:true,n:42});
    expect(await evaluate('"quotes \\\" and newline\\n"')).toBe('quotes " and newline\n');
    expect(await evaluate('undefined')).toBeNull();
    await expect(evaluate('(() => { throw new Error("expected"); })()')).rejects.toThrow('expected');
  });
  it('renders deterministic markdown, links, search contexts, array/attribute schema and form fields through vm', async () => {
    const {engine}=await fixture();
    const markdown=await engine.markdown(4000);
    expect(markdown).toContain('# Heading'); expect(markdown).toContain('Hello fixture');
    expect(markdown).toContain('- Item'); expect(markdown).toContain('[Next](http://127.0.0.1:3000/next)');
    expect(markdown).toContain('```\nconst ok = true;\n```');
    expect((await engine.markdown(9)).length).toBe(9);
    expect(JSON.parse(await engine.links(10,true))).toEqual([{text:'Next',href:'http://127.0.0.1:3000/next'}]);
    expect(JSON.parse(await engine.links(1,false))).toHaveLength(1);
    expect(JSON.parse(await engine.search({query:'HELLO',contextChars:2,limit:1}))).toEqual([{index:8,context:'g\nHello f'}]);
    expect(JSON.parse(await engine.search({query:'HELLO',caseSensitive:true}))).toEqual([]);
    expect(JSON.parse(await engine.extract({'links[]':'a@href',heading:'h1',missing:'#missing'}))).toEqual({links:['http://127.0.0.1:3000/next','https://external.example/'],heading:'Heading',missing:null});
    expect(JSON.parse(await engine.forms())[0]).toMatchObject({id:'form',fields:[{name:'second',type:'text',label:'Second'},{name:'choice',type:'select-one',label:'Choice'},{name:'submit',type:'submit',label:'Submit'}]});
  });
  it('maps console, network list and detail by numeric id or latest matching URL', async () => {
    const {engine,calls}=await fixture();
    expect(await engine.consoleMessages()).toContain('msgid=1 [log] hello from page');
    expect(await engine.networkRequests()).toContain('reqid=1 GET http://127.0.0.1:3000/');
    expect(await engine.networkRequest('reqid=1')).toContain('Response Body');
    await engine.networkRequest('http://127.0.0.1:3000/');
    expect((await calls()).at(-1)?.args).toEqual({pageId:1,reqid:1});
    await expect(engine.networkRequest('https://missing.example/')).rejects.toThrow('list network requests first');
  });
  it('maps numeric page ids, history navigation and closeAll retaining only a NEW neutral page', async () => {
    const {engine,calls}=await fixture();
    expect(await engine.tabs('new',{url:'http://127.0.0.1:3000/next'})).toContain('2: Chrome Fixture');
    expect(await engine.tabs('list',{})).toContain('2: Chrome Fixture (http://127.0.0.1:3000/next) [selected]');
    await engine.tabs('switch',{tabId:'1'});
    await engine.navigate('http://127.0.0.1:3000/again',{});
    for(const type of ['back','forward','reload'] as const) {await engine.tabs(type,{});expect((await calls()).at(-1)?.args).toEqual({pageId:1,type,timeout:2000});}
    await engine.tabs('close',{tabId:'2'});
    await expect(engine.tabs('switch',{tabId:'tab-1'})).rejects.toThrow('numeric page id');
    await engine.closeAll();
    expect(await engine.tabs('list',{})).toBe('## Pages\n3: about:blank [selected]');
  });
  it('maps hover/upload selector-to-uid, validates files and handles dialogs/emulation/performance', async () => {
    const {engine,cwd,calls,ref}=await fixture();
    await engine.hover({ref:await ref('Go')});
    await engine.hover({selector:'#go'});
    expect((await calls()).at(-1)?.args).toMatchObject({pageId:1,uid:expect.any(String)});
    await writeFile(join(cwd,'upload.txt'),'upload');
    await engine.upload({selector:'#file'},['upload.txt']);
    expect((await calls()).at(-1)?.args).toMatchObject({filePaths:[join(cwd,'upload.txt')],uid:expect.any(String)});
    await expect(engine.upload({selector:'#file'},[])).rejects.toThrow('paths must be non-empty');
    await expect(engine.upload({selector:'#file'},['missing'])).rejects.toThrow();
    await expect(engine.dialog('dismiss')).rejects.toThrow('No open dialog found');
    await engine.click({ref:await ref('Dialog')});
    await engine.dialog('accept','yes');expect((await calls()).at(-1)?.args).toEqual({pageId:1,action:'accept',promptText:'yes'});
    await engine.click({ref:await ref('Dialog')});
    await engine.dialog('dismiss');
    await engine.emulate({cpu:4,network:'Slow 4G',viewport:'800x600'});
    expect((await calls()).at(-1)?.args).toEqual({pageId:1,cpuThrottlingRate:4,networkConditions:'Slow 4G',viewport:'800x600'});
    await expect(engine.perf({action:'insight',insightName:'LCPBreakdown'})).rejects.toThrow('Stop a performance trace first');
    await engine.perf({action:'start',reload:true,autoStop:false});
    expect((await calls()).at(-1)?.args).toEqual({pageId:1,reload:true,autoStop:false});
    await engine.perf({action:'stop'});
    await engine.perf({action:'insight',insightName:'LCPBreakdown'});
    expect((await calls()).at(-1)?.args).toEqual({pageId:1,insightName:'LCPBreakdown',insightSetId:'NAVIGATION_0'});
    await expect(engine.perf({action:'insight'})).rejects.toThrow('requires insightName');
  });
  it('reports unsupported pdf/cookies/export naming obscura and partial storage import applies scripts', async () => {
    const {engine,evaluate}=await fixture();
    for(const fn of [()=>engine.pdf({}),()=>engine.cookies(),()=>engine.setCookie({name:'n',value:'v',domain:'example.com'}),()=>engine.clearCookies(),()=>engine.storageState()]) {
      await expect(fn()).rejects.toBeInstanceOf(UnsupportedOperationError);
      await expect(fn()).rejects.toThrow('Use engine "obscura"');
    }
    expect(await engine.setStorageState({})).toBe('cookies skipped on chrome (not supported); storage entries are applied by script');
    const pending:PendingStorage=new Map();
    const report=await restoreStorageState(engine,{cookies:[{name:'skip'}],origins:[{origin:'http://127.0.0.1:3000',localStorage:[['k','v']],sessionStorage:[['s','1']]},{origin:'https://other.example',localStorage:[['later','yes']]}]},{pending});
    expect(report).toMatchObject({cookies:0,storageApplied:2,queuedOrigins:['https://other.example']});
    expect(report.text).toContain('cookies skipped on chrome');
    expect(await evaluate('[localStorage.getItem("k"),sessionStorage.getItem("s")]')).toEqual(['v','1']);
    await engine.navigate('https://other.example/page',{});
    expect(await applyPendingStorage(engine,pending)).toContain('Applied 1 queued storage entries');
    expect(await evaluate('localStorage.getItem("later")')).toBe('yes');
  });
  it('cancels a never-replying native text wait, reaps its process and recovers without replay',async ()=> {
    const {engine,calls}=await fixture();const pid=engine.status().pid!;
    const controller=new AbortController();const waiting=engine.waitFor({text:'#never',timeoutMs:3000},controller.signal);
    setTimeout(()=>controller.abort(),50);await expect(waiting).rejects.toThrow(/abort|terminated/i);
    await expect.poll(()=>{try{process.kill(pid,0);return true;}catch{return false;}}).toBe(false);
    await engine.navigate('http://127.0.0.1:3000/recovered',{});expect(engine.status().pid).not.toBe(pid);
    expect((await calls()).filter(c=>c.name==='wait_for')).toHaveLength(1);
  });
  it('is lazy, reports flags/headless and pid, restarts with fresh page and kills detached children', async () => {
    const {engine}=await fixture();
    const pid=engine.status().pid!;expect(engine.status()).toMatchObject({running:true,pid,detail:expect.stringContaining('--workspace')});
    await engine.restart();expect(engine.status().pid).not.toBe(pid);
    expect(()=>process.kill(pid,0)).toThrow();
    expect(await engine.tabs('list',{})).toContain('about:blank');
    const next=engine.status().pid!;await engine.stop();expect(engine.status().running).toBe(false);expect(()=>process.kill(next,0)).toThrow();
  });
});
describe('Chrome availability and launch policy', () => {
  const overrides={exists:()=>false,resolveServer:()=>'/server.js',pathDirs:['/fake']};
  it('rejects disabled Chrome before resolving package',()=>expect(chromeAvailability(config({enabled:false}),{},overrides)).toEqual({ok:false,reason:'chrome engine disabled in config'}));
  it('provides install remediation for a missing package',()=>expect(chromeAvailability(config(),{}, {...overrides,resolveServer:()=>{throw Error('missing');}}).reason).toContain('run npm install in the pi-browser package'));
  it('provides executable/browserUrl remediation for missing Chrome',()=>expect(chromeAvailability(config(),{},overrides).reason).toBe('Google Chrome not found; install Chrome or set chrome.executablePath / chrome.browserUrl'));
  it('accepts only an existing explicit executable, otherwise fails even with browserUrl',()=> {
    expect(chromeAvailability(config({executablePath:'/chrome'}),{}, {...overrides,exists:p=>p==='/chrome'})).toMatchObject({ok:true,executablePath:'/chrome'});
    expect(chromeAvailability(config({executablePath:'/missing',browserUrl:'http://localhost:9222'}),{},overrides).ok).toBe(false);
  });
  it('accepts attach URL without probing, discovers PATH, macOS and Windows paths',()=> {
    expect(chromeAvailability(config({browserUrl:'http://localhost:9222'}),{},overrides)).toMatchObject({ok:true,detail:'attached to http://localhost:9222'});
    expect(chromeAvailability(config(),{PATH:'/fake'}, {...overrides,exists:p=>p==='/fake/google-chrome'})).toMatchObject({ok:true,executablePath:'/fake/google-chrome'});
    expect(chromeAvailability(config(),{}, {...overrides,platform:'darwin',exists:p=>p.startsWith('/Applications/')})).toMatchObject({ok:true});
    expect(chromeAvailability(config(),{ProgramFiles:'/programs'}, {...overrides,platform:'win32',exists:p=>p==='/programs/Google/Chrome/Application/chrome.exe'})).toMatchObject({ok:true});
  });
  it('uses real flags, auto headless display rule and minimal env',()=> {
    expect(buildChromeArgs(config({isolated:true,viewport:'900x700',executablePath:'/chrome',args:['--chrome-arg=--disable-gpu']}),{})).toEqual(['--headless','--isolated','--executablePath','/chrome','--viewport','900x700','--no-usage-statistics','--no-performance-crux','--chrome-arg=--disable-gpu']);
    expect(buildChromeArgs(config(),{DISPLAY:':0'})).not.toContain('--headless');
    expect(buildChromeArgs(config(),{WAYLAND_DISPLAY:'wayland-0'})).not.toContain('--headless');
    expect(buildChromeArgs(config({headless:true}),{DISPLAY:':0'})).toContain('--headless');
    expect(buildChromeArgs(config({headless:false}),{})).not.toContain('--headless');
    expect(buildChromeArgs(config({browserUrl:'http://localhost:9222'}),{})).not.toContain('--channel');
    expect(buildChromeEnv({PATH:'/bin',HOME:'/home',DISPLAY:':0',LANG:'en',CHROME_TEST:'yes',PUPPETEER_TEST:'yes',SECRET:'no',NODE_OPTIONS:'no'})).toEqual({PATH:'/bin',HOME:'/home',DISPLAY:':0',LANG:'en',CHROME_TEST:'yes',PUPPETEER_TEST:'yes'});
  });
  it('parses roles and fenced object/string output without treating static text as interactive',()=> {
    expect(parseChromeSnapshot('uid=1_0 RootWebArea "Title"\n uid=1_1 button "Go" focusable\n uid=1_2 StaticText "Hello"\n uid=1_3 generic "Custom" clickable')).toEqual([{ref:'1_1',kind:'button',label:'"Go"'},{ref:'1_3',kind:'generic',label:'"Custom"'}]);
    const roles='button link textbox searchbox combobox listbox option checkbox radio switch slider spinbutton menuitem tab'.split(' ');
    expect(parseChromeSnapshot(roles.map((role,i)=>`uid=2_${i} ${role} "${role}"`).join('\n')).map(e=>e.kind)).toEqual(roles);
    expect(decodeChromeEvaluation('Script ran on page and returned:\n```json\n"string"\n```')).toBe('string');
    expect(()=>decodeChromeEvaluation('not json')).toThrow('invalid JSON');
  });
});
