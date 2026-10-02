import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage as reply } from '@earendil-works/pi-ai';
import { createHarness, tool, type Harness } from './helpers/harness.js';
const chromeBin=process.env.PI_BROWSER_CHROME_BIN ?? '/usr/bin/google-chrome';
let available=false;
try { accessSync(chromeBin,constants.X_OK);available=true; } catch { /* No downloads, ever. */ }
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
function pgrep(args:string[]) {try{return execFileSync('pgrep',args,{encoding:'utf8'}).trim();}catch(error){if((error as {status?:number}).status===1)return '';throw error;}}

describe.skipIf(!available || process.env.PI_BROWSER_SKIP_CHROME_E2E==='1')('real Chrome + chrome-devtools-mcp 1.10.1 E2E',()=> {
  it('runs the curated workflow and storage workaround, then kills its isolated server/browser process groups',async ()=> {
    const server=createServer((request,response)=> {
      response.writeHead(200,{'Content-Type':'text/html'});
      if(request.url==='/next') {response.end('<!doctype html><title>Chrome Next</title><h1>Next page</h1><a href="/">Back</a>');return;}
      response.end(`<!doctype html><html><head><title>Pi Chrome Fixture</title></head><body>
        <h1>Chrome fixture</h1><label for="name">Name</label><input id="name" name="name">
        <button id="go" onclick="document.getElementById('result').textContent='Clicked '+document.getElementById('name').value">Go</button>
        <div id="result">Ready</div><form onsubmit="event.preventDefault();document.getElementById('submitted').textContent='Submitted'">
        <label for="second">Second</label><input id="second" name="second"><button type="submit">Submit</button></form>
        <div id="submitted">Not submitted</div><input id="file" type="file" multiple>
        <button onclick="prompt('Question?')">Dialog</button><a href="/next">Next</a>
        <div style="height:1600px">Tall content</div><script>console.log('hello from chrome fixture');</script></body></html>`);
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();if(!address || typeof address==='string')throw Error('No fixture port');
    const url=`http://127.0.0.1:${address.port}/`,origin=new URL(url).origin;
    let h:Harness|undefined;
    const pids:number[]=[],profiles=new Set<string>();
    const profileList=()=>[...pgrep(['-af','[c]hrome.*--user-data-dir']).matchAll(/--user-data-dir=(\S+)/g)].map(m=>m[1]!);
    const baselineProfiles=new Set(profileList());
    const serverPids=()=>pgrep(['-f','[c]hrome-devtools-mcp']).split('\n').filter(Boolean);
    const baselineServerPids=new Set(serverPids());
    const remember=()=> {
      const pid=h!.manager.require().status().pid!;if(!pids.includes(pid))pids.push(pid);
      // Puppeteer may launch Chrome in its own group; track newly created profile paths too.
      for(const profile of profileList())if(!baselineProfiles.has(profile))profiles.add(profile);
    };
    try {
      h=await createHarness({config:{exposure:'direct',artifactsDir:'artifacts',timeoutMs:15000,evaluateTimeoutMs:10000,chrome:{headless:true,isolated:true,executablePath:chromeBin}},extension:{launchChrome:undefined,engineAvailability:{},install:async()=>{throw Error('Never install in Chrome E2E');}}});
      const results=()=>h!.session.messages.filter(m=>m.role==='toolResult');
      const run=async(name:string,args:Parameters<typeof tool>[1]={},allowError=false)=> {
        h!.main.faux.setResponses([tool(name,args),reply('done')]);await h!.session.prompt(`Call ${name}`);
        const result=results().at(-1)!;
        if(!allowError)expect(result.isError,JSON.stringify(result.content)).toBe(false);
        return result;
      };
      const text=(result:Awaited<ReturnType<typeof run>>)=>result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
      const evaluate=async(expression:string)=>JSON.parse(text(await run('browser_evaluate',{expression}))).value;
      let navigated=await run('browser_navigate',{url,engine:'chrome'},true);
      // One retry covers a cold Chrome startup or transient first fixture navigation.
      if(navigated.isError)navigated=await run('browser_navigate',{url,engine:'chrome'});
      expect(navigated.isError).toBe(false);remember();
      const summary=text(navigated);
      expect(summary).toContain(`URL: ${url} | Title: Pi Chrome Fixture | engine: chrome`);
      expect(summary).toMatch(/^\d+_\d+ textbox "Name"/m);
      console.info('Observed Chrome snapshot uid:',/^\d+_\d+ button "Go"/m.exec(summary)?.[0]);
      const nameRef=/^(\d+_\d+) textbox "Name"/m.exec(summary)![1]!;
      await run('browser_fill',{ref:nameRef,value:'Alice'});
      const fresh=text(await run('browser_snapshot'));
      const goRef=/^(\d+_\d+) button "Go"/m.exec(fresh)![1]!;
      await run('browser_click',{ref:goRef});
      expect(await evaluate("document.getElementById('result').textContent")).toBe('Clicked Alice');
      console.info('Observed curated Chrome evaluate:',JSON.stringify(text(await run('browser_evaluate',{expression:'document.title'}))));
      // No explicit page focus workaround: selector type + Enter must focus itself.
      await run('browser_type',{selector:'#second',text:'Bob',pressEnter:true});
      expect(await evaluate("document.getElementById('second').value")).toBe('Bob');
      expect(await evaluate("document.getElementById('submitted').textContent")).toBe('Submitted');
      await run('browser_wait',{text:'Clicked Alice',timeoutMs:3000});
      await run('browser_wait',{selector:'#result',timeoutMs:3000});
      const screenshot=await run('browser_screenshot',{width:800,height:600,fullPage:true});
      const png=await readFile((screenshot.details as {path:string}).path);
      expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));expect(png.readUInt32BE(20)).toBeGreaterThan(600);
      expect(screenshot.content.filter(c=>c.type==='image')).toHaveLength(1);
      expect(text(await run('browser_extract',{mode:'console'}))).toContain('hello from chrome fixture');
      expect(text(await run('browser_extract',{mode:'network'}))).toContain(url);
      expect(text(await run('browser_network_request',{url}))).toContain('Request');
      // Chrome-specific interaction uses native uid mappings, not OS automation.
      await run('browser_hover',{selector:'#go',snapshot:false});
      await writeFile(join(h.cwd,'upload.txt'),'Chrome E2E upload');
      await run('browser_upload',{selector:'#file',paths:['upload.txt'],snapshot:false});
      expect(await evaluate("document.getElementById('file').files[0].name")).toBe('upload.txt');
      const dialogSnapshot=text(await run('browser_snapshot'));
      const dialogRef=/^(\d+_\d+) button "Dialog"/m.exec(dialogSnapshot)![1]!;
      const dialogClick=text(await run('browser_click',{ref:dialogRef}));
      expect(dialogClick).toContain('Use browser_dialog before requesting a snapshot');
      await run('browser_dialog',{action:'accept',promptText:'yes'});
      await run('browser_emulate',{cpuThrottling:2,network:'Fast 4G',viewport:'800x600'});
      await run('browser_emulate',{cpuThrottling:1,viewport:'800x600'});
      await run('browser_perf',{action:'start',reload:false,autoStop:false});
      await evaluate('document.body.offsetHeight');
      expect(text(await run('browser_perf',{action:'stop'}))).toContain('trace');
      const opened=text(await run('browser_tabs',{action:'new',url:`${url}next`}));
      const newId=/^(\d+):.*\[selected\]/m.exec(opened)![1]!;
      const listing=text(await run('browser_tabs',{action:'list'}));expect(listing).toContain('Chrome Next');expect(listing).toContain('[chrome] (active)');
      console.info('Observed Chrome page ids:',listing);
      await run('browser_tabs',{action:'switch',tabId:'1'});
      await run('browser_tabs',{action:'close',tabId:newId});
      await writeFile(join(h.cwd,'state.json'),JSON.stringify({cookies:[{name:'skip',value:'secret',domain:'127.0.0.1'}],origins:[{origin,localStorage:[['k','v']],sessionStorage:[['s','1']]}]}));
      const imported=await run('browser_state',{action:'import',path:'state.json'});
      expect(text(imported)).toContain('cookies skipped on chrome');expect(imported.details).toMatchObject({cookies:0,storageApplied:2});
      expect(await evaluate('[localStorage.getItem("k"),sessionStorage.getItem("s")]')).toEqual(['v','1']);
      const pdf=await run('browser_pdf',{},true);expect(pdf.isError).toBe(true);expect(text(pdf)).toContain('Use engine "obscura"');
      await run('browser_state',{action:'reset'});expect(alive(pids[0]!)).toBe(false);remember();
      await run('browser_navigate',{url,engine:'chrome'});
      remember(); // Capture the restarted Chrome's profile after its lazy browser launch.
      expect(await evaluate('localStorage.getItem("k")')).toBeNull();
      await h.session.prompt('/browser stop');
      for(const pid of pids)expect(alive(pid)).toBe(false);
    } finally {
      await h?.dispose();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    }
    // Only test-owned groups/profiles are inspected; never terminate unrelated user Chrome.
    for(const pid of pids)await expect.poll(()=>pgrep(['-a','-g',String(pid)]),{timeout:5000}).toBe('');
    for(const profile of profiles)await expect.poll(()=>pgrep(['-af',profile.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')]),{timeout:5000}).toBe('');
    for(const pid of pids)expect(serverPids()).not.toContain(String(pid));
    expect(serverPids().filter(pid=>!baselineServerPids.has(pid))).toEqual([]);
    expect(pids).toHaveLength(2);expect(profiles.size).toBeGreaterThan(0);
  },85000);
});
