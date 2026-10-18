const assert=require('node:assert/strict');
const {validatePlan,matchMeta,parseSemanticMatches,reviewNaturalFilterCandidates,naturalFilterPage}=require('/app/dist/server/lib/naturalCatalogFilter');
const mary={id:'tt1959332',type:'movie',name:'American Mary',releaseInfo:'2012',description:'A young medical student struggling to pay tuition is drawn into the shady world of underground body-modification.',keywords:['body modification','surgery']};
const descent={id:'fixture-descent',type:'movie',name:'The Descent',releaseInfo:'2005',description:'A caving expedition becomes trapped underground with dangerous creatures.',keywords:['cave','underground']};
const plan=validatePlan({summary:'Physical subterranean settings with semantic review',subject:'Films whose central action takes place physically below ground, not figurative underground subcultures',terms:[['underground','cave','caving','catacombs','tunnel']]});
assert.equal(matchMeta(mary,plan),true); // High-recall lexical candidate, not final acceptance.
assert.equal(matchMeta(descent,plan),true);
assert.deepEqual(parseSemanticMatches('{"matches":[1]}',[mary,descent]),[descent]);
assert.throws(()=>parseSemanticMatches('{"matches":[2]}',[mary,descent]));
assert.throws(()=>parseSemanticMatches('{"matches":[1,1]}',[mary,descent]));
assert.throws(()=>parseSemanticMatches('{"matches":["1"]}',[mary,descent]));
const config={userUUID:'fixture-account',apiKeys:{gemini:'fixture-key'},search:{ai_model:'fixture-selected-model'}};
let calls=0;
const generate=async args=>{calls++;assert.equal(args.model,'fixture-selected-model');assert.ok(args.prompt.includes('underground body-modification'));return{text:'{"matches":[1]}'}};
const tick=()=>new Promise(r=>setTimeout(r,2));
async function finish(args){for(let i=0;i<300;i++){const r=naturalFilterPage(args);if(['complete','partial','error'].includes(r.naturalFilter.status))return r;await tick()}throw Error('timeout')}
(async()=>{
assert.deepEqual(await reviewNaturalFilterCandidates([mary,descent],plan,config,generate),[descent]);
assert.deepEqual(await reviewNaturalFilterCandidates([mary,descent],plan,config,generate),[descent]);assert.equal(calls,1);
await reviewNaturalFilterCandidates([mary,descent],plan,{...config,userUUID:'other-account'},generate);assert.equal(calls,2);
const args={identity:'semantic-scan',query:'subterranean',skip:0,plan:async()=>plan,load:async page=>page===1?[mary,descent]:[],enrich:async row=>row,review:(rows,p)=>reviewNaturalFilterCandidates(rows,p,config,generate)};
const result=await finish(args);assert.equal(result.naturalFilter.status,'complete');assert.equal(result.naturalFilter.scanned,2);assert.deepEqual(result.metas,[descent]);
const factual={...args,identity:'factual-scan',plan:async()=>({summary:'Recent',minYear:2010}),review:rows=>reviewNaturalFilterCandidates(rows,{summary:'Recent',minYear:2010},config,()=>{throw Error('Factual filter must not call AI')})};
assert.deepEqual((await finish(factual)).metas,[mary]);
const failed={...args,identity:'failed-review',review:async()=>{throw Error('provider failure')}};assert.equal((await finish(failed)).naturalFilter.status,'error');
let release;
const pending={...args,identity:'stop-during-review',review:()=>new Promise(resolve=>{release=resolve})};naturalFilterPage(pending);
for(let i=0;i<100&&!release;i++)await tick();assert.ok(release);
const stopped=naturalFilterPage({...pending,action:'stop'});assert.equal(stopped.naturalFilter.status,'partial');assert.equal(stopped.naturalFilter.scanned,0);
release([descent]);await tick();assert.deepEqual(naturalFilterPage(pending),stopped);
const injected={...args,identity:'outside-member',review:async()=>[{id:'invented',type:'movie'}]};assert.equal((await finish(injected)).naturalFilter.status,'error');
console.log('PASS: American Mary false-positive review, positive cave title, selected model, cached positive/negative decisions, account isolation, factual fast path, candidate-only membership, stop during review and failure handling');
})().catch(e=>{console.error(e);process.exit(1)});
