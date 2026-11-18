// Real host model/serializer and rendered UI, synthetic broker status and Stop
// prompt. No actual host shell, OS dialogs, capture, input or private route.
import { chromium, webkit } from 'playwright';
import { HostController } from '../host-controller.mjs';
import { browserSummary } from '../presentation-state.mjs';
import { createStopAction } from '../stop-action.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const engine=process.argv[2]||'chromium';if(!['chromium','webkit'].includes(engine))throw Error('Unknown fixture engine');
const output=path.resolve(`desktop/out/host-presentation-${engine}`);await mkdir(output,{recursive:true});
const root=path.resolve('gui/dist-desktop');
const server=http.createServer(async(req,res)=>{
  if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}
  try{
    const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+path.sep))throw Error('Invalid fixture path');
    const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(data);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{channel:'chromium',args:['--disable-gpu']}: {})});
const results=[];let passed=false;
try{
  for(const variant of [{width:620,height:740},{width:320,height:700,rtl:true},{width:640,height:800,zoom:2},{width:844,height:390}]){
    const errors=[],page=await browser.newPage({viewport:{width:variant.width,height:variant.height}});page.setDefaultTimeout(6000);
    page.on('pageerror',error=>errors.push(error.message));
    let status,stops=0,questions=0,answer=false;
    const host=new HostController({backend:{status:async()=>status,stop:async()=>{stops++;status={running:false,browser:browserSummary({})};}},
      checkSetup:async()=>({permissions:{screen:true,control:true},runtimeReady:true,features:{keyboard:true},route:{connected:true,ready:true}})});
    const raw=overrides=>({waiting:false,connected:true,presentation:true,presentationEnded:false,presentationAvailable:true,
      controllerConnected:true,controllerActive:true,controllerAuthorized:true,...overrides});
    const update=async(overrides={},permission='ready')=>{
      status={running:true,browser:browserSummary(raw(overrides)),nativeInputPermission:permission};
      const state=await host.refresh({setup:true});await page.evaluate(state=>window.fixtureChanged?.(state),state);return state;
    };
    status={running:true,browser:browserSummary(raw()),nativeInputPermission:'ready'};await host.refresh({setup:true});
    const stop=createStopAction({snapshot:()=>host.snapshot(),stop:()=>host.stop(),confirm:async()=>{questions++;return answer;}});
    await page.exposeBinding('fixtureSnapshot',()=>host.snapshot());await page.exposeBinding('fixtureStop',()=>stop());
    await page.addInitScript(()=>{
      window.dskcpyHost={snapshot:()=>window.fixtureSnapshot(),onChange:callback=>{window.fixtureChanged=callback;return()=>{};},
        stop:async()=>{const state=await window.fixtureStop();window.fixtureChanged(state);return state;}};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/desktop/index.html`);
    if(variant.rtl)await page.locator('html').evaluate(node=>node.dir='rtl');
    if(variant.zoom)await page.locator('body').evaluate((node,zoom)=>node.style.zoom=String(zoom),variant.zoom);
    await page.getByRole('heading',{name:'Presentation connected',exact:true}).waitFor();
    await page.getByRole('status',{name:'Phone controls'}).filter({hasText:'Phone controls connected.'}).waitFor();
    await update({controllerActive:false});await page.getByRole('status',{name:'Phone controls'}).filter({hasText:'Phone controls paused.'}).waitFor();
    await update({controllerConnected:false,controllerActive:false});await page.getByRole('status',{name:'Phone controls'}).filter({hasText:'Reopen the same controller page'}).waitFor();
    await update({controllerConnected:false,controllerActive:false,controllerAuthorized:false});await page.getByRole('status',{name:'Phone controls'}).filter({hasText:'Use phone as touchpad and keyboard'}).waitFor();
    await update({presentationAvailable:false});await page.getByRole('heading',{name:'Waiting for the presentation',exact:true}).waitFor();
    await update({presentationEnded:true},'blocked');await page.getByRole('heading',{name:'Presentation ended',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Open control permissions',exact:true}).count(),0,'ended presentation does not ask for unnecessary input grants');
    assert.equal((await page.locator('main').innerText()).includes('Your screen is being shared'),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
    const stopButton=page.getByRole('button',{name:'Stop sharing',exact:true});
    await page.getByRole('heading',{name:'Presentation ended',exact:true}).focus();
    await page.keyboard.press(engine==='webkit'?'Alt+Tab':'Tab');
    assert.equal(await stopButton.evaluate(node=>node===document.activeElement),true,'Stop is the next keyboard action after the heading');
    await stopButton.scrollIntoViewIfNeeded();
    const focus=await stopButton.evaluate(node=>({style:getComputedStyle(node).outlineStyle,width:parseFloat(getComputedStyle(node).outlineWidth)}));
    assert.ok(focus.style!=='none'&&focus.width>0,'Stop has visible keyboard focus');
    assert.equal(await stopButton.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'focused Stop is not obscured');
    await page.screenshot({path:path.join(output,`ended-${variant.width}-${Boolean(variant.rtl)}-${variant.zoom||1}.png`),fullPage:true});
    await page.screenshot({path:path.join(output,`viewport-${variant.width}-${Boolean(variant.rtl)}-${variant.zoom||1}.png`)});
    await stopButton.press('Space');await stopButton.waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('button.stop').disabled);
    assert.equal(questions,1);assert.equal(stops,0);assert.equal(host.snapshot().presentation.ended,true,'Cancel preserves the remaining session');
    answer=true;await stopButton.press('Space');await page.getByRole('heading',{name:'Your computer, wherever you are',exact:true}).waitFor();
    assert.equal(questions,2);assert.equal(stops,1);assert.equal(host.snapshot().canStop,false);assert.deepEqual(errors,[]);
    results.push({...variant,roleStatuses:true,endedCopyAccurate:true,noUnnecessaryPermissionRequest:true,
      modelAndSerializerUsed:true,keyboardStopCancelConfirm:true,stopPrompt:'fake callback, not OS dialog',horizontalOverflow:false,pageErrors:0});
    await page.close();
  }
  passed=true;console.log(`${engine}: ${results.length} host presentation/status/Stop flows pass.`);
}finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(output,'results.json'),JSON.stringify({status:passed?'passed':'failed',engine,realHostShell:false,realPermissionCalls:false,realMedia:false,realNativeDialog:false,results},null,2)+'\n');
}
