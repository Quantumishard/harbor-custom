const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.argv[2]||path.resolve(__dirname,'..');const ts=require(path.join(root,'node_modules/typescript'));const cache=new Map();
function load(file){if(cache.has(file))return cache.get(file);const source=fs.readFileSync(path.join(root,'src/lib/player',file+'.ts'),'utf8');const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,console,require:name=>load(name.replace('./',''))});cache.set(file,exports);return exports}
const {generalShaderChain,shaderCompanionProps}=load('shader-chain');const {ShaderProperties}=load('shader-properties');
const settings={playerShaders:{'hdr-toys':{enabled:true,dir:'C:/shaders/hdr-toys'}},playerHdrToSdr:false,playerRtxHdr:false};
assert.equal(generalShaderChain(settings,'pq').length,5);assert.equal(shaderCompanionProps(settings,'pq')['sub-hdr-peak'],'10000');
for(const gamma of [undefined,'','bt.1886','srgb','hlg']){assert.equal(generalShaderChain(settings,gamma).length,0);assert.equal(Object.keys(shaderCompanionProps(settings,gamma)).length,0)}
assert.equal(generalShaderChain({...settings,playerHdrToSdr:true},'pq').length,0);assert.equal(generalShaderChain({...settings,playerRtxHdr:true},'pq').length,0);
(async()=>{
const values=new Map([['target-trc','auto'],['target-prim','auto'],['target-colorspace-hint','no'],['tone-mapping','auto'],['gamut-mapping-mode','auto'],['sub-hdr-peak','auto']]);const initial=Array.from(values);const writes=[];
const controller=new ShaderProperties(async name=>values.get(name),async(name,value)=>{writes.push(name);values.set(name,value)});
await controller.apply(shaderCompanionProps(settings,'pq'));assert.equal(values.get('target-trc'),'pq');assert.equal(values.get('sub-hdr-peak'),'10000');
await controller.apply(shaderCompanionProps(settings,'bt.1886'));assert.deepEqual(Array.from(values),initial);
assert.ok(writes.every(name=>!['sub-pos','sub-margin-y','sub-ass-override','image-subs-hdr-peak'].includes(name)));
values.set('sub-hdr-peak',300);await controller.apply(shaderCompanionProps(settings,'pq'));await controller.apply({});assert.equal(values.get('sub-hdr-peak'),300,'Restore an explicit user value rather than assuming auto');
let release;const waiting=new Promise(r=>release=r);const raced=new Map([['sub-hdr-peak','auto']]);const slow=new ShaderProperties(async name=>{await waiting;return raced.get(name)},async(name,value)=>raced.set(name,value));const enabled=slow.apply({'sub-hdr-peak':'10000'});await Promise.resolve();const disabled=slow.apply({});release();await Promise.all([enabled,disabled]);assert.equal(raced.get('sub-hdr-peak'),'auto');
console.log('PASS: PQ-only HDR Toys, subtitle white correction, SDR/HLG/unknown bypass, conflicts, exact property restoration, no PGS placement changes and stale-enable race');
})().catch(e=>{console.error(e);process.exit(1)});
