// Real receiver + authenticated owned broker; in-memory native effects only.
// No media capture, permission API, OS input, device or installed service.
import { chromium, webkit } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { browserJoinUrl } from '../../gui/receiver/protocol.mjs';
import { validBrowserInput } from '../../gui/server/browser-protocol.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const engine = process.argv[2] || 'chromium'; assert.ok(['chromium','webkit'].includes(engine));
const output = path.resolve(`desktop/out/video-preference-ui-${engine}`); await mkdir(output,{recursive:true});
const browser = await ({chromium,webkit})[engine].launch(engine==='chromium'
  ? {headless:true,channel:'chromium',args:['--disable-gpu']} : {headless:true});
const results = [], key = 'dskcpy.video.v1';
const until = async (check,label) => { for(let i=0;i<600;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Video preference fixture: '+label); };
function broker({unavailable=false}={}) {
  const sessions=[];
  const receiver=createBrowserReceiver({configuredPort:0,onConnect:async bridge=>{
    const socket=net.connect(bridge.port,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');
    const s={socket,quality:[],paused:true,header:false};sessions.push(s);let pending=Buffer.alloc(0);
    s.start=()=>{s.header=true;socket.write(Buffer.from('535244310000000100000280000001e0','hex'));bridge.videoQuality(unavailable?null:{level:0,fps:60,bitRate:12000000});};
    socket.on('data',chunk=>{
      pending=Buffer.concat([pending,chunk]);
      while(pending.length){
        const type=pending[0],size=type===5?2:type===8?5:[4,6].includes(type)?9:type===3?32:type===7?21:0;
        assert.ok(size,'Unknown fake-native packet');if(pending.length<size)return;
        const p=Buffer.from(pending.subarray(0,size));pending=pending.subarray(size);
        if(type===5&&[12,13,14].includes(p[1])){
          assert.ok(s.header&&!s.paused,'Saved choice must follow resumed capture');s.quality.push(p[1]);
          bridge.videoQuality({level:p[1]-12,fps:60,bitRate:12000000});
        }else assert.ok(validBrowserInput(p,640,480,{keyboard:true}));
        if(type===5&&p[1]===7)s.paused=true;if(type===5&&p[1]===8)s.paused=false;
      }
    });
  }});
  return {receiver,sessions};
}
try { for(const variant of [
  {name:'portrait',width:390,height:844},
  {name:'landscape',width:844,height:390},
  {name:'short-landscape',width:844,height:220},
  {name:'narrow-rtl',width:320,height:700,rtl:true},
  {name:'zoom',width:640,height:900,zoom:2},
  {name:'storage-denied',width:390,height:844,storageDenied:true},
  {name:'old-host',width:390,height:844,oldHost:true,seed:true},
  {name:'view-only',width:390,height:844,viewOnly:true,seed:true},
  {name:'unavailable-native',width:390,height:844,unavailable:true,seed:true},
]) {
  const b=broker(variant), context=await browser.newContext({viewport:{width:variant.width,height:variant.height},hasTouch:true});
  const page=await context.newPage(), errors=[];page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  const policy={keyboard:true,adaptiveVideo:!variant.oldHost,viewOnly:!!variant.viewOnly};
  await page.addInitScript(({seed,denied,key})=>{
    delete window.RTCPeerConnection;
    window.__stageResizes=0;
    window.ResizeObserver=new Proxy(window.ResizeObserver,{construct(Target,[callback]){
      return new Target((...args)=>{window.__stageResizes++;callback(...args)});
    }});
    if(denied)Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Disabled','SecurityError')}});
    else if(seed&&localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify({version:1,automatic:false}));
  },{seed:!!variant.seed,denied:!!variant.storageDenied,key});
  if(variant.rtl||variant.zoom)await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
    document.querySelector('#video-quality-setting label').lastChild.textContent=' Videoqualität automatisch anpassen';
    document.querySelector('#options-heading h2').textContent='Übertragungsoptionen';
  }));
  const ready=async()=>{await page.locator('#stream-panel').waitFor({state:'visible'});await until(()=>page.locator('#display').evaluate(c=>c.width===640),'stream header');};
  async function connect(defer=false) {
    const n=b.sessions.length, invitation=await b.receiver.invite('local',policy);
    await page.goto(browserJoinUrl(invitation.url,invitation.key));await until(()=>b.sessions.length===n+1,'native connection');
    const s=b.sessions.at(-1);if(!defer){s.start();await ready();}return s;
  }
  const stop=async s=>{await page.getByRole('button',{name:'Disconnect',exact:true}).click();await until(()=>s.socket.destroyed&&!b.receiver.status().connected,'Stop');};
  try {
    let s=await connect();const automatic=page.locator('#video-automatic');
    if(variant.oldHost||variant.viewOnly||variant.unavailable){
      if(variant.unavailable){
        await page.getByRole('button',{name:'Options',exact:true}).click();
        await page.locator('#video-quality-status').getByText(/unavailable/).waitFor();
        assert.equal(await automatic.isDisabled(),true);
      }else assert.equal(await page.locator('#video-quality-setting').isHidden(),true);
      await page.locator('#video-automatic').evaluate(e=>{e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}))});
      await new Promise(r=>setTimeout(r,30));assert.equal(s.quality.length,0);await stop(s);
      results.push({...variant,storedChoiceCannotGrantCapability:true,actualMediaQualified:false});continue;
    }
    await page.getByRole('button',{name:'Options',exact:true}).click();await until(()=>automatic.isEnabled(),'native quality readiness');
    assert.equal(await automatic.isChecked(),true);assert.deepEqual(s.quality,[]);
    if(variant.rtl)await page.locator('html').evaluate(e=>e.dir='rtl');
    if(variant.zoom)await page.locator('html').evaluate((e,z)=>e.style.zoom=z,variant.zoom);
    assert.equal(await page.getByRole('checkbox',{name:variant.rtl||variant.zoom?'Videoqualität automatisch anpassen':'Adjust video automatically',exact:true}).count(),1);
    await automatic.focus();await page.keyboard.press('Space');await until(()=>s.quality.length===1,'manual target');
    await until(()=>page.locator('#video-quality-status').textContent().then(t=>t.startsWith('Manual video')),'confirmed manual state');
    const message=await page.locator('#video-preference-status').textContent();
    assert.match(message,variant.storageDenied?/Choose it again next time/:/Saved in this browser/);
    const box=await automatic.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=variant.width&&box.y>=0&&box.y+box.height<=variant.height);
    assert.equal(await automatic.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
    assert.ok((await page.locator('#video-quality-setting label').boundingBox()).height>=44);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const close=await page.locator('#close-options').boundingBox();assert.ok(close.y>=0&&close.y+close.height<=variant.height);
    await new Promise(r=>setTimeout(r,250));
    const layout=await page.locator('#stage').evaluate(e=>[e.clientWidth,e.clientHeight,window.__stageResizes]);
    await new Promise(r=>setTimeout(r,150));
    const settled=await page.locator('#stage').evaluate(e=>[e.clientWidth,e.clientHeight,window.__stageResizes]);
    assert.deepEqual(settled.slice(0,2),layout.slice(0,2));assert.ok(settled[2]-layout[2]<=1,'stage resize must settle, not loop each frame');
    assert.equal(await page.locator('#video-quality-setting label').evaluate(e=>{
      const text=e.lastChild;
      return [...text.textContent.matchAll(/\p{L}+/gu)].every(m=>{
        const range=document.createRange();range.setStart(text,m.index);range.setEnd(text,m.index+m[0].length);
        return new Set([...range.getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top))).size===1;
      });
    }),true,'setting words must remain readable without fragmenting across lines');
    const overflow=await page.locator('#control-panels').evaluate(e=>e.scrollHeight>e.clientHeight+1);
    if(overflow)assert.equal(await page.locator('#options-scroll-hint').isVisible(),true);
    await page.screenshot({path:path.join(output,variant.name+'.png')});
    await page.locator('#volume summary').focus();
    const pinned=await page.locator('#close-options').boundingBox();assert.ok(pinned.y>=0&&pinned.y+pinned.height<=variant.height);
    // This WebKit engine's default Tab policy skips checkboxes. Space activation
    // is tested above; test focus scrolling directly without changing OS policy.
    if(engine==='webkit')await automatic.focus();else await page.keyboard.press('Shift+Tab');
    assert.equal(await automatic.evaluate(e=>document.activeElement===e),true);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const focused=await automatic.boundingBox(),heading=await page.locator('#options-heading').boundingBox();
    assert.ok(focused.y>=heading.y+heading.height-1,JSON.stringify({variant:variant.name,focused,heading,reason:'focused setting stays below sticky heading'}));
    await page.getByRole('button',{name:'Pause video',exact:true}).click();const before=s.quality.length;
    assert.equal(await automatic.isDisabled(),true);
    await page.locator('#video-automatic').evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}))});
    await new Promise(r=>setTimeout(r,30));assert.equal(s.quality.length,before);
    await page.getByRole('button',{name:'Resume video',exact:true}).click();await stop(s);
    // A fresh session defaults to automatic at the host. The saved local
    // preference must be restored only after new authentication/header/resume.
    s=await connect(true);assert.deepEqual(s.quality,[]);
    await page.locator('#video-automatic').evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}))});
    assert.deepEqual(s.quality,[]);s.start();await ready();
    await page.getByRole('button',{name:'Options',exact:true}).click();await until(()=>automatic.isEnabled(),'new session readiness');
    if(variant.storageDenied){assert.equal(await automatic.isChecked(),true);assert.deepEqual(s.quality,[]);}
    else {
      await until(()=>s.quality.length===1,'restored choice after fresh session');assert.deepEqual(s.quality,[12]);
      assert.equal(await automatic.isChecked(),false);
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'{"version":1,"automatic":false}');
      await page.reload();await ready();await page.getByRole('button',{name:'Options',exact:true}).click();
      await until(()=>automatic.isEnabled(),'same-session reload');assert.equal(await automatic.isChecked(),false);assert.deepEqual(s.quality,[12]);
      await automatic.check();await until(()=>page.locator('#video-quality-status').textContent().then(t=>t.startsWith('Automatic video')),'automatic restored');
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'{"version":1,"automatic":true}');
    }
    let originIsolated=false;
    if(variant.name==='portrait'){
      await automatic.uncheck();await until(()=>s.quality.length===2,'manual choice before origin check');
      await stop(s);
      const other=broker();
      try{
        const invitation=await other.receiver.invite('local',policy);
        await page.goto(browserJoinUrl(invitation.url,invitation.key));await until(()=>other.sessions.length===1,'other origin');
        const different=other.sessions[0];different.start();await ready();
        await page.getByRole('button',{name:'Options',exact:true}).click();await until(()=>automatic.isEnabled(),'other origin readiness');
        assert.equal(await automatic.isChecked(),true);assert.deepEqual(different.quality,[]);
        assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);
        await page.getByRole('button',{name:'Disconnect',exact:true}).click();await until(()=>different.socket.destroyed,'other Stop');originIsolated=true;
      }finally{for(const s of other.sessions)s.socket.destroy();await other.receiver.shutdown();}
    }else await stop(s);
    assert.deepEqual(errors,[]);
    results.push({...variant,explicitChoice:true,pauseGate:true,authenticationGate:true,freshSessionRestore:!variant.storageDenied,storageDenialHandled:!!variant.storageDenied,reloadWithoutDuplicateCommand:!variant.storageDenied,originIsolated,focusTraversal:engine==='webkit'?'direct focus and Space; default Tab skips checkbox':'Shift+Tab and Space',actualMediaQualified:false});
  }finally{await context.close();for(const s of b.sessions)s.socket.destroy();await b.receiver.shutdown();}
}
  await writeFile(path.join(output,'results.json'),JSON.stringify({engine,realCapture:false,realInput:false,results},null,2)+'\n');
  console.log(`${engine}: ${results.length} real receiver preference flows pass; fake native input only.`);
}finally{await browser.close();}
