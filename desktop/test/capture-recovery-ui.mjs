// Real Chromium + owned loopback broker and synthetic native headers/input.
// No screen, audio, clipboard, permission, private route or real device access.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';

const output=path.resolve('desktop/out/capture-recovery-verification');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--disable-gpu']});
const results=[];
async function until(predicate){for(let i=0;i<400;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Synthetic capture transition missing');}
function header(width,height){const b=Buffer.alloc(16);b.write('SRD1');b.writeUInt32BE(1,4);b.writeUInt32BE(width,8);b.writeUInt32BE(height,12);return b;}
function configuration(){const payload=Buffer.from('000000016742c01e0102030000000168ce3c80','hex'),p=Buffer.alloc(16+payload.length);p.writeUInt32BE(payload.length);p.writeUInt32BE(1,12);payload.copy(p,16);return p;}
try{
 for(const mode of ['webcodecs','webrtc'])for(const viewport of [{width:390,height:844},{width:844,height:390}]){
  const natives=[],controls=[];let bridge,captures=0,typed='',pending=Buffer.alloc(0);
  const receiver=createBrowserReceiver({configuredPort:0,onConnect:async value=>{
   bridge=value;captures++;pending=Buffer.alloc(0);
   const control={paused:false,audio:false};controls.push(control);
   const socket=net.connect(value.port,'127.0.0.1');natives.push(socket);socket.on('error',()=>{});await once(socket,'connect');
   socket.on('data',chunk=>{
    if(natives.at(-1)!==socket)return;pending=Buffer.concat([pending,chunk]);
    while(pending.length){
     const type=pending[0];if(type===9&&pending.length<3)return;
     const size=type===3?32:type===4||type===6?9:type===5?2:type===7?21:type===8?5:type===9?3+pending.readUInt16BE(1):0;
     assert.ok(size,'Unexpected synthetic input');if(pending.length<size)return;
     const packet=pending.subarray(0,size);pending=pending.subarray(size);
     if(type===9)typed+=packet.subarray(3).toString();
     if(type===5){if(packet[1]===7)control.paused=true;if(packet[1]===8)control.paused=false;if(packet[1]===10)control.audio=true;if(packet[1]===11)control.audio=false;}
    }
   });
   socket.write(header(captures===1?640:1280,captures===1?480:720));
   if(mode==='webrtc')socket.write(configuration());
  }});
  const invitation=await receiver.invite('local',{keyboard:true,captureRecovery:true});
  const context=await browser.newContext({viewport,hasTouch:true}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(mode=>{
   if(mode==='webcodecs')delete window.RTCPeerConnection;
   window.captureFixture={authenticated:0,offers:0,answers:0,closed:[]};const Base=window.WebSocket;
   window.WebSocket=class extends Base{constructor(...args){super(...args);this.addEventListener('message',event=>{
    if(typeof event.data!=='string')return;const message=JSON.parse(event.data);
    if(message.type==='authenticated')window.captureFixture.authenticated++;
    if(message.type==='rtc-offer')window.captureFixture.offers++;
   });this.addEventListener('close',event=>window.captureFixture.closed.push(event.code));}
   send(value){if(typeof value==='string'&&value.startsWith('{')){const message=JSON.parse(value);if(message.type==='rtc-answer')window.captureFixture.answers++;}super.send(value);}};
  },mode);
  try{
   await page.goto(invitation.url+'#connect='+invitation.key);
   await page.locator('#stream-panel').waitFor({state:'visible'});
   await until(()=>page.evaluate(()=>document.querySelector('#display').width===640));
   if(mode==='webrtc')await until(()=>page.evaluate(()=>window.captureFixture.offers===1&&window.captureFixture.answers===1));
   await page.getByRole('button',{name:'Keyboard',exact:true}).click();
   await page.locator('#keyboard-input').pressSequentially('before');await until(()=>typed==='before');
   if(mode==='webrtc'){await page.getByRole('button',{name:'Audio off',exact:true}).click();await until(()=>controls[0].audio);}
   const firstBridge=bridge;assert.equal(await firstBridge.restartNative(),true);
   await until(()=>page.evaluate(()=>window.captureFixture.authenticated===2&&document.querySelector('#display').width===1280));
   if(mode==='webrtc')await until(()=>page.evaluate(()=>window.captureFixture.offers===2&&window.captureFixture.answers===2));
   await until(()=>!controls[1].paused);
   if(mode==='webrtc')await until(()=>controls[1].audio);
   assert.equal(captures,2);assert.equal(await page.locator('#join-panel').isVisible(),false);
   assert.equal(await page.locator('#keyboard-input').inputValue(),'');
   await page.getByRole('button',{name:'Keyboard',exact:true}).click();
   await page.locator('#keyboard-input').pressSequentially('after');await until(()=>typed==='beforeafter');
   assert.equal(await page.locator('#display').evaluate(canvas=>canvas.height),720);
   assert.ok((await page.evaluate(()=>window.captureFixture.closed)).includes(1012));
   assert.deepEqual(errors,[]);
   await page.screenshot({path:path.join(output,`${mode}-${viewport.width}.png`)});
   await page.getByRole('button',{name:'Options',exact:true}).click();
   await page.locator('#pause').click();await until(()=>controls[1].paused);
   if(mode==='webrtc')assert.equal(controls[1].audio,false);
   await page.locator('#pause').click();await until(()=>!controls[1].paused);
   if(mode==='webrtc')await until(()=>controls[1].audio);
   await page.getByRole('button',{name:'Disconnect',exact:true}).click();
   await until(()=>!receiver.status().connected);assert.equal(await firstBridge.restartNative(),false);assert.equal(captures,2);
   results.push({mode,...viewport,freshAuthorizationWithoutCodeEntry:true,freshHeader:true,clearedTyping:true,noTextReplay:true,nativeResumeConfirmed:true,pauseResumeConfirmed:true,audioChoiceRestored:mode==='webrtc',explicitDisconnectStopsRecovery:true,rtcOffers:mode==='webrtc'?2:0});
  }finally{await context.close();for(const native of natives)native.destroy();await receiver.shutdown();}
 }
 await writeFile(path.join(output,'result.json'),JSON.stringify({syntheticNative:true,realCapture:false,realAudio:false,realPhone:false,results},null,2)+'\n');
 console.log(`${results.length} Chromium capture-recovery fixtures pass; no physical media qualified.`);
}finally{await browser.close();}
