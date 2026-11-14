// Dashboard + synthetic API only; no native catalog, real invitation, OS effects
// or installed service. Captures only this owned headless test page.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const root=path.resolve('gui/dist'),output=path.resolve('desktop/out/window-host-ui');await mkdir(output,{recursive:true});
const server=http.createServer(async(req,res)=>{try{const p=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(p==='/'?'/index.html':p));if(!file.startsWith(root+path.sep))throw Error();res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--disable-gpu']}),results=[];
const state={running:false,stopping:false,reconnecting:false,reconnectAttempt:0,reconnectLimit:3,nextRetryAt:null,config:null,pid:null,encoder:null,latencyMs:null,command:null,startedAt:null,lastExitCode:null,error:null,logs:[],hostPlatform:'macOS',binaryAvailable:true,reverseDisplaySupported:true,
 browser:{waiting:false,connected:false,mode:'local',remoteAvailable:false},readiness:{checks:[{id:'binary',ready:true}],features:{browserKeyboard:true,macWindowCapture:true,browserCaptureRecovery:true},transports:Object.fromEntries(['usb','wifi','ip','internet','browser'].map(k=>[k,{ready:true,message:'Ready',required:[]}]))}};
const windows=Array.from({length:9},(_,i)=>({id:i+11,ownerPid:i+41,application:'Editor',title:'Projektübersicht mit ausführlicher Dokumentation '+(i+1)}));
try{for(const variant of [{width:1080,height:800},{width:320,height:900},{width:320,height:900,rtl:true},{width:640,height:900,zoom:2}]){
 const page=await browser.newPage({viewport:{width:variant.width,height:variant.height}}),errors=[],invitations=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
 await page.addInitScript(s=>{window.EventSource=class{constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(s)}));}close(){}};},state);
 await page.route('**/api/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  let body=pathname==='/api/status'?state:pathname==='/api/devices'?{devices:[],error:null}:{ready:false,peers:[]};
  if(pathname==='/api/browser/windows'){assert.equal(route.request().method(),'POST');body={windows};}
  else if(pathname==='/api/browser/invite'){invitations.push(route.request().postDataJSON());body={url:'http://example.invalid/',key:'x'.repeat(32),expiresAt:new Date(Date.now()+300000).toISOString(),status:{...state,browser:{...state.browser,waiting:true}}};}
  else assert.equal(route.request().method(),'GET');
  await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/#connection');
  await page.locator('html').evaluate((e,v)=>{e.dir=v.rtl?'rtl':'ltr';if(v.zoom)e.style.zoom=v.zoom;},variant);
  await page.getByRole('button',{name:'Refresh windows',exact:true}).click();
  await page.locator('#browser-capture-target').selectOption('11:41');
  const toggle=page.getByRole('checkbox',{name:'Allow receiver to switch windows',exact:true});assert.equal(await toggle.isChecked(),false);
  await toggle.check();assert.equal(await page.getByRole('button',{name:'Create link and code',exact:true}).isDisabled(),true);const choices=page.locator('.browser-window-choices input');assert.equal(await choices.count(),10);
  assert.equal(await choices.nth(1).isChecked(),true);assert.equal(await choices.nth(1).isDisabled(),true);
  for(let i=2;i<=8;i++)await choices.nth(i).check();assert.equal(await choices.nth(9).isDisabled(),true);
  await choices.nth(3).uncheck();assert.equal(await choices.nth(9).isEnabled(),true);await choices.nth(9).check();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.locator('.browser-window-choices').screenshot({path:path.join(output,variant.width+'-'+!!variant.rtl+'-'+!!variant.zoom+'.png')});
  await page.getByRole('button',{name:'Create link and code',exact:true}).click();
  assert.equal(invitations.length,1);assert.equal(invitations[0].browserWindows.length,8);
  assert.equal(invitations[0].windowId,11);assert.equal(invitations[0].windowOwnerPid,41);
  assert.equal(invitations[0].browserClipboard,false);
  assert.ok(invitations[0].browserWindows.every(w=>Object.keys(w).sort().join(',')==='id,label,ownerPid'&&w.label.length<=80&&w.id!==0));
  assert.ok(!invitations[0].browserWindows.some(w=>w.id===13));
  assert.match(await page.locator('#browser-code-help').textContent(),/view the selected windows/);assert.deepEqual(errors,[]);
  results.push({...variant,explicitSelection:true,maximumEight:true,initialRequired:true,viewOnlyCopy:true,syntheticOnly:true});
 }catch(error){await page.screenshot({path:path.join(output,variant.width+'-'+!!variant.rtl+'-'+!!variant.zoom+'-failure.png'),fullPage:true});await writeFile(path.join(output,'failure.json'),JSON.stringify({variant,error:error.message,overflow:await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,id:e.id,class:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,20))},null,2));throw error;}finally{await page.close();}
}}
finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));}
console.log(JSON.stringify({flows:results.length,syntheticOnly:true}));
