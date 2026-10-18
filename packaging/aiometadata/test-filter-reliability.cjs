const assert=require('node:assert/strict');
const {reviewNaturalFilterCandidates}=require('/app/dist/server/lib/naturalCatalogFilter');
const config={userUUID:'retry-test',apiKeys:{gemini:'fixture'},search:{ai_model:'fixture'}};
const plan={summary:'PBS',subject:'PBS original network'};
const rows=Array.from({length:5},(_,i)=>({id:'retry-'+i,name:'Fixture '+i,description:'Drama',_nlEvidence:{networks:['PBS']}}));
(async()=>{
let calls=0;
assert.deepEqual(await reviewNaturalFilterCandidates([rows[0]],plan,config,async args=>{assert.ok(args.systemPrompt.includes('valid JSON'));return{text:++calls===1?'An analysis of these titles...':'{"matches":[0]}'}}),[rows[0]]);assert.equal(calls,2);
await assert.rejects(()=>reviewNaturalFilterCandidates([{id:'bad',name:'Bad'}],plan,config,async()=>({text:'{"matches":[99]}'})),e=>e.safeMessage?.includes('wording is supported'));
let transientCalls=0;await reviewNaturalFilterCandidates([{id:'transient',name:'Transient'}],plan,config,async()=>{if(++transientCalls===1)throw Object.assign(Error('temporary'),{statusCode:503});return{text:'{"matches":[]}'}});assert.equal(transientCalls,2);
console.log('PASS: prose-response retry, malformed-schema rejection, bounded retries, temporary provider retry and safe exhausted-retry errors');
})().catch(e=>{console.error(e);process.exit(1)});
