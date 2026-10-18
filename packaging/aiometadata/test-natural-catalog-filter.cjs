const assert = require('node:assert/strict');
const { validatePlan, matchMeta, sortMatches, naturalFilterPage } = require('/app/dist/server/lib/naturalCatalogFilter');
const plan = validatePlan({summary:'Documentaries 2020+, at least 7, votes',minYear:2020,minRating:7,genres:['Documentary'],sort:'votes'});
assert.equal(matchMeta({releaseInfo:'2022',imdbRating:'8',genres:['Documentary']},plan),true);
assert.equal(matchMeta({releaseInfo:'2019',imdbRating:'8',genres:['Documentary']},plan),false);
assert.equal(matchMeta({releaseInfo:'2022',genres:['Documentary']},plan),null);
assert.equal(matchMeta({name:'Crime',description:'A crime drama'}, {summary:'true crime',terms:[['true crime','real crimes']]}),false);
assert.equal(matchMeta({description:'A TRUE CRIME investigation'}, {summary:'true crime',terms:[['true crime']]}),true);
assert.equal(matchMeta({description:'untrue crimes'}, {summary:'true crime',terms:[['true crime']]}),false);
assert.equal(matchMeta({originalLanguage:'en'}, {summary:'English',languages:['en']}),true);
assert.equal(matchMeta({}, {summary:'English',languages:['en']}),null);
assert.equal(matchMeta({runtime:'2h10min'}, {summary:'under two hours',maxRuntime:120}),false);
assert.equal(matchMeta({runtime:'1h35min'}, {summary:'under two hours',maxRuntime:120}),true);
assert.equal(matchMeta({runtime:'2h'}, {summary:'at least two hours',minRuntime:120}),true);
assert.equal(matchMeta({runtime:'95min'}, {summary:'at least 90 minutes',minRuntime:90}),true);
assert.equal(matchMeta({type:'movie'}, {summary:'series',types:['series']}),false);
assert.equal(matchMeta({type:'series'}, {summary:'series',types:['series']}),true);
assert.throws(()=>validatePlan({summary:'bad',sql:'DROP TABLE'}));
assert.throws(()=>validatePlan({summary:'bad',minRating:11}));
assert.throws(()=>validatePlan({summary:'bad',minYear:2025,maxYear:2020}));
assert.throws(()=>validatePlan({unsupported:'Only metadata filters are supported'}));
const rows=[{_nlVotes:5},{_nlVotes:100},{_nlVotes:12}];sortMatches(rows,{summary:'votes',sort:'votes'});assert.equal(rows[0]._nlVotes,100);
async function finish(args) {
  for(let i=0;i<1000;i++) {
    const r=naturalFilterPage(args);
    if(r.naturalFilter.status==='complete'||r.naturalFilter.status==='error') return r;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  throw Error('Test timeout');
}
(async()=>{
  let calls=0, plans=0;
  const args={identity:['userA','catalogA'],query:'documentary',skip:0,
    plan:async()=>{plans++;return {summary:'documentary',genres:['documentary'],sort:'votes'}},
    load:async page=>{calls++;return page<=60?Array.from({length:20},(_,i)=>({id:`tt${(page-1)*20+i}`,type:'movie',genres:['Documentary'],_nlVotes:page})):[]},
    enrich:async m=>m};
  const first=naturalFilterPage(args);assert.equal(first.naturalFilter.status,'planning');assert.equal(first.metas.length,0);
  const r=await finish(args);assert.equal(r.naturalFilter.status,'complete');assert.equal(r.naturalFilter.total,1200);assert.equal(r.naturalFilter.scanned,1200);
  assert.equal(r.metas.length,100);assert.equal(r.metas[0]._nlVotes,60);assert.equal(calls,61);assert.equal(plans,1);
  assert.equal(naturalFilterPage({...args,skip:100}).metas[0]._nlVotes,55);assert.equal(calls,61);
  const isolated=await finish({...args,identity:['userB','catalogB'],load:async()=>[]});assert.equal(isolated.naturalFilter.total,0);
  const failed=await finish({...args,identity:'failure',load:async()=>{throw Error('https://secret.example/key')}});
  assert.equal(failed.naturalFilter.status,'error');assert.equal(failed.metas.length,0);assert.ok(!failed.naturalFilter.error.includes('secret'));
  const repeated=await finish({...args,identity:'repeated',load:async()=>[{id:'tt1',type:'movie'}]});assert.equal(repeated.naturalFilter.status,'error');
  console.log('PASS: strict plans, metadata rules, subject boundaries, full 60-page scan, global sorting, pagination, reuse, user/catalog isolation, failures and repeated-page detection');
})().catch(e=>{console.error(e);process.exit(1)});
