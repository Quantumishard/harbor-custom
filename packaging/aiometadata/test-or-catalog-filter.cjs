const assert=require('node:assert/strict');
const {validatePlan,matchMeta,reviewNaturalFilterCandidates,naturalFilterPage}=require('/app/dist/server/lib/naturalCatalogFilter');
const plan=validatePlan({summary:'Regional language OR theme',minYear:2010,sort:'newest',anyOf:[{summary:'Thai language',languages:['th']},{summary:'Regional theme',subject:'Central Thai setting or folklore',terms:[['thai','thailand']]}]});
const thai={id:'thai',type:'movie',name:'Language branch',originalLanguage:'th',releaseInfo:'2012',description:'An ordinary family drama'};
const theme={id:'theme',type:'movie',name:'Theme branch',originalLanguage:'en',releaseInfo:'2020',description:'A Thai folklore story set in Thailand'};
const both={...theme,id:'both',originalLanguage:'th',releaseInfo:'2018'};
const incidental={...theme,id:'incidental',description:'An American story mentions Thai food once'};
const unrelated={...thai,id:'unrelated',originalLanguage:'en'};
assert.equal(matchMeta(thai,plan),true);assert.equal(matchMeta(theme,plan),true);
assert.equal(matchMeta({...theme,originalLanguage:undefined},plan),true);
assert.equal(matchMeta({...thai,releaseInfo:'2000'},plan),false);
assert.equal(matchMeta(unrelated,plan),true); // Semantic review decides relevance.
assert.equal(matchMeta({...unrelated,originalLanguage:undefined},plan),true); // Theme can qualify independently.
for(const invalid of [{anyOf:[]},{anyOf:[{summary:'empty'},{summary:'x',languages:['th']}]},{anyOf:[{...plan},{summary:'x',languages:['th']}]},{anyOf:[{summary:'x',languages:['th'],sort:'newest'},{summary:'y',languages:['en']}]}])assert.throws(()=>validatePlan({summary:'Invalid',...invalid}));
const config={userUUID:'or-test',apiKeys:{gemini:'fixture'},search:{ai_model:'fixture'}};
let calls=0;const generate=async args=>{calls++;const rows=JSON.parse(args.prompt.split('Candidates: ')[1]);return{text:JSON.stringify({matches:rows.flatMap((r,i)=>r.plot.includes('Thai folklore')?[i]:[])})}};
const tick=()=>new Promise(r=>setTimeout(r,2));
(async()=>{
assert.deepEqual(await reviewNaturalFilterCandidates([thai],plan,config,()=>{throw Error('Language match should not need semantic review')}),[thai]);
assert.deepEqual(await reviewNaturalFilterCandidates([thai,theme,both,incidental],plan,config,generate),[thai,theme,both]);assert.equal(calls,1);
const args={identity:'or-union',query:'regional',skip:0,plan:async()=>plan,load:async page=>page===1?[thai,theme,both,incidental,unrelated]:[],enrich:async x=>x,review:(rows,p)=>reviewNaturalFilterCandidates(rows,p,config,generate)};
let result;for(let i=0;i<300;i++){result=naturalFilterPage(args);if(result.naturalFilter.status==='complete')break;await tick()}
assert.equal(result.naturalFilter.status,'complete');assert.deepEqual(result.metas.map(x=>x.id),['theme','both','thai']);assert.deepEqual(naturalFilterPage(args),result);
console.log('PASS: alternative rules, shared limits, unknown metadata, independent language acceptance, semantic relevance, deduplication, global sorting and cached results');
})().catch(e=>{console.error(e);process.exit(1)});
