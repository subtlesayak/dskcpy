// Owned receiver + generated pixels and fake native controls only. No capture,
// permissions, OS input, actual windows, devices or installed service.
import {chromium,webkit} from 'playwright';
import {createBrowserReceiver} from '../../gui/server/browser.mjs';
import {generateMediaFixture,mediaPacket} from './media-fixture.mjs';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const engine=process.argv[2]||'chromium';assert.ok(['chromium','webkit'].includes(engine));
const output=path.resolve('desktop/out/window-switch-'+engine+(process.env.DSKCPY_TEST_RUN_TAG?'-'+process.env.DSKCPY_TEST_RUN_TAG:''));await mkdir(output,{recursive:true});
const fixtures=[await generateMediaFixture(),await generateMediaFixture({replacement:true,width:320,height:240})];
const browser=await ({chromium,webkit})[engine].launch(engine==='chromium'?{headless:true,channel:'chromium',args:['--disable-gpu']}:{headless:true});
const results=[];
const until=async(check,label)=>{for(let n=0;n<700;n++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Window fixture: '+label);};
const variants=[{name:'portrait',width:390,height:844},{name:'landscape',width:844,height:390},{name:'short',width:844,height:220},
 {name:'rtl',width:320,height:700,rtl:true},{name:'zoom',width:640,height:900,zoom:2},...(engine==='chromium'?[{name:'rtc',width:844,height:600,rtc:true}]:[])];
try{for(const variant of variants.filter(v=>!process.argv[3]||v.name===process.argv[3])){
 const sessions=[];let active=0,maxActive=0;
 const receiver=createBrowserReceiver({configuredPort:0,onRetireWindow:owner=>{
  const old=sessions.at(-1);assert.equal(old.bridge.windowOwner,owner);let resolve;
  const done=new Promise(r=>resolve=r);old.socket.once('close',()=>resolve(true));return {done,cancel:()=>resolve(false)};
 },onConnect:async bridge=>{
  assert.equal(bridge.viewOnly,true);assert.equal(bridge.keyboard,false);assert.equal(bridge.clipboard,false);
  const index=bridge.windowTarget.id===11?0:1,fixture=fixtures[index];
  assert.equal(bridge.windowTarget.ownerPid,index===0?41:42);
  const socket=net.connect(bridge.port,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');
  active++;maxActive=Math.max(active,maxActive);const session={socket,bridge,index,paused:true};sessions.push(session);
  let bytes=Buffer.alloc(0),frame=0,tick=0;const pending=new Set();
  socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length){
   const type=bytes[0],size=type===4||type===6?9:type===5?2:0;
   assert.ok(size,'Window mode must never forward pointer/keyboard/clipboard');if(bytes.length<size)return;
   const p=bytes.subarray(0,size);bytes=bytes.subarray(size);
   if(type===4){for(const pts of pending)if(pts<=Number(p.readBigUInt64BE(1)))pending.delete(pts);}
   if(type===5){assert.ok([7,8,9,11].includes(p[1]));if(p[1]===7)session.paused=true;if(p[1]===8){session.paused=false;frame=0;}}
  }});
  const header=Buffer.alloc(16);header.write('SRD1');header.writeUInt32BE(1,4);header.writeUInt32BE(fixture.width,8);header.writeUInt32BE(fixture.height,12);
  socket.write(header);socket.write(mediaPacket(fixture.configuration,0,1));
  const timer=setInterval(()=>{const pts=tick++*100000;if(session.paused||socket.destroyed||pending.size>=2)return;
   const unit=fixture.frames[frame++%fixture.frames.length];pending.add(pts);socket.write(mediaPacket(unit.payload,pts,unit.key?2:0));},100);
  socket.once('close',()=>{active--;clearInterval(timer);});
 }});
 const context=await browser.newContext({viewport:{width:variant.width,height:variant.height},hasTouch:true}),page=await context.newPage(),errors=[];
 page.setDefaultTimeout(9000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(rtc=>{if(!rtc)delete window.RTCPeerConnection;window.__auth=0;window.__messages=[];window.__closed=[];
  const Base=WebSocket;window.WebSocket=class extends Base{constructor(...args){super(...args);this.addEventListener('close',e=>window.__closed.push({code:e.code,reason:e.reason}));this.addEventListener('message',e=>{
   if(typeof e.data==='string'){const m=JSON.parse(e.data);if(m.type==='authenticated')window.__auth++;if(m.type==='window-state')window.__messages.push(m);}
  });}};
 },!!variant.rtc);
 const policy={viewOnly:true,windowTargets:[{id:11,ownerPid:41,label:'Editor — Projektübersicht und ausführliche Dokumentation'},{id:12,ownerPid:42,label:'Notes — Besprechungsnotizen und nächste Schritte'}],initialWindow:{windowId:11,windowOwnerPid:41}};
 async function waitPicture(blue=false){await until(()=>page.evaluate(({rtc,blue})=>{
  const source=document.querySelector(rtc?'#rtc-display':'#display');if(rtc&&source.readyState<2)return false;
  if((source.videoWidth||source.width)!==(blue?320:640))return false;
  const c=document.createElement('canvas');c.width=8;c.height=8;const ctx=c.getContext('2d');ctx.drawImage(source,0,0,8,8);
  const p=ctx.getImageData(1,4,1,1).data;return blue?p[2]>180&&p[0]<60:p[0]+p[1]>80;
 },{rtc:!!variant.rtc,blue}),'decoded '+(blue?'blue':'pattern'));}
 try{
  const invitation=await receiver.invite('local',policy);await page.goto(invitation.url+'#connect='+invitation.key);
  await page.locator('#stream-panel').waitFor({state:'visible'});await waitPicture();
  assert.equal(await page.locator('#keyboard').isHidden(),true);assert.equal(await page.locator('#audio').isDisabled(),true);
  if(variant.rtl)await page.locator('html').evaluate(e=>e.dir='rtl');if(variant.zoom)await page.locator('html').evaluate((e,z)=>e.style.zoom=z,variant.zoom);
  await page.getByRole('button',{name:'Choose a window',exact:true}).click();
  assert.equal(await page.locator('#window-choice-list button').count(),2);
  const second=page.locator('#window-choice-list button').nth(1);await second.scrollIntoViewIfNeeded();await second.click();
  await until(()=>sessions.length===2,'second native');
  await until(()=>page.locator('#window-choice-list button').nth(1).getAttribute('aria-pressed').then(v=>v==='true'),'new selection');await waitPicture(true);
  assert.equal(await page.locator('#display').evaluate(c=>c.width),320);
  assert.equal(await page.locator('#window-choice-list canvas').count(),1);
  assert.equal(await page.locator('#window-choice-list button').first().locator('small').textContent(),'Last viewed');
  assert.equal(await page.locator('#window-choice-list canvas').evaluate(c=>c.width*c.height),16000);
  assert.ok(await page.locator('#window-choice-list canvas').evaluate(c=>{const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return p.some((v,i)=>i%4!==3&&v>100);}));
  // Repeat choice is bounded by server cooldown. Later switching back must
  // preserve the previous window's preview, not replace it with stale pixels.
  await new Promise(r=>setTimeout(r,2100));
  const first=page.locator('#window-choice-list button').first();await first.scrollIntoViewIfNeeded();await first.click();
  await until(()=>sessions.length===3,'third native');
  await until(()=>page.locator('#window-choice-list button').first().getAttribute('aria-pressed').then(v=>v==='true'),'restored selection');await waitPicture();
  assert.equal(await page.locator('#window-choice-list canvas').count(),2);
  assert.ok(await page.locator('#window-choice-list button').nth(1).locator('canvas').evaluate(c=>{const p=c.getContext('2d').getImageData(80,50,1,1).data;return p[2]>180&&p[0]<60;}));
  assert.equal(maxActive,1);assert.deepEqual(sessions.map(s=>s.index),[0,1,0]);
  const grants=await page.evaluate(()=>window.__messages.map(m=>m.grant));assert.equal(new Set(grants).size,1);
  assert.ok((await page.evaluate(()=>window.__auth))>=3);
  assert.equal(await page.locator('#join-panel').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const close=page.locator('#close-window-choices');await close.focus();
  const box=await close.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=variant.width&&box.y+box.height<=variant.height);
  await page.screenshot({path:path.join(output,variant.name+'.png')});
  assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await until(()=>!receiver.status().connected,'explicit Stop');
  assert.equal(await page.locator('#window-choice-list canvas').count(),0);assert.equal(await page.locator('#choose-window').isHidden(),true);
  results.push({...variant,generatedMedia:true,exactTargets:[11,12,11],sameGrant:true,simultaneousNativeMax:maxActive,actualDecodedThumbnails:true,viewOnly:true,physicalDevice:false});
 }catch(error){await writeFile(path.join(output,variant.name+'-diagnostic.json'),JSON.stringify({error:error.message,sessions:sessions.map(s=>({index:s.index,paused:s.paused,closed:s.socket.destroyed})),page:await page.evaluate(()=>({errors:document.querySelector('#error').textContent,status:document.querySelector('#status').textContent,auth:window.__auth,closed:window.__closed,windowStates:window.__messages.map(({current,windows,...m})=>({switching:m.switching,selected:windows.findIndex(w=>w.key===current),count:windows.length}))}))},null,2));await page.screenshot({path:path.join(output,variant.name+'-failure.png')}).catch(()=>{});throw error;}
 finally{await context.close();for(const s of sessions)s.socket.destroy();await receiver.shutdown();}
}}
finally{await browser.close();await writeFile(path.join(output,'results.json'),JSON.stringify({engine,results},null,2));}
console.log(JSON.stringify({engine,flows:results.length,generatedMedia:true,physicalDevice:false}));
