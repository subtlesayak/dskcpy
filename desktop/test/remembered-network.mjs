// Owned loopback HTTPS, real browser cookies/WSS, synthetic native header.
// Self-signed TLS is accepted only in the disposable browser. This does not
// qualify certificate trust, physical media, mobile OS behavior or Safari.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { createTrustedDevices, TRUST_LIFETIME_MS } from '../../gui/server/trusted-devices.mjs';

const engine=process.argv[2]||'chromium',finalGate=process.argv[3]||'revoke';
if(!['chromium','webkit'].includes(engine)||!['revoke','expiry','active-expiry','forget'].includes(finalGate))throw Error('Choose a supported browser and final gate');
const output=path.resolve(`desktop/out/remembered-network-${engine}-${finalGate}`);await mkdir(output,{recursive:true});
const directory=await mkdtemp(path.join(os.tmpdir(),'dskcpy-browser-cookie-'));
const filename=path.join(directory,'devices.json'),natives=new Set(),connections=new Set(),diagnostics=[],pageErrors=[];
let receiver,context,anonymous,proxy,origin,captures=0,clockOffset=0,approvalDeadline,passed=false;
const profile={maxSize:1600,maxFps:30,bitRateMbps:8},policy={keyboard:true,rememberProfile:profile};
const until=async(predicate,timeoutMs=1000)=>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Cookie fixture state transition failed');};
const receiverHtml = await readFile('gui/receiver/index.html', 'utf8');
const pairedMarkup = receiverHtml.match(/<section id="remembered-join"[\s\S]+?<\/section>/)?.[0];
assert.ok(pairedMarkup);
const html=`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/receiver.css"></head><body><main><section id="join-panel">
${pairedMarkup}
<form id="remember-form"><label>Name<input id="device-name" value="Fixture browser" required></label><button id="remember-submit">Ask Mac to remember</button></form>
<p id="remember-status" role="status"></p><section id="remember-device"></section>
<label for="session-key">Connection code</label><input id="session-key" autocomplete="off">
</section></main>
<script type="module">
import {rememberedBrowser} from '/remembered.mjs';
const client=rememberedBrowser({connectApproved:key=>{window.fixtureTicket=key;return true;}});
window.fixtureAttach=key=>new Promise(resolve=>{
 const ws=new WebSocket(location.origin.replace('https:','wss:')+'/stream');window.fixtureSocket=ws;
 const finish=value=>{clearTimeout(timer);resolve(value);};const timer=setTimeout(()=>{ws.close();finish(false);},10000);
 ws.addEventListener('open',()=>{if(key)ws.send(key);});
 ws.addEventListener('message',event=>{if(typeof event.data==='string'&&JSON.parse(event.data).type==='authenticated')finish(true);});
 ws.addEventListener('error',()=>finish(false));ws.addEventListener('close',()=>finish(false));
});
window.fixtureClose=()=>window.fixtureSocket?.close(4000);
await client.status();window.fixtureReady=true;
</script></body></html>`;
async function create(){
 const trustedDevices=createTrustedDevices({filename,now:()=>Date.now()+clockOffset});await trustedDevices.ready;
 receiver=createBrowserReceiver({configuredPort:0,origin,trustedDevices,onConnect:async bridge=>{
  captures++;const socket=net.connect(bridge.port,'127.0.0.1');natives.add(socket);socket.on('error',()=>{});
  await once(socket,'connect');socket.write(Buffer.from('535244310000000100000280000001e0','hex'));
 },onTrustedConnect:device=>receiver.invite('internet',{...policy,rememberProfile:device.profile},device)});
}
async function openBrowser(){
 context=await(engine==='webkit'?webkit:chromium).launchPersistentContext(path.join(directory,'browser-profile'),{
  headless:true,ignoreHTTPSErrors:true,serviceWorkers:'block',...(engine==='chromium'?{channel:'chromium',args:['--disable-gpu']}:{}),
 });
 // Confine the certificate exception to this owned fixture origin.
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 context.on('page',page=>page.on('pageerror',()=>pageErrors.push('browser script failure')));
 context.setDefaultTimeout(10000);
 const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.fixtureReady);return page;
}
async function newTicket(page){
 await page.evaluate(()=>{window.fixtureTicket=null;});
 await page.getByRole('button',{name:'Request to connect',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Waiting for host approval'}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixtureTicket),null);
 await receiver.trustAction('allow-stream',receiver.trustedStatus().streamRequest.id);
 await page.waitForFunction(()=>typeof window.fixtureTicket==='string');
 const value=await page.evaluate(()=>window.fixtureTicket);assert.match(value,/^[A-Za-z0-9_-]{32}$/);return value;
}
async function deniedRequest(page){
 return page.evaluate(async()=>(await fetch('/stream/trusted/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'request'})})).status);
}
try{
 await writeFile(path.join(directory,'request.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',path.join(directory,'request.cnf'),'-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem')],{stdio:'ignore',timeout:15000});
 const tls={key:await readFile(path.join(directory,'key.pem')),cert:await readFile(path.join(directory,'cert.pem'))};
 proxy=https.createServer(tls,async(req,res)=>{
  if(req.url==='/'||req.url==='/stream/check'){res.writeHead(200,{'Content-Type':'text/html',
   'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'"}).end(html);return;}
  if(req.url==='/remembered.mjs'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(await readFile('gui/receiver/remembered.mjs'));return;}
  if(req.url==='/receiver.css'){res.writeHead(200,{'Content-Type':'text/css'}).end(await readFile('gui/receiver/receiver.css'));return;}
  if(!['/stream/remember','/stream/remember/status','/stream/trusted/connect','/stream/trusted/status','/stream/trusted/cancel','/stream/trusted/forget'].includes(req.url)){res.writeHead(404).end();return;}
  const upstream=http.request({hostname:'127.0.0.1',port:receiver.port,path:req.url,method:req.method,headers:{...req.headers,host:new URL(origin).host}},response=>{
   diagnostics.push({path:req.url,status:response.statusCode,originMatches:req.headers.origin===origin,
    cookieNames:(req.headers.cookie||'').split(';').map(item=>item.trim().split('=')[0]).filter(Boolean)});
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>{res.writeHead(502).end();});req.pipe(upstream);
 });
 proxy.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});
 // Preserve actual browser Origin, cookies and WSS handshake. No credential
 // injection, routeWebSocket mocking or disabled broker checks.
 proxy.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/stream'){socket.destroy();return;}
  const upstream=http.request({hostname:'127.0.0.1',port:receiver.port,path:req.url,headers:{...req.headers,host:new URL(origin).host}});
  upstream.on('upgrade',(response,remote,remoteHead)=>{
   socket.write('HTTP/1.1 101 Switching Protocols\r\n'+response.rawHeaders.reduce((s,value,i)=>s+value+(i%2?'\r\n':': '),'')+'\r\n');
   if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);
   socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
   socket.pipe(remote);remote.pipe(socket);socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());
  });upstream.on('response',response=>{diagnostics.push({path:'upgrade',status:response.statusCode});response.resume();socket.end(`HTTP/1.1 ${response.statusCode} Forbidden\r\nConnection: close\r\n\r\n`);});
  upstream.on('error',()=>socket.destroy());upstream.end();
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${proxy.address().port}`;
 await create();const invitation=await receiver.invite('internet',policy);let page=await openBrowser();
 assert.equal(await page.evaluate(key=>window.fixtureAttach(key),invitation.key),true);await until(()=>captures===1);
 await page.getByRole('button',{name:'Ask Mac to remember',exact:true}).click();await page.getByRole('status').filter({hasText:/Waiting for pairing approval/}).waitFor();
 const pending=receiver.trustedStatus().pending;assert.equal(pending.length,1);assert.equal(captures,1);assert.equal(receiver.trustedStatus().devices.length,0);
 const cookie=(await context.cookies()).find(c=>c.name==='dskcpy_device_v1');assert.ok(cookie);assert.equal(cookie.httpOnly,true);assert.equal(cookie.secure,true);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.path,'/stream');assert.ok(cookie.expires>Date.now()/1000+89*86400);
 const matchingPath=await context.newPage();await matchingPath.goto(origin+'/stream/check');assert.equal(await matchingPath.evaluate(()=>document.cookie.includes('dskcpy_device_v1')),false);await matchingPath.close();
 // Active-expiry models an old recorded approval, then follows real time. It
 // never changes the system/browser clock or the normal 90-day grant constant.
 // Leave time for the real browser restart and the two host approvals. The
 // session must still finish at the original absolute deadline below.
 if(finalGate==='active-expiry')clockOffset=-TRUST_LIFETIME_MS+12000;
 await receiver.trustAction('approve',pending[0].id);approvalDeadline=receiver.trustedStatus().devices[0].expiresAt;clockOffset=0;
 await page.getByRole('status').filter({hasText:/Paired/}).waitFor();
 if(finalGate==='forget'){
  await page.setViewportSize({width:320,height:640});
  await page.getByRole('status').filter({hasText:/Computer is busy/}).waitFor();
  await page.getByText('Manage pairing',{exact:true}).focus();await page.keyboard.press('Enter');
  const name=page.getByRole('textbox',{name:'Computer name'});await page.keyboard.press('Tab');
  assert.equal(await name.evaluate(input=>document.activeElement===input),true);
  assert.ok(await name.evaluate(input=>getComputedStyle(input).outlineStyle==='solid' && parseInt(getComputedStyle(input).outlineWidth,10)>=2));
  await name.fill('Studio computer');await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'Studio computer',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 }
 await page.evaluate(()=>window.fixtureClose());await until(()=>!receiver.status().connected);await context.close();context=null;
 for(const native of natives)native.destroy();await receiver.shutdown();await create();await receiver.standby();
 page=await openBrowser();assert.equal(await page.getByRole('button',{name:'Request to connect',exact:true}).isVisible(),true);
 if(finalGate==='forget'){
  await page.getByRole('heading',{name:'Studio computer',exact:true}).waitFor();
  const statusRoute='**/stream/remember/status';
  await page.route(statusRoute,route=>route.abort());
  await page.getByRole('button',{name:'Check status',exact:true}).click();
  await page.getByRole('status').filter({hasText:/Computer is unreachable/}).waitFor();
  await page.unroute(statusRoute);
  await page.getByRole('button',{name:'Check status',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Reachable',exact:true}).waitFor();
 }
 await newTicket(page);assert.equal(captures,1,'ticket alone never captures');
 await receiver.trustAction('pause');assert.equal(await deniedRequest(page),403);assert.equal(captures,1);await receiver.trustAction('resume');
 const ticket=await newTicket(page);assert.equal(await page.evaluate(key=>window.fixtureAttach(key),ticket),true);await until(()=>captures===2);
 await page.evaluate(()=>window.fixtureSocket.close(4001));
 await page.waitForFunction(()=>window.fixtureSocket.readyState===WebSocket.CLOSED);
 assert.equal(await page.evaluate(()=>window.fixtureAttach(null)),true,'actual browser WSS cookie resumes without another ticket');
 assert.equal(captures,2,'transport recovery retains the original capture');
 // A second tab in the same context legitimately owns the HttpOnly resume
 // cookie. Test consumed-ticket replay from a distinct, unapproved context.
 anonymous=await context.browser().newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 await anonymous.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const other=await anonymous.newPage();await other.goto(origin);await other.waitForFunction(()=>window.fixtureReady);
 assert.equal(await other.evaluate(key=>window.fixtureAttach(key),ticket),false);assert.equal(diagnostics.at(-1).status,403);assert.equal(captures,2);await anonymous.close();anonymous=null;
 if(finalGate==='revoke')await receiver.trustAction('revoke',pending[0].id);
 else if(finalGate==='expiry'){clockOffset=receiver.trustedStatus().devices[0].expiresAt+1-Date.now();await page.evaluate(()=>window.fixtureClose());}
 else if(finalGate==='forget'){
  await page.getByText('Manage pairing',{exact:true}).focus();await page.keyboard.press('Enter');
  page.once('dialog',dialog=>dialog.dismiss());
  const forget=page.getByRole('button',{name:'Forget computer',exact:true});await forget.focus();await page.keyboard.press('Enter');
  assert.equal(receiver.trustedStatus().devices.length,1);
  page.once('dialog',dialog=>dialog.accept());await page.keyboard.press('Enter');
  await until(()=>receiver.trustedStatus().devices.length===0);
  await page.getByRole('heading',{name:'Paired computers',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.getByRole('textbox',{name:'Connection code'}).evaluate(input=>document.activeElement===input),true);
 }
 if(finalGate==='active-expiry'){
  await until(()=>!receiver.status().connected,13000);
  assert.ok(Date.now()>=approvalDeadline-20,'active capture does not close before its approval deadline');
  await page.waitForFunction(()=>window.fixtureSocket.readyState===WebSocket.CLOSED);
 }else await until(()=>!receiver.status().connected);
 await page.reload();await page.waitForFunction(()=>window.fixtureReady);
 assert.equal(await page.getByRole('button',{name:'Request to connect',exact:true}).isVisible(),false);
 if(finalGate!=='forget')await page.getByRole('status').filter({hasText:/Pairing required/}).waitFor();
 assert.equal((await context.cookies()).some(c=>c.name==='dskcpy_device_v1'),finalGate!=='forget');assert.equal(await deniedRequest(page),403);assert.equal(captures,2);
 assert.deepEqual(pageErrors,[]);
 passed=true;console.log(`${engine}: browser/host restart, real cookie/WSS ticket, pause/resume and ${finalGate} pass; no physical media or certificate-trust qualification.`);
}finally{
 await anonymous?.close();await context?.close();for(const native of natives)native.destroy();await receiver?.shutdown();
 for(const socket of connections)socket.destroy();if(proxy)await new Promise(resolve=>proxy.close(resolve));
 await writeFile(path.join(output,'result.json'),JSON.stringify({status:passed?'passed':'failed',engine,finalGate,ownedLoopbackHttps:true,
  certificateVerification:'disabled only in disposable browser; other HTTP origins blocked',systemTrustChanged:false,realCertificateTrustQualified:false,
  browserCookieHandling:true,cookieFromEnrollmentResponse:true,resumeCookieFromBrowserWss:true,secureHttpOnlySameSite:true,
  persistedAcrossBrowserAndHostRestart:passed,browserWssTicketHandoff:passed,browserWssResumeCookieWithoutNewCapture:passed,
  pausedCookieDenied:passed,consumedTicketOccupiedSessionDenied:passed,
  revokedBrowserCannotReconnect:passed&&finalGate==='revoke',expiredBrowserCannotReconnect:passed&&finalGate==='expiry',
  keyboardRenameAndForget:passed&&finalGate==='forget',
  activeCaptureEndsAtApprovalDeadline:passed&&finalGate==='active-expiry',
  expiryClock:finalGate==='active-expiry'?'old approval modeled at enrollment; real elapsed deadline': 'injected registry clock, not browser/system time',
  realDeviceEnrolled:false,screenCapture:false,realMedia:false,pageErrors,diagnostics},null,2)+'\n');
 await rm(directory,{recursive:true,force:true});
}
