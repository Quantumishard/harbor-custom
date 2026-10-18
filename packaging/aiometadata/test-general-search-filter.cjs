const assert=require('node:assert/strict');
const {validatePlan,matchMeta,reviewNaturalFilterCandidates,enrichNaturalFilterEvidence,naturalFilterProvider,planNaturalFilter,sortMatches,naturalFilterPage}=require('/app/dist/server/lib/naturalCatalogFilter');
const config={userUUID:'general-test',apiKeys:{gemini:'fixture'},search:{ai_model:'fixture'}};
const film={id:'tt123',type:'movie',name:'Fixture',description:'A family drama',releaseInfo:'2020',_tmdbId:123};
const plan=validatePlan({summary:'Studio and director',subject:'Produced by A24 and directed by Jane Doe'});
assert.equal(matchMeta(film,plan),true); // No lexical gate on production or other semantic facts.
assert.equal(matchMeta({...film,releaseInfo:'2000'},{...plan,minYear:2010}),false);
(async()=>{
let requested;
const enriched=await enrichNaturalFilterEvidence(film,{}, {movieInfo:async args=>{requested=args;return{original_language:'fr',release_date:'2020-05-01',production_companies:[{name:'A24'}],production_countries:[{name:'France'}],credits:{cast:[{name:'Actor',character:'Lead'}],crew:[{name:'Jane Doe',job:'Director',department:'Directing'}]},keywords:{keywords:[{name:'family'}]},'watch/providers':{results:{US:{flatrate:[{provider_name:'Platform'}]}}},release_dates:{results:[{iso_3166_1:'US',release_dates:[{certification:'R'}]}]}}}});
assert.equal(requested.id,123);assert.ok(requested.append_to_response.includes('credits'));
assert.deepEqual(enriched._nlEvidence.studios,['A24']);assert.equal(enriched._nlEvidence.crew[0].name,'Jane Doe');assert.equal(enriched._nlEvidence.availability[0].subscription[0],'Platform');assert.equal(enriched.originalLanguage,'fr');assert.equal(enriched.id,film.id);
let prompt;
assert.deepEqual(await reviewNaturalFilterCandidates([enriched],plan,config,async args=>{prompt=args.prompt;assert.equal(args.useGrounding,false);return{text:'{"matches":[0]}'}}),[enriched]);assert.ok(prompt.includes('A24'));assert.ok(prompt.includes('Jane Doe'));assert.ok(prompt.includes('complete natural-language search constraint'));
const unavailable=await enrichNaturalFilterEvidence(film,{}, {movieInfo:async()=>{throw Error('private-url')}});assert.deepEqual(unavailable._nlEvidence,{metadataAvailable:false});
const tv=await enrichNaturalFilterEvidence({...film,type:'series'}, {}, {tvInfo:async()=>({networks:[{name:'HBO'}],created_by:[{name:'Creator'}],first_air_date:'2021-01-01',credits:{}})});assert.deepEqual(tv._nlEvidence.networks,['HBO']);assert.deepEqual(tv._nlEvidence.creators,['Creator']);
assert.equal(naturalFilterProvider(config).name,'gemini');
const rankedPlan=validatePlan({summary:'Largest budgets',orderBy:'production budget in USD',orderDirection:'desc',limit:1});
const rankedRows=[{...enriched,id:'one'},{...enriched,id:'two'}];
await reviewNaturalFilterCandidates(rankedRows,rankedPlan,config,async()=>({text:'{"matches":[0,1],"ranks":[{"index":0,"value":10},{"index":1,"value":90}]}'}));
sortMatches(rankedRows,rankedPlan);assert.equal(rankedRows[0].id,'two');
const args={identity:'general-ranked',query:'highest budget',skip:0,plan:async()=>rankedPlan,load:async page=>page===1?rankedRows:[],enrich:async x=>x};
let snapshot;for(let i=0;i<100;i++){snapshot=naturalFilterPage(args);if(snapshot.naturalFilter.status==='complete')break;await new Promise(r=>setTimeout(r,2))}
assert.equal(snapshot.naturalFilter.scanned,2);assert.equal(snapshot.naturalFilter.total,1);assert.equal(snapshot.metas.length,1);assert.equal(snapshot.metas[0].id,'two');
assert.throws(()=>validatePlan({summary:'Bad limit',limit:0}));
assert.throws(()=>validatePlan({summary:'Bad direction',orderBy:'budget',orderDirection:'sideways'}));
await assert.rejects(()=>reviewNaturalFilterCandidates([{...enriched,id:'bad-rank'}],rankedPlan,config,async()=>({text:'{"matches":[0],"ranks":[]}'})));
const router=naturalFilterProvider({apiKeys:{openrouter:'fixture'},search:{ai_provider:'openrouter',ai_model:'chosen/model',ai_openrouter_web_search:true}});assert.equal(router.model,'chosen/model:online');assert.equal(router.useGrounding,true);
assert.equal(naturalFilterProvider({apiKeys:{openrouter:'fixture'},search:{ai_provider:'openrouter',ai_model:'chosen/model:online',ai_openrouter_web_search:false}}).model,'chosen/model');
// Older-model unsupported responses preserve the whole request for general evaluation.
const client=require('/app/dist/server/utils/gemini-client');const original=client.generateContent;
client.generateContent=async()=>({text:'{"unsupported":"Networks are unsupported"}'});
try {const fallback=await planNaturalFilter('HBO or (A24 and not a sequel)',config);assert.equal(fallback.subject,'HBO or (A24 and not a sequel)')} finally {client.generateContent=original}
console.log('PASS: general constraints without lexical gate, production/credit/network/availability evidence, unavailable evidence, shared factual limits, provider/grounding parity and unsupported-plan fallback');
})().catch(e=>{console.error(e);process.exit(1)});
