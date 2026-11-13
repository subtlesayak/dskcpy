import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inventory } from '../../tools/build-identity.mjs';
import { verifyRuntimePayload } from '../payload-integrity.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'dskcpy-payload-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const files=['app/desktop/main.cjs','app/gui/server/service.mjs','app/gui/receiver/keyboard.mjs',
    'app/gui/receiver/protocol.mjs','app/gui/dist/index.html','app/gui/dist-desktop/desktop/index.html',
    'host/bin/scrcpy','host/bin/codec.dll','app/package.json','app/gui/package.json'];
  for(const name of files){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),'original');}
  const manifest={files:await inventory(root)};
  return {root,manifest,write:(name,text)=>writeFile(path.join(root,name),text)};
}

test('whole first-party payload is verified while declared third-party pruning stays compatible',async t=>{
  const f=await fixture(t);
  const result=await verifyRuntimePayload(f.root,f.manifest);
  assert.deepEqual(result,{firstPartyFilesVerified:8,nativeRuntimeFilesVerified:2});
  f.manifest.files.push({path:'app/node_modules/example/README.md',bytes:1,sha256:'0'.repeat(64)});
  assert.deepEqual(await verifyRuntimePayload(f.root,f.manifest),result);
});
for(const name of ['app/gui/receiver/keyboard.mjs','app/gui/receiver/protocol.mjs','app/gui/server/service.mjs',
 'app/gui/dist/index.html','host/bin/codec.dll','app/package.json']){
 test(`changed runtime payload is rejected: ${name}`,async t=>{
  const f=await fixture(t);await f.write(name,'tampered');
  await assert.rejects(verifyRuntimePayload(f.root,f.manifest),/payload differs/);
 });
}
test('missing files and unexpected shadow modules at either resolution level are rejected',async t=>{
 const f=await fixture(t);await rm(path.join(f.root,'app/gui/receiver/keyboard.mjs'));
 await assert.rejects(verifyRuntimePayload(f.root,f.manifest),/file set differs/);
 await f.write('app/gui/receiver/keyboard.mjs','original');
 for(const relative of ['app/gui/server/node_modules/ws','app/gui/node_modules/ws']){
  await mkdir(path.join(f.root,relative),{recursive:true});await f.write(relative+'/index.js','shadow');
  await assert.rejects(verifyRuntimePayload(f.root,f.manifest),/file set differs/);
  await rm(path.join(f.root,relative),{recursive:true});
 }
});
test('manifest traversal, duplicates and directory links fail without loading code',async t=>{
 const f=await fixture(t);const entry=f.manifest.files[0];
 for(const name of ['app/../outside','host/../../outside','app\\outside','/app/file','app//file']){
  await assert.rejects(verifyRuntimePayload(f.root,{files:[{...entry,path:name}]}),/Invalid payload/);
 }
 await assert.rejects(verifyRuntimePayload(f.root,{files:[entry,entry]}),/Invalid payload/);
 if(process.platform!=='win32'){
  await rm(path.join(f.root,'app/gui/receiver'),{recursive:true});
  await symlink(path.join(f.root,'app/gui/server'),path.join(f.root,'app/gui/receiver'));
  await assert.rejects(verifyRuntimePayload(f.root,f.manifest),/must not be a link|symbolic link/);
 }
});
