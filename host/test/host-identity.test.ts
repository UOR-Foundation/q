import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { measureHostFiles } from '../src/host-identity.ts';

function fixture(t: {after(fn:()=>void):void}, reverse = false) {
  const root = mkdtempSync(join(tmpdir(),'q-host-identity-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const entries = ['host/src/main.ts','host/src/capabilities.ts','host/web/suggestions.json','host/package.json','host/package-lock.json','experiments/example.json'];
  for(const path of reverse?entries.reverse():entries){
    mkdirSync(dirname(join(root,path)),{recursive:true});
    writeFileSync(join(root,path),path);
  }
  return root;
}
test('host fingerprint is independent of root and insertion order; ignores data and env',t=>{
  const a=fixture(t), b=fixture(t,true);
  const first=measureHostFiles(a);
  assert.equal(first.files,6);
  assert.match(first.fingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(first,measureHostFiles(b));
  mkdirSync(join(a,'data'));
  writeFileSync(join(a,'data/private.json'),'fictional private data');
  writeFileSync(join(a,'host/.env'),'FAKE_SECRET=example');
  assert.deepEqual(first,measureHostFiles(a));
});
test('changed bytes, unexpected file and missing file affect or refuse host measurement',t=>{
  const root=fixture(t), before=measureHostFiles(root);
  const file=join(root,'host/src/main.ts');
  writeFileSync(file,'changed');
  assert.notEqual(before.fingerprint,measureHostFiles(root).fingerprint);
  writeFileSync(file,'host/src/main.ts');
  const extra=join(root,'host/src/extra.ts');
  writeFileSync(extra,'extra');
  assert.notEqual(before.fingerprint,measureHostFiles(root).fingerprint);
  rmSync(extra);
  assert.deepEqual(before,measureHostFiles(root));
  rmSync(join(root,'host/package-lock.json'));
  assert.throws(()=>measureHostFiles(root));
});
test('symbolic links are refused rather than hashed through',t=>{
  const root=fixture(t);
  symlinkSync(join(root,'host/package.json'),join(root,'host/src/link.ts'));
  assert.throws(()=>measureHostFiles(root),/refused/);
});
