// Actual Chromium receiver + owned broker + fake native clipboard. Browser
// clipboard methods are injected in-memory stand-ins; no system clipboard,
// capture, permissions, real keys, private routes or devices are accessed.
import { chromium } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { readClipboardRequest } from '../../gui/receiver/clipboard.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const output=path.resolve('desktop/out/clipboard-verification');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--disable-gpu']});const results=[];
const until=async predicate=>{for(let i=0;i<400;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Clipboard fixture transition missing');};
try { for(const variant of [{width:390,height:844,rtl:false},{width:844,height:390,rtl:false},{width:320,height:700,rtl:true}]) {
  let native,pending=Buffer.alloc(0),clipboard='host café 世界 🙂',pastes=0,operations=[],typed=[],holdRead=false,held=null;
  const respond=(request,text='',status=0)=>{const b=Buffer.from(text),p=Buffer.alloc(24+b.length);p.writeUInt32BE(8+b.length);p.writeUInt32BE(32,12);p[16]=request.op;p[17]=status;p.writeUInt32BE(request.id,18);p.writeUInt16BE(b.length,22);b.copy(p,24);native.write(p);};
  const receiver=createBrowserReceiver({configuredPort:0,onConnect:async bridge=>{
    native=net.connect(bridge.port,'127.0.0.1');native.on('error',()=>{});await once(native,'connect');
    native.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length){const type=pending[0];if(type===10&&pending.length<8)return;
      const size=type===10?8+pending.readUInt16BE(6):type===3?32:[4,6].includes(type)?9:type===5?2:type===7?21:type===8?5:type===9&&pending.length>=3?3+pending.readUInt16BE(1):0;
      assert.ok(size,'Unexpected fake native control');if(pending.length<size)return;const packet=pending.subarray(0,size);pending=pending.subarray(size);
      if(type===9)typed.push(packet.subarray(3).toString());
      if(type!==10||packet[1]===3)continue;const request=readClipboardRequest(packet);operations.push(request.op);
      if(request.op===0){if(holdRead)held=request;else respond(request,clipboard);}
      else{clipboard=request.text;if(request.op===2)pastes++;respond(request);}
    }});
    const h=Buffer.from('535244310000000100000280000001e0','hex');native.write(h);
  }});
  const invitation=await receiver.invite('local',{keyboard:true,clipboard:true}),context=await browser.newContext({viewport:{width:variant.width,height:variant.height},hasTouch:true}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
  await page.addInitScript(()=>{delete window.RTCPeerConnection;window.clipboardFixture={reads:0,writes:[]};Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>{window.clipboardFixture.reads++;return 'device fixture';},writeText:async text=>{window.clipboardFixture.writes.push(text);}}});});
  try{
    await page.goto(invitation.url+'#connect='+invitation.key);await page.locator('#stream-panel').waitFor({state:'visible'});
    await until(()=>page.locator('#display').evaluate(c=>c.width===640));
    if(variant.rtl)await page.locator('html').evaluate(el=>el.dir='rtl');
    await page.getByRole('button',{name:'Options',exact:true}).click();await page.locator('#clipboard-tools summary').click();
    const toggle=page.getByRole('checkbox',{name:'Enable clipboard tools for this connection',exact:true}),field=page.getByRole('textbox',{name:'Text to transfer',exact:true});
    assert.equal(await toggle.isChecked(),false);assert.equal(operations.length,0);assert.deepEqual(await page.evaluate(()=>window.clipboardFixture),{reads:0,writes:[]});
    await toggle.check();await page.getByRole('button',{name:'Read computer clipboard',exact:true}).click();
    await until(()=>field.inputValue().then(x=>x===clipboard));assert.deepEqual(await page.evaluate(()=>window.clipboardFixture.writes),[]);
    await page.getByRole('button',{name:'Copy to this device',exact:true}).click();await until(()=>page.evaluate(()=>window.clipboardFixture.writes.length===1));
    assert.deepEqual(await page.evaluate(()=>window.clipboardFixture.writes),[clipboard]);
    await page.getByRole('button',{name:'Paste from this device',exact:true}).click();await until(()=>field.inputValue().then(x=>x==='device fixture'));
    assert.equal(clipboard,'host café 世界 🙂');assert.deepEqual(operations,[0]);assert.deepEqual(typed,[],'editing the clipboard preview must not type on the computer');
    await page.getByRole('button',{name:'Copy to computer clipboard',exact:true}).click();await until(()=>clipboard==='device fixture');assert.equal(pastes,0);
    await field.fill('paste fixture');await page.getByRole('button',{name:'Paste on computer',exact:true}).click();await until(()=>pastes===1);await until(()=>page.locator('#clipboard-status').innerText().then(text=>text.includes('Paste sent')));assert.equal(clipboard,'paste fixture');
    await page.screenshot({path:path.join(output,`clipboard-${variant.width}-${variant.rtl}.png`),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.ok(!JSON.stringify(receiver.status()).includes('paste fixture'));
    holdRead=true;await page.getByRole('button',{name:'Read computer clipboard',exact:true}).click();await until(()=>Boolean(held));
    await page.getByRole('button',{name:'Pause video',exact:true}).click();assert.equal(await field.inputValue(),'');assert.equal(await toggle.isChecked(),false);
    respond(held,'stale private fixture');await page.getByRole('button',{name:'Resume video',exact:true}).click();assert.equal(await field.inputValue(),'');
    await page.reload();await page.locator('#stream-panel').waitFor({state:'visible'});await until(()=>page.locator('#display').evaluate(c=>c.width===640));assert.equal(await page.locator('#clipboard-enable').isChecked(),false);assert.equal(await page.locator('#clipboard-text').inputValue(),'');
    assert.equal(clipboard,'paste fixture','closing tools must not clear or rewrite the host clipboard');assert.deepEqual(errors,[]);
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();
    results.push({...variant,explicitActions:true,noAutomaticLocalClipboard:true,copyVsPasteSeparated:true,pausedAndLateReplyCleared:true,reloadRequiresOptIn:true,noStatusLeak:true,realClipboard:false});
  }finally{await context.close();native?.destroy();await receiver.shutdown();}
 }
 await writeFile(path.join(output,'result.json'),JSON.stringify({syntheticNative:true,systemClipboardAccess:false,realPhone:false,results},null,2)+'\n');console.log(`${results.length} Chromium explicit clipboard flows pass using fake clipboard APIs.`);
}finally{await browser.close();}
