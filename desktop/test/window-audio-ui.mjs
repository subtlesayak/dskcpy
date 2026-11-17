// Real browser decoding with generated lavfi media and fake native controls.
// All output is test-muted; no real screen, microphone, OS input or device.
import {chromium,webkit} from 'playwright';
import {createBrowserReceiver} from '../../gui/server/browser.mjs';
import {generateMediaFixture,mediaPacket} from './media-fixture.mjs';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const engine=process.argv[2]||'chromium';assert.ok(['chromium','webkit'].includes(engine));
const output=path.resolve('desktop/out/window-audio-'+engine);await mkdir(output,{recursive:true});
await writeFile(path.join(output,'results.json'),JSON.stringify({engine,status:'running',physicalDevice:false}));
const fixtures=[await generateMediaFixture({frequency:440}),await generateMediaFixture({replacement:true,width:320,height:240,frequency:880})];
const browser=await({chromium,webkit})[engine].launch(engine==='chromium'?{headless:true,channel:'chromium',args:['--disable-gpu','--mute-audio']}:{headless:true});
const results=[];let passed=false;
const until=async(check,label)=>{for(let n=0;n<800;n++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('App audio fixture: '+label);};
try{for(const mode of engine==='chromium'?['webcodecs','webrtc']:['webcodecs']){
 const sessions=[];let active=0,maxActive=0;
 const receiver=createBrowserReceiver({configuredPort:0,onRetireWindow:token=>{const old=sessions.at(-1);assert.equal(token,old.bridge.windowOwner);let resolve;const done=new Promise(r=>resolve=r);old.socket.once('close',()=>resolve(true));return{done,cancel:()=>resolve(false)};},onConnect:async bridge=>{
  assert.ok(bridge.viewOnly&&bridge.windowAudio);assert.equal(bridge.keyboard,false);assert.equal(bridge.clipboard,false);
  const index=bridge.windowTarget.id===11?0:1,fixture=fixtures[index];assert.equal(bridge.windowTarget.ownerPid,index?42:41);
  const socket=net.connect(bridge.port,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');
  active++;maxActive=Math.max(active,maxActive);const session={index,bridge,socket,paused:true,audio:false,sentAudio:0,commands:[]};sessions.push(session);
  let pending=Buffer.alloc(0),frame=0,videoTick=0,audioTick=0;const videoAcks=new Set(),audioAcks=new Set();
  socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length){const type=pending[0],size=type===5?2:[4,6].includes(type)?9:0;assert.ok(size,'Window input must never reach native');if(pending.length<size)return;
   const p=pending.subarray(0,size);pending=pending.subarray(size);
   if(type===5){assert.ok([7,8,9,10,11].includes(p[1]));session.commands.push(p[1]);if(p[1]===7)session.paused=true;if(p[1]===8){session.paused=false;frame=0;}if(p[1]===10)session.audio=true;if(p[1]===11)session.audio=false;}
   else{const acks=type===4?videoAcks:audioAcks;for(const pts of acks)if(pts<=Number(p.readBigUInt64BE(1)))acks.delete(pts);}
  }});
  const header=Buffer.alloc(16);header.write('SRD1');header.writeUInt32BE(1,4);header.writeUInt32BE(fixture.width,8);header.writeUInt32BE(fixture.height,12);
  socket.write(header);socket.write(mediaPacket(fixture.configuration,0,1));socket.write(mediaPacket(fixture.sound.configuration,0,4));
  const videoTimer=setInterval(()=>{const pts=videoTick++*100000;if(session.paused||socket.destroyed||videoAcks.size>=2)return;const f=fixture.frames[frame++%fixture.frames.length];videoAcks.add(pts);socket.write(mediaPacket(f.payload,pts,f.key?2:0));},100);
  const audioTimer=setInterval(()=>{const tick=audioTick++;if(session.paused||!session.audio||socket.destroyed||audioAcks.size>=4)return;const pts=tick*10000;audioAcks.add(pts);socket.write(mediaPacket(fixture.sound.frames[tick%fixture.sound.frames.length],pts,8));session.sentAudio++;},10);
  socket.once('close',()=>{active--;clearInterval(videoTimer);clearInterval(audioTimer);});
 }});
 const context=await browser.newContext({viewport:{width:844,height:600},hasTouch:true}),page=await context.newPage(),errors=[];page.setDefaultTimeout(9000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(mode=>{
  if(mode==='webcodecs')delete window.RTCPeerConnection;
  window.__audioTest={scope:0,buffers:[],peers:[],closed:[],states:[]};
  const Base=WebSocket;window.WebSocket=class extends Base{constructor(...args){super(...args);this.addEventListener('message',e=>{if(typeof e.data!=='string')return;const m=JSON.parse(e.data);if(m.type==='window-state'&&!m.switching){window.__audioTest.scope=m.windows.findIndex(w=>w.key===m.current);window.__audioTest.states.push(window.__audioTest.scope);}});}};
  const Audio=window.AudioContext;window.AudioContext=new Proxy(Audio,{construct(Target,args){
   const ac=new Target(...args),create=ac.createBufferSource.bind(ac),silent=ac.createGain();silent.gain.value=0;silent.connect(ac.destination);
   ac.createBufferSource=()=>{const source=create(),start=source.start.bind(source),stop=source.stop.bind(source),connect=source.connect.bind(source);let record;
    source.connect=(destination,...rest)=>connect(destination===ac.destination?silent:destination,...rest);
    source.start=(...args)=>{const pcm=source.buffer.getChannelData(0);let cross=0,energy=0;for(let i=1;i<pcm.length;i++){if(pcm[i-1]<0&&pcm[i]>=0)cross++;energy+=pcm[i]*pcm[i];}
     record={scope:window.__audioTest.scope,hz:cross*source.buffer.sampleRate/pcm.length,rms:Math.sqrt(energy/pcm.length),stopped:false,ended:false};window.__audioTest.buffers.push(record);source.addEventListener('ended',()=>record.ended=true);return start(...args);};
    source.stop=(...args)=>{if(record)record.stopped=true;return stop(...args);};return source;
   };return ac;
  }});
  if(mode==='webrtc'){const PC=RTCPeerConnection;window.RTCPeerConnection=new Proxy(PC,{construct(Target,args){const pc=new Target(...args);window.__audioTest.peers.push(pc);return pc;}});}
  document.addEventListener('DOMContentLoaded',()=>{document.querySelector('#rtc-display').volume=0;});
 },mode);
 const policy={viewOnly:true,windowAudio:true,windowTargets:[{id:11,ownerPid:41,label:'Editor app'},{id:12,ownerPid:42,label:'Notes app'}],initialWindow:{windowId:11,windowOwnerPid:41}};
 async function picture(blue=false){await until(()=>page.evaluate(({mode,blue})=>{const s=document.querySelector(mode==='webrtc'?'#rtc-display':'#display');if(mode==='webrtc'&&s.readyState<2)return false;if((s.videoWidth||s.width)!==(blue?320:640))return false;const c=document.createElement('canvas');c.width=8;c.height=8;const ctx=c.getContext('2d');ctx.drawImage(s,0,0,8,8);const p=ctx.getImageData(1,4,1,1).data;return blue?p[2]>180&&p[0]<60:p[0]+p[1]>80;},{mode,blue}),'new decoded picture');}
 async function tone(index){
  if(mode==='webcodecs'){await until(()=>page.evaluate(index=>window.__audioTest.buffers.filter(b=>b.scope===index&&b.rms>.001&&(index?b.hz>700&&b.hz<1000:b.hz>300&&b.hz<600)).length>=6,index),'scheduled distinct Opus tone '+index);return;}
  await page.evaluate(async()=>{const s=document.querySelector('#rtc-display').srcObject;if(window.__audioTest.analysis)window.__audioTest.analysis.source.disconnect();const ac=window.__audioTest.ac||=new AudioContext({sampleRate:48000});await ac.resume();const source=ac.createMediaStreamSource(s),analyser=ac.createAnalyser(),silent=ac.createGain();analyser.fftSize=4096;silent.gain.value=0;source.connect(analyser);analyser.connect(silent);silent.connect(ac.destination);window.__audioTest.analysis={source,analyser,rate:ac.sampleRate};});
  await until(()=>page.evaluate(index=>{const a=window.__audioTest.analysis,p=new Float32Array(4096);a.analyser.getFloatTimeDomainData(p);let cross=0,energy=0;for(let i=1;i<p.length;i++){if(p[i-1]<0&&p[i]>=0)cross++;energy+=p[i]*p[i];}const hz=cross*a.rate/p.length,rms=Math.sqrt(energy/p.length);return rms>.001&&(index?hz>800&&hz<960:hz>380&&hz<510);},index),'received RTC distinct Opus tone '+index);
 }
 async function choose(index){await page.getByRole('button',{name:'Choose a window',exact:true}).click();await page.locator('#window-choice-list button').nth(index).click();await until(()=>page.evaluate(index=>window.__audioTest.scope===index,index),'new authorized scope');await picture(index===1);}
 try{
  const invitation=await receiver.invite('local',policy);await page.goto(invitation.url+'#connect='+invitation.key);await page.locator('#stream-panel').waitFor({state:'visible'});await picture();
  assert.equal(sessions[0].audio,false);assert.equal(sessions[0].sentAudio,0);assert.equal(await page.locator('#keyboard').isHidden(),true);assert.equal(await page.locator('#touch').isDisabled(),true);
  await page.getByRole('button',{name:'App audio off',exact:true}).click();await until(()=>sessions[0].audio,'explicit enable');await tone(0);
  await page.getByRole('button',{name:'App audio on',exact:true}).click();await until(()=>!sessions[0].audio,'explicit mute');
  if(mode==='webcodecs')assert.ok(await page.evaluate(()=>window.__audioTest.buffers.every(b=>b.ended||b.stopped)));
  await page.getByRole('button',{name:'App audio off',exact:true}).click();await tone(0);
  const oldSourceCount=await page.evaluate(()=>window.__audioTest.buffers.length);
  await choose(1);await until(()=>sessions.length===2&&sessions[1].audio,'audio intent on new approved app');await tone(1);
  assert.match(await page.locator('#window-choice-status').textContent(),/entire app/);assert.equal(await page.locator('#audio').getAttribute('aria-label'),'App audio on');
  if(mode==='webcodecs')assert.ok(await page.evaluate(n=>window.__audioTest.buffers.slice(n).filter(b=>b.scope===1&&b.rms>.001).every(b=>b.hz>650),oldSourceCount),'No old tone scheduled after new source scope');
  else assert.ok(await page.evaluate(()=>window.__audioTest.peers.slice(0,-1).every(p=>p.connectionState==='closed')));
  await page.getByRole('button',{name:'App audio on',exact:true}).click();await until(()=>!sessions[1].audio,'mute new app');
  await new Promise(r=>setTimeout(r,2100));
  // The tray may already be open after handoff; close it before using its trigger.
  if(await page.locator('#choose-window').getAttribute('aria-expanded')==='true')await page.locator('#close-window-choices').click();
  await choose(0);await until(()=>sessions.length===3,'third native');await new Promise(r=>setTimeout(r,120));assert.equal(sessions[2].audio,false);assert.equal(sessions[2].sentAudio,0);
  assert.equal(await page.getByRole('button',{name:'App audio off',exact:true}).count(),1);assert.equal(maxActive,1);assert.deepEqual(sessions.map(s=>s.index),[0,1,0]);
  await page.screenshot({path:path.join(output,mode+'.png')});assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await until(()=>!receiver.status().connected,'Stop');
  results.push({engine,mode,syntheticOpus:true,distinctTones:[440,880],decodedToneChange:true,staleAudioNotScheduled:true,explicitMuteRetainedAcrossSwitch:true,maxSimultaneousNative:maxActive,windowInputForbidden:true,allOutputTestMuted:true,physicalDevice:false,audiblePlaybackQualified:false});
 }catch(error){await page.screenshot({path:path.join(output,mode+'-failure.png')}).catch(()=>{});await writeFile(path.join(output,mode+'-failure.json'),JSON.stringify({error:error.message,errors,sessions:sessions.map(s=>({index:s.index,audio:s.audio,paused:s.paused,sentAudio:s.sentAudio,commands:s.commands.slice(-20)})),page:await page.evaluate(()=>({error:document.querySelector('#error').textContent,status:document.querySelector('#status').textContent,states:window.__audioTest.states,buffers:window.__audioTest.buffers.slice(-12)}))},null,2));throw error;}
 finally{await context.close();for(const s of sessions)s.socket.destroy();await receiver.shutdown();}
}passed=true;}
finally{await browser.close();await writeFile(path.join(output,'results.json'),JSON.stringify({engine,status:passed?'passed':'failed',results},null,2));}
console.log(JSON.stringify({engine,flows:results.length,syntheticOpus:true,physicalDevice:false,audiblePlaybackQualified:false}));
