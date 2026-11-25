import assert from 'node:assert/strict';
import { before,test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { runFocus } from '../src/focus-entry.ts';
const HOLO=new URL('../../app/.prism/build/q.holo',import.meta.url);
let kernel:Kernel;
before(async()=>{kernel=await Kernel.open(HOLO.pathname.replace(/^\/([A-Za-z]:)/,'$1'));});
const admission={admitted:true,community:'not-applicable',scope:'public'} as const;
test('focus model admits exactly the public admitted focus request with no community decision',async()=>{
  for(const intent of ['focus','other'] as const)
    for(const community of ['not-applicable','applicable','unknown'] as const)
      for(const scope of ['public','other'] as const)
        for(const admitted of [true,false]){
          const expected=intent==='focus'&&community==='not-applicable'&&scope==='public'&&admitted?'collect':'hold';
          assert.equal(await kernel.focusCollect(intent,community,scope,admitted),expected);
        }
});
test('focus entry respects the real model and does not fetch for ordinary questions',async()=>{
  let calls=0;
  const model={async complete(){calls++;return '{"intent":"ordinary"}';}};
  assert.deepEqual(await runFocus(kernel,model,'What is UOR?',admission,{fetcher:async()=>assert.fail('must not fetch')}),{kind:'ordinary'});
  assert.equal(calls,1);
});
test('focus entry does not invoke classification or discovery for unadmitted, nonpublic or community requests',async()=>{
  const model={async complete(){return assert.fail('must not classify');}};
  for(const facts of [{...admission,admitted:false},{...admission,scope:'other' as const},
    {...admission,community:'applicable' as const},{...admission,community:'unknown' as const}])
    assert.deepEqual(await runFocus(kernel,model,'What next?',facts,{fetcher:async()=>assert.fail('must not fetch')}),{kind:'hold'});
});
test('focus entry uses real kernel before live collection and one intent call',async()=>{
  const calls:string[]=[];
  let classifications=0;
  const model={async complete(){classifications++;return '{"intent":"focus"}';}};
  const result=await runFocus(kernel,model,'What should I contribute?',admission,{fetcher:async url=>{
    calls.push(String(url));return new Response('[]');
  }});
  assert.equal(result.kind,'assessment');
  if(result.kind!=='assessment')return assert.fail();
  assert.equal(result.data.sourceCoverage,'complete');
  assert.equal(result.data.diagnosticChoices.length,0);
  assert.equal(classifications,1);
  assert.equal(calls.length,1);
  assert.match(calls[0],/^https:\/\/api\.github\.com\/orgs\/UOR-Foundation\/repos\?/);
});
test('focus entry never collects when kernel holds or errors',async()=>{
  const model={async complete(){return '{"intent":"focus"}';}};
  const fetcher=async()=>assert.fail('must not fetch');
  assert.deepEqual(await runFocus({async focusCollect(){return 'hold';}},model,'What next?',admission,{fetcher}),{kind:'hold'});
  assert.deepEqual(await runFocus({async focusCollect(){throw Error('private');}},model,'What next?',admission,{fetcher}),{kind:'unavailable'});
});

test('focus entry prioritizes an explicitly named repository beyond the scan cap',async()=>{
  const model={async complete(){return '{"intent":"focus"}';}};
  const repos=[...Array.from({length:25},(_,i)=>'a'+String(i).padStart(2,'0')),'Zeta'].map(name=>({name,full_name:'UOR-Foundation/'+name,private:false,visibility:'public',archived:false,fork:false,default_branch:'main'}));
  const calls:string[]=[];
  const result=await runFocus(kernel,model,'What should I work on in UOR-Foundation/zeta?',admission,{fetcher:async url=>{
    const u=new URL(String(url));calls.push(u.pathname);
    return new Response(JSON.stringify(u.pathname.startsWith('/orgs/')?repos:[]));
  }});
  assert.equal(result.kind,'assessment');if(result.kind!=='assessment')return assert.fail();
  assert.equal(result.data.projection.matchingRepositories,1);
  assert.equal(result.data.sourceCoverage,'partial');
  assert.equal(calls[1],'/repos/UOR-Foundation/Zeta/issues');
});
test('focus entry asks for clarification rather than silently choosing among explicit repository scopes',async()=>{
  const model={async complete(){return '{"intent":"focus"}';}};
  assert.deepEqual(await runFocus(kernel,model,'What should I work on in UOR-Foundation/q or UOR-Foundation/lexlean?',admission,{fetcher:async()=>assert.fail('must not fetch')}),{kind:'clarify'});
});
test('focus entry does not treat sentence-final periods as part of a named repository',async()=>{
  const model={async complete(){return '{"intent":"focus"}';}};
  const repos=[...Array.from({length:25},(_,i)=>'a'+String(i).padStart(2,'0')),'q'].map(name=>({name,full_name:'UOR-Foundation/'+name,private:false,visibility:'public',archived:false,fork:false,default_branch:'main'}));
  const run=async(question:string)=>{
    const calls:string[]=[];
    const result=await runFocus(kernel,model,question,admission,{fetcher:async url=>{
      const u=new URL(String(url));calls.push(u.pathname);
      return new Response(JSON.stringify(u.pathname.startsWith('/orgs/')?repos:[]));
    }});
    if(result.kind!=='assessment')return assert.fail();
    return {calls,matching:result.data.projection.matchingRepositories};
  };
  for(const question of ['What should I work on in UOR-Foundation/q.','What should I work on in UOR-Foundation/q...']){
    const {calls,matching}=await run(question);
    assert.equal(matching,1);
    assert.equal(calls[1],'/repos/UOR-Foundation/q/issues');
  }
  // An invalid explicitly named identity must not fall back to a broad scan.
  for(const question of ['What should I work on in UOR-Foundation/...','What should I work on in UOR-Foundation/. or UOR-Foundation/q?']){
    assert.deepEqual(await runFocus(kernel,model,question,admission,{fetcher:async()=>assert.fail('must not fetch')}),{kind:'clarify'});
  }
});
