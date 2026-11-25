import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Root documents are explicitly scoped; extend this list when introducing a new architecture-bearing root file.
const rootFiles = new Set(["ARCHITECTURE.md","GOVERNANCE.md","SECURITY.md","MAINTAINERS.md","AGENTS.md","CLAUDE.md","CONTRIBUTING.md","VERIFICATION.md","CONFORMANCE.md","TEMPLATE-CONTRACT.md","TEMPLATE-VERIFICATION.md","template-contract.json","template.lock","prism.project","prism.toml","host/README.md","host/package.json","host/package-lock.json","host/tsconfig.json","host/.env.example","host/Dockerfile","host/docker-compose.yml",".github/CODEOWNERS"]);
const scoped = (p:string) => rootFiles.has(p) ||
  /^(?:app\/|model\/|features\/suites\/|host\/(?:src|test|bench|deploy|web)\/|\.github\/workflows\/|experiments\/|prompts\/)/.test(p) ||
  (/^docs\//.test(p) && p !== 'docs/README.md' && !/^docs\/qortara\//.test(p) && p !== 'docs/qortara-template-pin.json');

function inspect(front:string, register:string, files:readonly string[]):string[] {
  const errors:string[]=[];
  const pointer='The single canonical architecture owner register is [Owner register](docs/README.md).';
  if(front.split(pointer).length!==2)errors.push('missing or duplicate canonical root pointer');
  const start='<!-- architecture-inventory:start -->', end='<!-- architecture-inventory:end -->';
  const parts=register.split(start);
  if(parts.length!==2 || register.split(end).length!==2 || !parts[1].includes(end))return [...errors,'missing, duplicate or reversed inventory boundaries'];
  const body=parts[1].split(end)[0];
  const known=new Set(files);
  const seen=new Set<string>(), ids=new Set<string>();
  for(const line of body.split('\n').filter(l=>l.startsWith('| ')).slice(2)){
    const cells=line.split('|').slice(1,-1).map(c=>c.trim());
    if(cells.length!==5||cells.some(c=>!c)){errors.push('malformed owner row');continue;}
    const [id,,,owner,support]=cells;
    if(ids.has(id))errors.push('duplicate area '+id);
    ids.add(id);
    const ownerLinks=[...owner.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
    if(ownerLinks.length!==1)errors.push('expected one primary source owner: '+id);
    for(const [,label,target] of (owner+'; '+support).matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)){
      const path=posix.normalize('docs/'+target);
      if(label!==path||path.startsWith('../')||!known.has(path)||!scoped(path))errors.push('invalid or stale registration '+path);
      if(seen.has(path))errors.push('duplicate registration '+path);
      seen.add(path);
    }
  }
  if(!ids.size)errors.push('empty owner register');
  for(const path of files.filter(scoped))if(!seen.has(path))errors.push('unregistered architecture path '+path);
  return errors;
}
function inventory():string[]{
  const all=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).split('\0').filter(Boolean);
  return [...new Set(all)].sort();
}
const front=()=>readFileSync(root+'ARCHITECTURE_INDEX.md','utf8');
const register=()=>readFileSync(root+'docs/README.md','utf8');

test('canonical architecture inventory covers every scoped repository path exactly once',()=>{
  const paths=inventory();
  assert.ok(paths.filter(scoped).length>0,'architecture scan must not be empty');
  assert.deepEqual(paths.filter(p=>scoped(p)&&!existsSync(root+p)),[],'tracked architecture paths must exist');
  assert.deepEqual(inspect(front(),register(),paths),[]);
});
test('architecture inventory rejects omitted, stale, duplicate and missing-owner registrations',()=>{
  const f=front(),r=register(),files=inventory();
  assert.ok(inspect(f,r,[...files,'host/src/unregistered-example.ts']).includes('unregistered architecture path host/src/unregistered-example.ts'));
  assert.ok(inspect(f,r,files.filter(p=>p!=='host/src/focus-entry.ts')).includes('invalid or stale registration host/src/focus-entry.ts'));
  const duplicate=r.replace('[host/src/focus-entry.ts](../host/src/focus-entry.ts)','[host/src/focus-entry.ts](../host/src/focus-entry.ts); [host/src/focus-entry.ts](../host/src/focus-entry.ts)');
  assert.notEqual(duplicate,r);
  assert.ok(inspect(f,duplicate,files).includes('duplicate registration host/src/focus-entry.ts'));
  assert.ok(inspect(f.replace('Owner register','Other register'),r,files).includes('missing or duplicate canonical root pointer'));
  const start='<!-- architecture-inventory:start -->', end='<!-- architecture-inventory:end -->';
  const malformedRegisters=[end+'\n'+r, r+'\n'+end, start+'\n'+r, r.replace(start,''), r.replace(end,''), r.replace(start,'__marker__').replace(end,start).replace('__marker__',end)];
  for(const malformed of malformedRegisters) {
    assert.ok(inspect(f,malformed,files).includes('missing, duplicate or reversed inventory boundaries'));
  }
});
