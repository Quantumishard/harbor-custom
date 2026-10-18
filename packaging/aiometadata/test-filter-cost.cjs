const assert=require('node:assert/strict');
const lib=require('/app/dist/server/lib/naturalCatalogFilter');
const config={apiKeys:{gemini:'fixture'},userUUID:'cost-test',search:{ai_model:'fixture'}};
const fact=lib.validatePlan({summary:'PBS',facts:[{field:'companies',values:['PBS','Public Broadcasting Service']}]});
const pbs={id:'pbs',type:'series',name:'Fixture',_nlEvidence:{metadataAvailable:true,networks:['PBS'],studios:[],crew:[{name:'Jane Doe',job:'Director'}],cast:[{name:'Actor'}],region:'US',availability:[]}};
assert.equal(lib.matchMeta(pbs,fact),true);assert.equal(lib.matchMeta({...pbs,_nlEvidence:{metadataAvailable:true,networks:['HBO'],studios:[]}},fact),false);assert.equal(lib.matchMeta({id:'missing'},fact),null);
assert.equal(lib.matchMeta(pbs,{summary:'Director',facts:[{field:'directors',values:['Jane Doe']}]}),true);
assert.equal(lib.matchMeta(pbs,{summary:'Exclude',facts:[{field:'networks',values:['PBS'],exclude:true}]}),false);
assert.throws(()=>lib.validatePlan({summary:'bad',facts:[{field:'anything',values:['x']}]}));
const finish=async args=>{for(let i=0;i<1000;i++){const r=lib.naturalFilterPage(args);if(['partial','complete','error'].includes(r.naturalFilter.status))return r;await new Promise(r=>setTimeout(r,2))}throw Error('Timeout')};
(async()=>{
const planned=await lib.planNaturalFilter('pbs',{});assert.ok(planned.facts); // No key/provider/model call.
assert.deepEqual(await lib.reviewNaturalFilterCandidates([pbs],fact,{},()=>{throw Error('Factual filtering must not call AI')}),[pbs]);
const budget=lib.createFilterBudget();let calls=0;const generate=async args=>{calls++;assert.equal(args.useGrounding,false);assert.equal(args.model,'chosen/model');assert.equal(args.maxTokens,512);assert.equal(args.maxOutputTokens,512);return{text:'{}'}};
for(let i=0;i<2;i++)await lib.budgetedFilterGenerate(generate,{model:'chosen/model:online',prompt:'x'},budget);
await assert.rejects(()=>lib.budgetedFilterGenerate(generate,{model:'chosen/model',prompt:'x'},budget),e=>e.budgetReached);assert.equal(calls,2);
await assert.rejects(()=>lib.budgetedFilterGenerate(generate,{prompt:'x'.repeat(8001)},lib.createFilterBudget()),e=>e.budgetReached);assert.equal(calls,2);
const args={identity:'budget-partial',query:'themes',skip:0,plan:async()=>({summary:'Theme',subject:'Theme'}),load:async page=>page===1?Array.from({length:100},(_,i)=>({id:'t'+i,type:'movie',name:'Fixture'})):[],enrich:async x=>x,review:async(rows,p,b)=>{await lib.budgetedFilterGenerate(async()=>({text:'{}'}),{prompt:'x'.repeat(3000)},b);return rows}};
const result=await finish(args);assert.equal(result.naturalFilter.status,'partial');assert.equal(result.naturalFilter.scanned,8);assert.equal(result.metas.length,8);assert.ok(result.naturalFilter.summary.includes('budget reached'));assert.deepEqual(lib.naturalFilterPage(args),result);
const full=await finish({...args,identity:'facts-unlimited',plan:async()=>fact,load:async page=>page<=10?Array.from({length:100},(_,i)=>({...pbs,id:page+'-'+i})):[],review:rows=>lib.reviewNaturalFilterCandidates(rows,fact,{},()=>{throw Error('No AI')})});assert.equal(full.naturalFilter.status,'complete');assert.equal(full.naturalFilter.scanned,1000);
let retries=0;await assert.rejects(()=>lib.reviewNaturalFilterCandidates([{id:'invalid',name:'Fixture'}],{summary:'Theme',subject:'Theme'},config,async()=>{retries++;return{text:'An analysis'}} ,lib.createFilterBudget()),e=>e.safeMessage?.includes('unreadable'));assert.equal(retries,2);
let captured;await lib.reviewNaturalFilterCandidates([{id:'compact',name:'Fixture',description:'x'.repeat(10000),_nlEvidence:{metadataAvailable:true,availability:'secret-large-payload'.repeat(1000),crew:Array(100).fill({name:'Actor'}),networks:['PBS']}}],{summary:'Theme',subject:'Theme'},config,async args=>{captured=args.prompt;return{text:'{"matches":[]}'}} ,lib.createFilterBudget());assert.ok(captured.length<6000);assert.ok(!captured.includes('secret-large-payload'));
console.log('PASS: PBS zero AI, factual metadata matching and full scan, two-call/8KB cap, output limits, no grounding, partial results within first page, bounded retries and compact evidence');
})().catch(e=>{console.error(e);process.exit(1)});
