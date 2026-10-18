const assert = require('node:assert/strict');
const { naturalFilterPage } = require('/app/dist/server/lib/naturalCatalogFilter');
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
(async()=>{
  let release, loads=0;
  const waiting=new Promise(resolve=>{release=resolve});
  const args={identity:'stop-test',query:'votes',skip:0,
    plan:async()=>({summary:'most votes first',sort:'votes'}),
    load:async page=>{loads++;return page===1?Array.from({length:120},(_,i)=>({id:`tt${i}`,type:'movie',_nlVotes:i})):waiting},
    enrich:async m=>m};
  naturalFilterPage(args);
  for(let i=0;i<500&&loads<2;i++)await tick();
  assert.equal(loads,2);
  const stopped=naturalFilterPage({...args,action:'stop'});
  assert.equal(stopped.naturalFilter.status,'partial');assert.equal(stopped.naturalFilter.scanned,120);
  assert.equal(stopped.metas.length,100);assert.equal(stopped.metas[0]._nlVotes,119);
  const page2=naturalFilterPage({...args,skip:100});assert.equal(page2.metas.length,20);assert.equal(page2.metas[0]._nlVotes,19);
  release([{id:'tt-outside-snapshot',type:'movie',_nlVotes:99999}]);await tick();
  assert.deepEqual(naturalFilterPage({...args,action:'stop'}),stopped);assert.equal(loads,2);
  let finishPlan, planningLoads=0;
  const planning={...args,identity:'stop-while-planning',plan:()=>new Promise(resolve=>{finishPlan=resolve}),load:async()=>{planningLoads++;return []}};
  naturalFilterPage(planning);
  assert.equal(naturalFilterPage({...planning,action:'stop'}).naturalFilter.status,'partial');
  finishPlan({summary:'votes',sort:'votes'});await tick();assert.equal(planningLoads,0);
  let fail;
  const failure={...args,identity:'stop-before-error',load:()=>new Promise((_,reject)=>{fail=reject})};
  naturalFilterPage(failure);await tick();naturalFilterPage({...failure,action:'stop'});fail(Error('private provider failure'));await tick();
  assert.equal(naturalFilterPage(failure).naturalFilter.status,'partial');
  assert.throws(()=>naturalFilterPage({...args,identity:'missing-stop',action:'stop'}));
  const originalNow=Date.now;
  Date.now=()=>originalNow()+31*60*1000;
  assert.throws(()=>naturalFilterPage({...args,action:'stop'}));
  Date.now=originalNow;
  console.log('PASS: stop during scan/planning, sorted partial pagination, frozen results/counters, late-response/error races, idempotent stop, expired/missing job safety');
})().catch(e=>{console.error(e);process.exit(1)});
