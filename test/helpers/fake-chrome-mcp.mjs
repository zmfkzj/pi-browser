/* NDJSON Chrome MCP 1.10.1 double. Schemas and text formats come from ../fixtures.
 * Deliberately invalidate ALL uids after click/navigation (stricter than upstream's
 * sometimes-persistent uids) so callers cannot accidentally rely on stale refs. */
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runInNewContext } from 'node:vm';
if (process.env.CHROME_FAKE_RECORD_ARGS) appendFileSync(process.env.CHROME_FAKE_RECORD_ARGS, JSON.stringify(process.argv.slice(2)));
const { tools } = JSON.parse(readFileSync(new URL('../fixtures/chrome-devtools-mcp-tools.json', import.meta.url), 'utf8'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const calls = [], pages = new Map(), stores = new Map();
let nextId = 1, selected, generation = 0, initialized = false;
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const noop = () => {};
function storage(map) { return { getItem: k => map.get(String(k)) ?? null, setItem: (k,v) => map.set(String(k),String(v)), removeItem: k => map.delete(String(k)), clear: () => map.clear(), key: i => [...map.keys()][i] ?? null, get length() { return map.size; } }; }
function newPage(url = 'about:blank') {
  const p = { id: nextId++, url, title: 'Chrome Fixture', history: [url], index: 0, result: 'Ready', refs: new Map(), nodes: [], polls: 0, width: 800, height: 600 };
  pages.set(p.id,p); selected = p.id; makeNodes(p); return p;
}
function makeNodes(p) {
  const node = (tag, id, name, value = '') => ({ tagName: tag.toUpperCase(), id, name: id, type: tag === 'input' ? 'text' : tag === 'button' ? 'submit' : '', value, innerText: name, textContent: name, labels: name ? [{innerText:name}] : [], placeholder: '', childNodes: [{nodeType:3,textContent:name}], parentElement: null,
    getAttribute(key) { return key === 'href' ? this.href : key === 'aria-label' ? name : this[key] ?? null; }, closest: () => null,
    scrollIntoView: noop, scrollBy: noop, scrollTo: noop, dispatchEvent: () => true, focus() { p.focused = this; }, setSelectionRange(start,end) { this.selectionStart=start;this.selectionEnd=end; },
    click() { this.focus(); p.result = id === 'submit' ? 'Submitted' : 'Clicked'; p.refs.clear(); }
  });
  const heading = node('h1','heading','Heading'), paragraph = node('p','paragraph','Hello fixture');
  const name = node('input','name','Name'), go = node('button','go','Go'), second = node('input','second','Second');
  const choice = node('select','choice','Choice','a'); choice.type = 'select-one'; choice.options = [{value:'a',label:'Alpha',textContent:'Alpha'}, {value:'b',label:'Beta',textContent:'Beta'}];
  const submit = node('button','submit','Submit'), file = node('input','file','Choose Files'); file.type = 'file';
  const dialog = node('button','dialog','Dialog'); dialog.click = () => { p.dialog = true; p.refs.clear(); };
  const next = node('a','next','Next'); next.href = new URL('/next',p.url.startsWith('http') ? p.url : 'https://example.com').href;
  const external = node('a','external','External'); external.href = 'https://external.example/';
  const li = node('li','item','Item'), pre = node('pre','code','const ok = true;');
  const result = node('div','result','Ready'); Object.defineProperty(result,'textContent',{get:()=>p.result,set:v=>{p.result=v;}});
  const form = node('form','form',''); Object.assign(form,{ action:p.url,method:'get',elements:[second,choice,submit] });
  p.nodes = [heading,paragraph,name,go,second,choice,submit,file,dialog,next,external,li,pre,result,form];
  p.focused = undefined;
}
newPage();
function listing() { return '## Pages\n' + [...pages.values()].map(p => `${p.id}: ${p.url === 'about:blank' ? p.url : `${p.title} (${p.url})`}${p.id === selected ? ' [selected]' : ''}`).join('\n'); }
function uid(p, id) { const n = p.refs.get(id); if (!n) throw new Error(`Element uid "${id}" not found on page ${p.id}.`); return n; }
function snapshot(p) {
  const gen = ++generation; p.refs.clear();
  const roles = {input:'textbox',button:'button',select:'combobox',a:'link',h1:'heading'};
  let out = `## Latest page snapshot\nuid=${gen}_0 RootWebArea "${p.title}" url="${p.url}"\n`;
  p.nodes.forEach((n,i) => { const ref = `${gen}_${i+1}`; p.refs.set(ref,n); out += `  uid=${ref} ${n.type === 'file' ? 'button' : roles[n.tagName.toLowerCase()] ?? 'StaticText'} ${JSON.stringify(n.innerText)}${n.tagName === 'INPUT' ? ' focusable' : ''}\n`; });
  return out;
}
function context(p) {
  const queryAll = selector => {
    if (selector === 'body') return [body];
    if (selector === '#later') return ++p.polls >= 2 ? [p.nodes[2]] : [];
    return p.nodes.filter(n => selector.split(',').some(s => s.startsWith('#') ? n.id === s.slice(1) : s === 'a[href]' ? n.tagName === 'A' : n.tagName.toLowerCase() === s));
  };
  const body = { get innerText() { return `Heading\nHello fixture\nName Go Second Alpha Beta Submit Next\n${p.result}`; }, scrollHeight:1600, querySelectorAll:queryAll };
  const url = new URL(p.url); if (!stores.has(url.origin)) stores.set(url.origin,{local:new Map(),session:new Map()});
  const store = stores.get(url.origin);
  const history = { back: () => { p.url=p.history[Math.max(0,--p.index)]; }, forward: () => { p.url=p.history[Math.min(p.history.length-1,++p.index)]; } };
  const document = { title:p.title, body, get activeElement() { return p.focused ?? body; }, forms:p.nodes.filter(n=>n.tagName==='FORM'), querySelectorAll:queryAll, querySelector:s=>queryAll(s)[0] ?? null, getElementById:id=>p.nodes.find(n=>n.id===id) ?? null };
  return {document, location:{href:p.url,origin:url.origin,reload:noop},localStorage:storage(store.local),sessionStorage:storage(store.session),history,window:{scrollBy:noop,scrollTo:noop},innerWidth:p.width,innerHeight:p.height,URL,Event:class Event {},console:{log:noop},setTimeout,clearTimeout};
}
function validate(name,a) {
  const schema = tools.find(t=>t.name===name)?.inputSchema;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  for (const key of schema.required ?? []) if (a[key] === undefined) throw new Error(`Missing required ${key}`);
  for (const [key,value] of Object.entries(a)) {
    const spec=schema.properties[key]; if (!spec) throw new Error(`Unknown parameter ${key}`);
    if (spec.type === 'number' && typeof value !== 'number') throw new Error(`${key} must be a number`);
    if (spec.type === 'array' && !Array.isArray(value)) throw new Error(`${key} must be an array`);
  }
}
createInterface({input:process.stdin}).on('line',async line => {
  let r; try { r=JSON.parse(line); } catch { return; }
  const {id,method,params={}}=r;
  if (method==='initialize') { reply(id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fake-chrome',version:'1.10.1'}}); return; }
  if (method==='notifications/initialized') { initialized=true; return; }
  if (method==='tools/list') { reply(id,{tools}); return; }
  if (method!=='tools/call') return;
  const name=params.name,a=params.arguments ?? {};
  if (name==='recorded_calls') { reply(id,text(JSON.stringify(calls))); return; }
  const record={name,args:a,order:calls.length+1}; calls.push(record);
  if (process.env.CHROME_FAKE_RECORD) appendFileSync(process.env.CHROME_FAKE_RECORD,JSON.stringify(record)+'\n');
  try {
    if (!initialized) throw new Error('Not initialized'); validate(name,a);
    const p=pages.get(a.pageId ?? selected); if (a.pageId !== undefined && !p) throw new Error(`Page ${a.pageId} not found`);
    let out;
    switch(name) {
      case 'list_pages': out=listing(); break;
      case 'new_page': newPage(a.url); out=listing(); break;
      case 'select_page': selected=a.pageId; out=listing(); break;
      case 'close_page': if(pages.size===1) out='The last open page cannot be closed. It is fine to keep it open.'; else { pages.delete(a.pageId); if(selected===a.pageId) selected=pages.keys().next().value; out=listing(); } break;
      case 'navigate_page':
        if(a.url?.startsWith('https://navigation-failure.test/')) { reply(id,{content:[{type:'text',text:`# navigate_page response\nUnable to navigate in the selected page: net::${new URL(a.url).pathname.slice(1)} at ${a.url}.`}]}); return; }
        if(a.url) {p.url=a.url;p.history.splice(p.index+1);p.history.push(a.url);p.index++;makeNodes(p);} else if(a.type==='back') p.url=p.history[p.index=Math.max(0,p.index-1)]; else if(a.type==='forward') p.url=p.history[p.index=Math.min(p.history.length-1,p.index+1)];
        p.refs.clear(); out=`${a.type==='reload'?'Successfully reloaded the page.':`Successfully navigated ${a.type==='back'?'back ':a.type==='forward'?'forward ':''}to ${p.url}.`}\n${listing()}`; break;
      case 'take_snapshot': out=snapshot(p); break;
      case 'evaluate_script': {
        const fn=runInNewContext(`(${a.function})`,context(p),{timeout:1000});
        const value=await fn(...(a.args ?? []).map(id=>uid(p,id)));
        out='Script ran on page and returned:\n```json\n'+(JSON.stringify(value) ?? 'null')+'\n```'; break;
      }
      case 'click': { const n=uid(p,a.uid); n.click(); out=p.dialog?'The element was clicked and it opened a dialog.\n# Open dialog\nprompt: Question (default value: "default").\nCall handle_dialog to handle it before continuing.':'Successfully clicked on the element'; break; }
      case 'fill': { const n=uid(p,a.uid); n.value=a.value;n.focus();out='Successfully filled out the element'; break; }
      case 'fill_form': for(const e of a.elements) uid(p,e.uid).value=e.value; out='Successfully filled out the form'; break;
      case 'press_key': if(a.key==='Enter' && p.focused?.tagName==='INPUT') p.result='Submitted'; out=`Successfully pressed key: ${a.key}`; break;
      case 'hover': uid(p,a.uid); out='Successfully hovered over the element'; break;
      case 'upload_file': uid(p,a.uid); out=`File uploaded from ${a.filePaths.join(', ')}.`; break;
      case 'handle_dialog': if(!p.dialog) throw new Error('No open dialog found'); p.dialog=false; out=`Successfully ${a.action==='accept'?'accepted':'dismissed'} the dialog\n${listing()}`; break;
      case 'resize_page': p.width=a.width;p.height=a.height;out=listing(); break;
      case 'emulate': out='Emulation configured successfully'+(a.networkConditions?`\nEmulating network conditions: ${a.networkConditions}`:'')+(a.viewport?`\nEmulating viewport: ${a.viewport}`:'')+(a.cpuThrottlingRate>1?`\nEmulating CPU throttling: ${a.cpuThrottlingRate}x slowdown`:''); break;
      case 'take_screenshot': reply(id,{content:[{type:'text',text:`Took a screenshot of the ${a.fullPage?'full current page':'current page viewport'}.`},{type:'image',mimeType:'image/png',data:png}],isError:false}); return;
      case 'list_console_messages': out='## Console messages\nShowing 1-1 of 1 (Page 1 of 1).\nmsgid=1 [log] hello from page (1 args)'; break;
      case 'list_network_requests': out=`## Network requests\nShowing 1-1 of 1 (Page 1 of 1).\nreqid=1 GET ${p.url} [200]`; break;
      case 'get_network_request': out=`## Request ${p.url}\nStatus: 200\n### Request Headers\n- accept:text/html\n### Response Headers\n- content-type:text/html\n### Response Body\nHello fixture`; break;
      case 'wait_for': if(a.text.includes('#never')) return; if(!a.text.some(t=>context(p).document.body.innerText.includes(t))) throw new Error(`Waiting failed: ${a.timeout}ms exceeded`); out=`Element matching one of ${JSON.stringify(a.text)} found.\n`+snapshot(p); break;
      case 'performance_start_trace': out='The performance trace is being recorded. Use performance_stop_trace to stop it.'+(a.autoStop?'\n## insight set id: NAVIGATION_0':''); break;
      case 'performance_stop_trace': out='The performance trace has been stopped.\n## Summary of Performance trace findings:\n## insight set id: NAVIGATION_0\nLCP: 42ms'; break;
      case 'performance_analyze_insight': out=`## Insight Title: ${a.insightName}\n## Insight Summary:\nInsight set: ${a.insightSetId}`; break;
      default: out=`Successfully ran ${name}`;
    }
    reply(id,text(out));
  } catch(e) { reply(id,text(`Error: ${e.message}`,true)); }
});
