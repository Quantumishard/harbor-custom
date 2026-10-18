const assert=require('node:assert/strict');
const {reviewNaturalFilterCandidates}=require('/app/dist/server/lib/naturalCatalogFilter');
const config={userUUID:'retry-test',apiKeys:{gemini:'fixture'},search:{ai_model:'fixture'}};
const plan={summary:'PBS',subject:'PBS original network'};
const rows=Array.from({length:5},(_,i)=>({id:'retry-'+i,name:'Fixture '+i,description:'Drama',_nlEvidence:{networks:['PBS']}}));
(async()=>{
let calls=0;
assert.deepEqual(await reviewNaturalFilterCandidates([rows[0]],plan,config,async args=>{assert.ok(args.systemPrompt.includes('valid JSON'));return{text:++calls===1?'An analysis of these titles...':'{"matches":[0]}'}}),[rows[0]]);assert.equal(calls,2);
const other={...config,userUUID:'split-test'};let large=0,small=0;
const accepted=await reviewNaturalFilterCandidates(rows,plan,other,async args=>{const batch=JSON.parse(args.prompt.split('Candidates: ')[1]);if(batch.length>2){large++;return{text:'Not JSON'}}small++;return{text:JSON.stringify({matches:batch.map((_,i)=>i)})}});
assert.deepEqual(accepted,rows);assert.ok(large>=2&&small>=2);
await assert.rejects(()=>reviewNaturalFilterCandidates([{id:'bad',name:'Bad'}],plan,config,async()=>({text:'{"matches":[99]}'})),e=>e.safeMessage?.includes('wording is supported'));
const bigRows=rows.map((m,i)=>({...m,id:'large-'+i,description:'x'.repeat(3000),_nlEvidence:{details:'x'.repeat(25000)}}));let batches=0;
await reviewNaturalFilterCandidates(bigRows,plan,config,async args=>{batches++;const batch=JSON.parse(args.prompt.split('Candidates: ')[1]);assert.equal(batch.length,1);return{text:'{"matches":[]}'}});assert.equal(batches,5);
let transientCalls=0;await reviewNaturalFilterCandidates([{id:'transient',name:'Transient'}],plan,config,async()=>{if(++transientCalls===1)throw Object.assign(Error('temporary'),{statusCode:503});return{text:'{"matches":[]}'}});assert.equal(transientCalls,2);
console.log('PASS: prose-response retry, malformed-schema rejection, recursive batch splitting, evidence-size bounds, temporary provider retry and safe exhausted-retry errors');
})().catch(e=>{console.error(e);process.exit(1)});
