import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {sanitizeUsage} from '../scripts/usage-metadata.mjs';
import {createDisplayProxy} from '../scripts/status-display-proxy.mjs';

const iso=ms=>new Date(ms).toISOString();
const make=(now)=>{
  const row=(family,scope,period,remaining)=>({model_family:family,quota_scope:scope,period,window_id:'secondary',status:'available',remaining_percent:remaining,used_percent:100-remaining,reset_at:iso(now+86400000),observed_at:iso(now)});
  return {display_schema_version:1,view_read_at:iso(now),token:'SYNTHETIC_DO_NOT_EXPORT',cards:[
    {provider:'codex',title:'SYNTHETIC_DO_NOT_EXPORT',status:'partial',error_kind:null,account_alignment:'not_verified',collected_at:iso(now),snapshot_updated_at:iso(now),provider_updated_at:null,last_success_collected_at:iso(now),current_rows:[row('codex','own_subscription','weekly',42),{...row('codex','own_subscription','five_hour',100),status:'not_reported',remaining_percent:null,used_percent:null}],last_known_rows:[row('codex','own_subscription','weekly',42)]},
    {provider:'claude',status:'fetch_failed',error_kind:'rate_limited',account_alignment:'not_verified',collected_at:null,last_success_collected_at:iso(now-7200000),current_rows:[],last_known_rows:[{...row('claude','own_subscription','five_hour',100),reset_at:iso(now-1000),observed_at:iso(now-7200000)}]},
    {provider:'antigravity',status:'fetch_failed',error_kind:'executable_not_found',account_alignment:'not_verified',collected_at:null,last_success_collected_at:iso(now-7200000),current_rows:[],last_known_rows:[{...row('claude','antigravity_shared','weekly',31),window_id:'g1_b0',observed_at:null}]}
  ]};
};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const stop=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});
const clean=dir=>{assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});};

test('metadata allowlist separates own/shared and periods; unknown/private fields never leave server',()=>{
  const now=Date.parse('2025-01-01T00:00:00Z');const input=make(now);
  input.cards[0].current_rows.push({...input.cards[2].last_known_rows[0],label:'SYNTHETIC_DO_NOT_EXPORT'});
  input.cards[1].error_message='SYNTHETIC_DO_NOT_EXPORT';
  const value=sanitizeUsage(input,now);
  assert.equal(value.cards[0].current_rows.length,2);
  assert.equal(value.cards[0].current_rows[0].remaining_percent,42);
  assert.equal(value.cards[0].current_rows[1].remaining_percent,null);
  assert.equal(value.cards[1].last_known_rows[0].quota_scope,'own_subscription');
  assert.equal(value.cards[2].last_known_rows[0].quota_scope,'antigravity_shared');
  assert.equal(value.cards[2].last_known_rows[0].model_family,'claude');
  assert.equal(value.cards[0].provider_updated_at,null);
  assert.ok(!JSON.stringify(value).includes('SYNTHETIC_DO_NOT_EXPORT'));
});

test('stale/reset/future/account mismatch invalidate current values; reset never invents 100%',()=>{
  const now=Date.parse('2025-01-01T00:00:00Z');
  let input=make(now);input.cards[0].stale_after_seconds=999999;
  assert.equal(sanitizeUsage(input,now+3601000).cards[0].current_rows[0].remaining_percent,null);
  assert.equal(sanitizeUsage(input,now+3601000).cards[0].last_known_rows[0].remaining_percent,42);
  input=make(now);input.cards[0].current_rows[0].reset_at=iso(now-1);
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  input=make(now);input.cards[0].current_rows[0].observed_at=iso(now+120000);
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  input=make(now);input.cards[0].collected_at=iso(now-7200000);
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  assert.equal(sanitizeUsage(make(now),now).cards[2].last_known_rows[0].observed_at,null);
  input=make(now);input.cards[0].account_alignment='mismatch';
  assert.equal(sanitizeUsage(input,now).cards[0].last_known_rows[0].remaining_percent,null);
  input=make(now);input.cards[0].current_rows[0].used_percent='58';
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
});

test('loopback metadata is read-only, refreshes file, fails closed without paths; official API is unchanged',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'usage-http-'));const file=path.join(dir,'usage.json');
  writeFileSync(file,JSON.stringify(make(Date.now())));
  const fixture=http.createServer((req,res)=>{res.setHeader('content-type',req.url==='/'?'text/html':'application/json');res.end(req.url==='/'?'<html><head></head><body>official</body></html>':'["Verifying"]');});
  const upstreamPort=await listen(fixture);const proxy=createDisplayProxy(upstreamPort,{usageFile:file});const port=await listen(proxy);
  try {
    const base=`http://127.0.0.1:${port}`;
    assert.match(await(await fetch(base)).text(),/usage-display.js/);
    const first=await fetch(`${base}/__dashboard/usage`);assert.equal(first.headers.get('cache-control'),'no-store');
    const raw=await first.text();assert.ok(!raw.includes('SYNTHETIC_DO_NOT_EXPORT'));assert.ok(!raw.includes(file));
    assert.equal(JSON.parse(raw).cards[0].current_rows[0].remaining_percent,42);
    const next=make(Date.now());next.cards[0].current_rows[0].remaining_percent=41;next.cards[0].current_rows[0].used_percent=59;writeFileSync(file,JSON.stringify(next));
    assert.equal((await(await fetch(`${base}/__dashboard/usage`)).json()).cards[0].current_rows[0].remaining_percent,41);
    assert.equal((await fetch(`${base}/__dashboard/usage`,{method:'POST',body:'{}'})).status,405);
    const wrongHost=await new Promise((resolve,reject)=>{const request=http.get(`${base}/__dashboard/usage`,{headers:{Host:'outside.invalid'}},res=>{res.resume();resolve(res.statusCode);});request.on('error',reject);});
    assert.equal(wrongHost,403);
    assert.equal(await(await fetch(`${base}/api/statuses`)).text(),'["Verifying"]');
    writeFileSync(file,'invalid SYNTHETIC_DO_NOT_EXPORT');
    const invalid=await fetch(`${base}/__dashboard/usage`);assert.equal(invalid.status,503);assert.equal(await invalid.text(),'{"status":"unavailable"}');
  }finally{await stop(proxy);await stop(fixture);clean(dir);}
});

test('headless synthetic UI displays missing/failures/shared Claude/history without HTML or secret interpolation',async()=>{
  const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';assert.ok(existsSync(chrome));
  const dir=mkdtempSync(path.join(tmpdir(),'usage-dom-'));const file=path.join(dir,'usage.json');const input=make(Date.now());input.cards[2].model_references=modelFixture(Date.now()).cards[2].model_references;writeFileSync(file,JSON.stringify(input));
  const fixture=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<html><head></head><body><div id="root"><div id="synthetic-board" style="background:#f9fafb;color:#111827;font-family:Arial,sans-serif"><h1>official synthetic fixture</h1></div></div><script>setTimeout(()=>document.body.setAttribute("data-quota-light",getComputedStyle(document.getElementById("dashboard-usage")).backgroundColor),500);setTimeout(()=>{const b=document.getElementById("synthetic-board");b.style.backgroundColor="#111827";b.style.color="#f9fafb";document.documentElement.classList.add("dark")},600);setTimeout(()=>{const p=document.getElementById("dashboard-usage");document.body.setAttribute("data-quota-height",Math.ceil(p.getBoundingClientRect().height));document.body.setAttribute("data-quota-overflow",document.documentElement.scrollWidth>innerWidth);document.body.setAttribute("data-quota-dark",getComputedStyle(p).backgroundColor);document.body.setAttribute("data-quota-font-match",getComputedStyle(p).fontFamily===getComputedStyle(document.getElementById("synthetic-board")).fontFamily)},1300)</script></body></html>');});
  const upstreamPort=await listen(fixture);const proxy=createDisplayProxy(upstreamPort,{usageFile:file});const port=await listen(proxy);
  const profile=mkdtempSync(path.join(tmpdir(),'usage-chrome-'));
  try {
    const {stdout}=await promisify(execFile)(chrome,['--headless','--window-size=1280,800','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--dump-dom','--virtual-time-budget=1500',`http://127.0.0.1:${port}`],{timeout:30000,maxBuffer:2*1024*1024});
    assert.match(stdout,/codex \/ 週間：残42%/);assert.match(stdout,/短期5時間：— \(未報告\)/);
    assert.match(stdout,/取得制限中（cooldown）/);assert.match(stdout,/タスク環境でCLI未検出/);
    assert.match(stdout,/AG内部 claude \/ 週間/);assert.match(stdout,/前回残31%/);
    assert.match(stdout,/前回参考（現在値ではありません）/);assert.match(stdout,/reset経過/);
    assert.match(stdout,/provider更新：未提供/);assert.ok(!stdout.includes('SYNTHETIC_DO_NOT_EXPORT'));
    assert.ok(Number(stdout.match(/data-quota-height="(\d+)"/)[1])<=96);assert.match(stdout,/data-quota-overflow="false"/);assert.match(stdout,/data-quota-light="rgb\(249, 250, 251\)"/);assert.match(stdout,/data-quota-dark="rgb\(17, 24, 39\)"/);assert.match(stdout,/data-quota-font-match="true"/);assert.match(stdout,/GPT-OSS-120b/);assert.match(stdout,/Claude Opus 5\.5 \(thinking\)/);assert.match(stdout,/Claude Sonnet 5\.5 \(thinking\)/);
    assert.equal((stdout.match(/個別使用率・残率・resetは未提供/g)||[]).length,3);assert.match(stdout,/共有枠の現在値も未取得/);
  }finally{await stop(proxy);await stop(fixture);clean(profile);clean(dir);}
});

test('collector contract: exact TTL, provider timestamp rules, invalid dates, attempts and recovery',()=>{
  const now=Date.parse('2025-01-01T00:00:00Z');
  assert.equal(sanitizeUsage(make(now),now+3600000).cards[0].current_rows[0].remaining_percent,42);
  assert.equal(sanitizeUsage(make(now),now+3600001).cards[0].current_rows[0].remaining_percent,null);
  let input=make(now);input.cards[0].current_rows[0].observed_at=null;
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  input=make(now);input.cards[0].current_rows[0].observed_at=iso(now+1);
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  input=make(now);input.cards[0].collected_at=iso(now+1);
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  for(const date of [null,'2025-01-01T00:00:00','2025-02-30T00:00:00Z','9999-12-31T23:59:59-23:59']){
    input=make(now);input.cards[0].current_rows[0].reset_at=date;
    assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  }
  input=make(now);input.cards[0].current_rows[0].reset_at=iso(now);
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  input=make(now);input.cards[0].status='fetch_failed';
  assert.equal(sanitizeUsage(input,now).cards[0].current_rows[0].remaining_percent,null);
  input.cards[0].status='available';input.cards[0].collected_at='2025-01-01T09:00:00+09:00';
  input.cards[0].attempt_started_at='2025-01-01T09:00:00+09:00';input.cards[0].attempt_finished_at=iso(now);input.cards[0].retry_not_before=iso(now+1800000);
  const recovered=sanitizeUsage(input,now).cards[0];assert.equal(recovered.current_rows[0].remaining_percent,42);assert.equal(recovered.attempt_started_at,iso(now));assert.equal(recovered.attempted_at,null);assert.equal(recovered.retry_not_before,iso(now+1800000));
  input=make(now);const shared=input.cards[2];shared.status='available';shared.collected_at=iso(now);shared.current_rows=[{...shared.last_known_rows[0],status:'available',reset_at:iso(now+86400000)}];
  assert.equal(sanitizeUsage(input,now).cards[2].current_rows[0].remaining_percent,31);
  assert.equal(sanitizeUsage(input,now).cards[2].current_rows[0].observed_at,null);
  shared.acquisition_source='statusline';assert.equal(sanitizeUsage(input,now).cards[2].current_rows[0].remaining_percent,null);
});

// Controlled browser clock; no live browser or provider calls.
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
test('display rechecks static DTO on TTL/reset/clock changes and recovers after read failure',async()=>{
  const initial=Date.parse('2025-01-01T00:00:00Z');let now=initial,fail=false,dto=sanitizeUsage(make(initial),initial);
  const intervals=new Map();
  class Element {constructor(){this.children=[];this.textContent='';this.style={};}setAttribute(){}append(value){this.children.push(value);}prepend(value){this.children.unshift(value);}replaceChildren(){this.children=[];}}
  const body=new Element();
  class Clock extends Date {static now(){return now;}}
  const context={Date:Clock,document:{readyState:'complete',body,createElement:()=>new Element()},fetch:async()=>{if(fail)throw Error('offline');return{ok:true,json:async()=>dto};},setInterval:(fn,delay)=>intervals.set(delay,fn)};
  const text=element=>[element.textContent,...element.children.map(text)].join(' ');
  runInNewContext(readFileSync(new URL('../scripts/usage-display.js',import.meta.url),'utf8'),context);await new Promise(setImmediate);
  assert.match(text(body),/codex \/ 週間：残42%/);
  now=initial+3600000;intervals.get(1000)();assert.match(text(body),/codex \/ 週間：残42%/);
  now++;intervals.get(1000)();assert.doesNotMatch(text(body),/codex \/ 週間：残42%/);assert.match(text(body),/前回残42%/);
  now=initial-1;intervals.get(1000)();assert.match(text(body),/時計ずれ・欠測/);assert.doesNotMatch(text(body),/codex \/ 週間：残42%/);
  now=initial;let input=make(now);input.cards[0].current_rows[0].reset_at=iso(now+1000);dto=sanitizeUsage(input,now);await intervals.get(30000)();
  now+=1000;intervals.get(1000)();assert.match(text(body),/reset経過・欠測/);assert.doesNotMatch(text(body),/codex \/ 週間：残42%/);
  now=initial;dto=sanitizeUsage(make(now),now);await intervals.get(30000)();fail=true;await intervals.get(30000)();
  assert.match(text(body),/表示通信に失敗/);assert.doesNotMatch(text(body),/codex \/ 週間：残42%/);
  fail=false;now+=2000;dto=sanitizeUsage(make(now),now);await intervals.get(30000)();assert.match(text(body),/codex \/ 週間：残42%/);assert.doesNotMatch(text(body),/表示通信に失敗/);
});

function modelFixture(now){
  const value=make(now-1200000),card=value.cards[2];
  card.status='available';card.error_kind=null;card.collected_at=iso(now-1200000);card.last_success_collected_at=card.collected_at;
  card.current_rows=['five_hour','weekly'].map((period,index)=>({window_id:`g1_b${index}`,quota_scope:'antigravity_shared',model_family:'claude',shared_pool:'claude_gpt_shared',period,status:'available',used_percent:0,remaining_percent:100,observed_at:null,reset_at:iso(now+(period==='weekly'?172800000:7200000))}));
  card.last_known_rows=structuredClone(card.current_rows);
  card.model_references=['gpt_oss_120b','claude_opus_5_5','claude_sonnet_5_5'].map(model_id=>({model_id,official_name:'SYNTHETIC_DO_NOT_EXPORT',quota_scope:'antigravity_shared_reference',independent_quota_status:'available',quota_status:'shared_pool_only',used_percent:0,remaining_percent:100,reset_at:iso(now+999999),shared_pool:'claude_gpt_shared',shared_window_ids:['g1_b0','g1_b1'],pool_mapping_source:'official_models_documentation',pool_mapping_url:'https://antigravity.google/docs/models/',catalog_confirmation:'observed_in_cli_catalog',catalog_observed_at:iso(now-60000),identity:'SYNTHETIC_DO_NOT_EXPORT'}));
  return value;
}

test('AG model refs use fixed names and one shared pool, never copy individual quota or reset',()=>{
  const now=Date.parse('2025-01-01T00:30:00Z'),input=modelFixture(now);
  input.cards[2].model_references.push({...input.cards[2].model_references[0]},{...input.cards[2].model_references[0],model_id:'gpt_oss_125b'},{model_id:{toString:'bad'}});
  const card=sanitizeUsage(input,now).cards[2];assert.equal(card.current_rows.length,2);assert.equal(card.model_references.length,3);
  assert.deepEqual(card.model_references.map(row=>row.official_name),['GPT-OSS-120b','Claude Opus 5.5 (thinking)','Claude Sonnet 5.5 (thinking)']);
  for(const reference of card.model_references){assert.equal(reference.independent_quota_status,'not_provided');assert.equal(reference.remaining_percent,null);assert.equal(reference.used_percent,null);assert.equal(reference.reset_at,null);assert.equal(reference.quota_status,'shared_pool_only');assert.deepEqual(reference.shared_window_ids,['g1_b0','g1_b1']);}
  assert.equal(card.collected_at,iso(now-1200000));assert.equal(card.model_references[0].catalog_observed_at,iso(now-60000));assert.ok(!JSON.stringify(card).includes('SYNTHETIC_DO_NOT_EXPORT'));
  const invalid=modelFixture(now);invalid.cards[2].model_references[0].pool_mapping_url='https://outside.invalid/SYNTHETIC_DO_NOT_EXPORT';const ref=sanitizeUsage(invalid,now).cards[2].model_references[0];assert.equal(ref.shared_pool,null);assert.deepEqual(ref.shared_window_ids,[]);assert.equal(ref.pool_mapping_url,null);
});

test('AG references lose current links on stale/reset/failure and conflicting pool rows',()=>{
  const now=Date.parse('2025-01-01T00:30:00Z');
  const stale=sanitizeUsage(modelFixture(now),now+2400001).cards[2];assert.ok(stale.model_references.every(ref=>ref.quota_status==='not_provided'&&ref.shared_window_ids.length===0));
  let input=modelFixture(now);input.cards[2].current_rows[0].reset_at=iso(now);assert.deepEqual(sanitizeUsage(input,now).cards[2].model_references[0].shared_window_ids,['g1_b1']);
  input=modelFixture(now);input.cards[2].status='fetch_failed';assert.ok(sanitizeUsage(input,now).cards[2].model_references.every(ref=>ref.shared_window_ids.length===0));
  input=modelFixture(now);input.cards[2].current_rows.push({...input.cards[2].current_rows[0],model_family:'gpt_oss',window_id:'g1_b2'});assert.equal(sanitizeUsage(input,now).cards[2].current_rows.length,2);
  for(const row of structuredClone(input.cards[2].current_rows.slice(0,2)))input.cards[2].current_rows.push({...row,remaining_percent:40,used_percent:60,window_id:'g1_b3'});
  const conflict=sanitizeUsage(input,now).cards[2];assert.equal(conflict.current_rows.length,2);assert.ok(conflict.current_rows.every(row=>row.remaining_percent===null));assert.ok(conflict.model_references.every(ref=>ref.shared_window_ids.length===0));
});

test('AG synthetic display labels shared numbers once and reevaluates model links without catalog freshness',async()=>{
  const initial=Date.parse('2025-01-01T00:30:00Z');let now=initial,fail=false,dto=sanitizeUsage(modelFixture(initial),initial);
  const intervals=new Map();class Element{constructor(){this.children=[];this.textContent='';this.style={};}setAttribute(){}append(item){this.children.push(item);}prepend(item){this.children.unshift(item);}replaceChildren(){this.children=[];}}
  const body=new Element();class Clock extends Date{static now(){return now;}}
  const context={Date:Clock,document:{readyState:'complete',body,createElement:()=>new Element()},fetch:async()=>{if(fail)throw Error('offline');return{ok:true,json:async()=>dto};},setInterval:(fn,delay)=>intervals.set(delay,fn)};
  const text=element=>[element.textContent,...element.children.map(text)].join(' ');
  runInNewContext(readFileSync(new URL('../scripts/usage-display.js',import.meta.url),'utf8'),context);await new Promise(setImmediate);
  const rendered=text(body);assert.match(rendered,/GPT-OSS-120b/);assert.match(rendered,/Claude Opus 5\.5 \(thinking\)/);assert.match(rendered,/Claude Sonnet 5\.5 \(thinking\)/);assert.equal((rendered.match(/AG Claude \/ GPT共有枠 \/ 週間：残100%/g)||[]).length,1);assert.equal((rendered.match(/AG Claude \/ GPT共有枠 \/ 短期5時間：残100%/g)||[]).length,1);assert.equal((rendered.match(/個別使用率・残率・resetは未提供/g)||[]).length,3);assert.ok(!rendered.includes('SYNTHETIC_DO_NOT_EXPORT'));
  now=initial+2400001;intervals.get(1000)();assert.equal((text(body).match(/共有枠の現在値も未取得/g)||[]).length,3);assert.doesNotMatch(text(body),/週間：残100%/);
  now=initial;fail=true;await intervals.get(30000)();assert.equal((text(body).match(/共有枠の現在値も未取得/g)||[]).length,3);
  fail=false;dto=sanitizeUsage(modelFixture(now),now);await intervals.get(30000)();assert.match(text(body),/共有値は上の共有欄を参照/);
});

test('fixed reset contract always has eight windows and never trusts supplied recovery or private fields',()=>{
 const now=Date.parse('2025-01-01T00:30:00Z');const input=modelFixture(now);
 input.cards[0].reset_windows=[{period:'five_hour',resetAt:iso(now+1000),recoveryConfirmed:true,secret:'SYNTHETIC_DO_NOT_EXPORT'}];
 let dto=sanitizeUsage(input,now);assert.equal(dto.cards.flatMap(c=>c.reset_windows).length,8);
 assert.equal(dto.cards[0].reset_windows[0].state,'not_reported');assert.equal(dto.cards[0].reset_windows[0].resetAt,null);
 assert.ok(dto.cards.flatMap(c=>c.reset_windows).every(w=>w.recoveryConfirmed===false));
 assert.ok(!JSON.stringify(dto).includes('SYNTHETIC_DO_NOT_EXPORT'));
 input.cards[2].current_rows[0].reset_at=iso(now);dto=sanitizeUsage(input,now);
 assert.equal(dto.cards[2].reset_windows.find(w=>w.shared_pool==='claude_gpt_shared'&&w.period==='five_hour').state,'awaiting_refresh');
 input.cards[2].status='fetch_failed';dto=sanitizeUsage(input,now);assert.ok(dto.cards[2].reset_windows.every(w=>w.state==='fetch_failed'));
 dto=sanitizeUsage(modelFixture(now),now+3600001);assert.ok(dto.cards[2].reset_windows.every(w=>w.state==='stale'||w.state==='missing'));
});

test('compact summary keeps current/reference/unknown separate and hides reset detail',async()=>{
 const initial=Date.parse('2025-01-01T00:30:00Z');let now=initial,reads=0,fail=false;const input=modelFixture(now);
 input.cards[2].current_rows[0].reset_at=iso(now+2000);let dto=sanitizeUsage(input,now);const intervals=new Map();
 class Element{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.style={};}setAttribute(){}append(x){this.children.push(x);}prepend(x){this.children.unshift(x);}replaceChildren(){this.children=[];}}
 const body=new Element('body');class Clock extends Date{static now(){return now;}}
 runInNewContext(readFileSync(new URL('../scripts/usage-display.js',import.meta.url),'utf8'),{Date:Clock,document:{readyState:'complete',body,createElement:tag=>new Element(tag)},fetch:async url=>{assert.equal(url,'/__dashboard/usage');reads++;if(fail)throw Error('offline');return{ok:true,json:async()=>dto};},setInterval:(fn,delay)=>intervals.set(delay,fn)});await new Promise(setImmediate);
 const text=e=>[e.textContent,...e.children.map(text)].join(' '),summary=()=>body.children[0].children.find(e=>e.tag==='div'),details=()=>body.children[0].children.find(e=>e.tag==='details');
 assert.doesNotMatch(body.children[0].style.cssText,/sticky|fixed/);assert.equal(details().open,false);assert.equal(summary().children.length,5);
 const colors=summary().children.map(e=>e.style.cssText).join(' ');for(const color of ['#2563eb','#c2410c','#7c3aed'])assert.ok(colors.includes(color));
 assert.match(text(summary()),/5h —/);assert.match(text(summary()),/5h 100%/);assert.doesNotMatch(text(summary()),/reset|秒|採集|現在値ではありません/);assert.match(text(details()),/0日 0時間 0分 2秒/);
 now+=2000;intervals.get(1000)();assert.match(text(details()),/0秒・再取得確認待ち/);assert.match(text(summary()),/5h 100% 参考/);assert.equal(reads,1);
 now=initial+3600001;intervals.get(1000)();assert.match(text(details()),/古い取得値/);assert.match(text(summary()),/週 100% 参考/);
 fail=true;await intervals.get(30000)();assert.match(text(details()),/表示通信失敗/);assert.equal(reads,2);
 fail=false;const updated=make(now);updated.cards[0].current_rows[0].used_percent=43;updated.cards[0].current_rows[0].remaining_percent=57;dto=sanitizeUsage(updated,now);const acquired=new Date(now).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'});await intervals.get(30000)();assert.match(text(summary()),/週 57%/);assert.ok(text(summary()).includes('取得 '+acquired));now+=600000;intervals.get(1000)();assert.ok(text(summary()).includes('取得 '+acquired));assert.equal(reads,3);
});

test('TASK-17: sanitizeUsage accurately sanitizes MiMo money, ISO currency validation, stale preservation, mismatch wipe, and failures', () => {
  const now = Date.parse('2025-01-01T12:00:00Z');
  const baseMimo = (over = {}) => ({
    display_schema_version: 1,
    view_read_at: iso(now),
    cards: [{
      provider: 'mimo',
      status: 'available',
      account_alignment: 'verified',
      collected_at: iso(now),
      last_success_collected_at: iso(now),
      stale_after_seconds: 3600,
      balance: { amount: 12.34, currency: 'USD', observed_at: iso(now) },
      last_known_balance: null,
      ...over
    }]
  });

  // 1. Normal USD 12.34: verified ISO currency, not stale
  const normal = sanitizeUsage(baseMimo(), now);
  const card = normal.cards[0];
  assert.equal(card.provider, 'mimo');
  assert.equal(card.balance.amount, 12.34);
  assert.equal(card.balance.currency, 'USD');
  assert.equal(card.balance.currency_verified, true);
  assert.equal(card.balance.stale, false);
  assert.equal(card.balance.status, 'available');

  // 2. Unconfirmed currency: 'ZZZ' or null does NOT drop amount, returns currency: null and currency_verified = false
  const unconfirmedCurr = sanitizeUsage(baseMimo({ balance: { amount: 12.34, currency: 'ZZZ', observed_at: iso(now) } }), now);
  assert.equal(unconfirmedCurr.cards[0].balance.amount, 12.34);
  assert.equal(unconfirmedCurr.cards[0].balance.currency, null);
  assert.equal(unconfirmedCurr.cards[0].balance.currency_verified, false);

  const nullCurr = sanitizeUsage(baseMimo({ balance: { amount: 12.34, currency: null, observed_at: iso(now) } }), now);
  assert.equal(nullCurr.cards[0].balance.amount, 12.34);
  assert.equal(nullCurr.cards[0].balance.currency, null);
  assert.equal(nullCurr.cards[0].balance.currency_verified, false);

  // 3. Stale via fresh_until / stale_after_seconds elapsed: preserves amount and timestamps as stale
  const expired = sanitizeUsage(baseMimo({ stale_after_seconds: 60 }), now + 61000);
  assert.equal(expired.cards[0].balance.amount, 12.34);
  assert.equal(expired.cards[0].balance.currency, 'USD');
  assert.equal(expired.cards[0].balance.stale, true);
  assert.equal(expired.cards[0].balance.status, 'stale');
  assert.equal(expired.cards[0].balance.observed_at, iso(now));
  assert.equal(expired.cards[0].balance.collected_at, iso(now));

  // 4. Stale via card.status = 'stale' with no current value, but with last_known_balance:
  // preserves last known amount, currency, observed_at, and last_success_collected_at
  const statusStalePastOnly = sanitizeUsage(baseMimo({
    status: 'stale',
    balance: null,
    collected_at: iso(now),
    last_success_collected_at: iso(now - 7200000),
    last_known_balance: { amount: 45.67, currency: 'USD', observed_at: iso(now - 7200000) }
  }), now);
  assert.equal(statusStalePastOnly.cards[0].status, 'stale');
  assert.equal(statusStalePastOnly.cards[0].balance, null);
  assert.equal(statusStalePastOnly.cards[0].last_success_collected_at, iso(now - 7200000));
  assert.equal(statusStalePastOnly.cards[0].last_known_balance.amount, 45.67);
  assert.equal(statusStalePastOnly.cards[0].last_known_balance.currency, 'USD');
  assert.equal(statusStalePastOnly.cards[0].last_known_balance.currency_verified, true);
  assert.equal(statusStalePastOnly.cards[0].last_known_balance.observed_at, iso(now - 7200000));

  // 4c. When last_success_collected_at is null, remains null and is NOT replaced by observed_at
  const noSuccessPast = sanitizeUsage(baseMimo({
    status: 'stale',
    balance: null,
    collected_at: iso(now),
    last_success_collected_at: null,
    last_known_balance: { amount: 30.0, currency: 'USD', observed_at: iso(now - 3600000) }
  }), now);
  assert.equal(noSuccessPast.cards[0].last_success_collected_at, null);
  assert.equal(noSuccessPast.cards[0].last_known_balance.observed_at, iso(now - 3600000));
  assert.equal(noSuccessPast.cards[0].last_known_balance.collected_at, null);

  // 5. Stale via card.status = 'stale' with current balance: preserves amount and timestamps as stale
  const statusStale = sanitizeUsage(baseMimo({ status: 'stale' }), now);
  assert.equal(statusStale.cards[0].balance.amount, 12.34);
  assert.equal(statusStale.cards[0].balance.stale, true);
  assert.equal(statusStale.cards[0].balance.status, 'stale');

  // 6. Account alignment mismatch: clears amount and currency completely (does not inherit previous account)
  const mismatch = sanitizeUsage(baseMimo({ account_alignment: 'mismatch', last_known_balance: { amount: 10.0, currency: 'USD', observed_at: iso(now - 3600000) } }), now);
  assert.equal(mismatch.cards[0].balance.amount, null);
  assert.equal(mismatch.cards[0].balance.currency, null);
  assert.equal(mismatch.cards[0].balance.currency_verified, false);
  assert.equal(mismatch.cards[0].last_known_balance.amount, null);

  // 7. Fetch failed with last_known: retains last_known with last_success time
  const failed = sanitizeUsage(baseMimo({
    status: 'fetch_failed',
    error_kind: 'timeout',
    balance: null,
    last_known_balance: { amount: 25.5, currency: 'USD', observed_at: iso(now - 7200000) }
  }), now);
  assert.equal(failed.cards[0].balance, null);
  assert.equal(failed.cards[0].last_known_balance.amount, 25.5);
  assert.equal(failed.cards[0].last_known_balance.status, 'last_known');

  // 8. Micro negative number: preserves negative sign and precise float
  const microNeg = sanitizeUsage(baseMimo({ balance: { amount: -0.004, currency: 'USD', observed_at: iso(now) } }), now);
  assert.equal(microNeg.cards[0].balance.amount, -0.004);
  assert.ok(microNeg.cards[0].balance.amount < 0);
});

test('TASK-17: End-to-end data pipeline to DOM display: Claude -> AG -> MiMo order, money rendering, stale/last_known micro-negatives, unconfirmed currency', async () => {
  const initial = Date.parse('2025-01-01T12:00:00Z');
  let now = initial;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.style = {}; }
    setAttribute(k, v) { this[k] = v; }
    append(...items) { this.children.push(...items); }
    prepend(item) { this.children.unshift(item); }
    replaceChildren(...items) { this.children = items; }
  }
  class Clock extends Date { static now() { return now; } }
  const text = e => [e.textContent, ...e.children.map(text)].join(' ');

  const renderPipeline = async (rawInput, testNow = now) => {
    const dto = sanitizeUsage(rawInput, testNow);
    const body = new Element('body');
    const intervals = new Map();
    const context = {
      Date: Clock,
      document: { readyState: 'complete', body, createElement: tag => new Element(tag) },
      fetch: async () => ({ ok: true, json: async () => dto }),
      setInterval: (fn, delay) => intervals.set(delay, fn)
    };
    runInNewContext(readFileSync(new URL('../scripts/usage-display.js', import.meta.url), 'utf8'), context);
    await new Promise(setImmediate);
    const summary = body.children[0].children.find(e => e.tag === 'div');
    const details = body.children[0].children.find(e => e.tag === 'details');
    return { body, summary, details, text: text(body) };
  };

  const makeRow = (family, scope, period, remaining, shared_pool = null) => ({
    model_family: family, quota_scope: scope, period, window_id: 'secondary', status: 'available',
    remaining_percent: remaining, used_percent: 100 - remaining,
    reset_at: iso(initial + (period === 'five_hour' ? 14400000 : 86400000)),
    observed_at: iso(initial),
    ...(shared_pool ? { shared_pool } : {})
  });

  const fullInput = (mimoCardOver = {}) => ({
    display_schema_version: 1,
    view_read_at: iso(initial),
    cards: [
      { provider: 'claude', status: 'available', account_alignment: 'verified', collected_at: iso(initial), last_success_collected_at: iso(initial), stale_after_seconds: 3600,
        current_rows: [makeRow('claude', 'own_subscription', 'five_hour', 80), makeRow('claude', 'own_subscription', 'weekly', 90)], last_known_rows: [] },
      { provider: 'antigravity', status: 'available', account_alignment: 'verified', collected_at: iso(initial), last_success_collected_at: iso(initial), stale_after_seconds: 3600,
        current_rows: [makeRow('gemini', 'antigravity_shared', 'five_hour', 70, 'gemini_shared'), makeRow('claude', 'antigravity_shared', 'five_hour', 60, 'claude_gpt_shared')], last_known_rows: [] },
      { provider: 'mimo', status: 'available', account_alignment: 'verified', collected_at: iso(initial), last_success_collected_at: iso(initial), stale_after_seconds: 3600,
        balance: { amount: 12.34, currency: 'USD', observed_at: iso(initial) }, last_known_balance: null, ...mimoCardOver }
    ]
  });

  // 1. Order verification: Claude -> AG Gemini / AG Claude/GPT -> MiMo API
  const e2e1 = await renderPipeline(fullInput());
  const summaryHeaders = e2e1.summary.children.map(sec => sec.children[0].children[0].textContent);
  assert.equal(summaryHeaders[0], 'Claude');
  assert.equal(summaryHeaders[1], 'AG Gemini');
  assert.equal(summaryHeaders[2], 'AG Claude/GPT');
  assert.equal(summaryHeaders[3], 'MiMo API');
  // Check MiMo text does not contain % and displays USD 12.34
  const mimoSectionText = text(e2e1.summary.children[3]);
  assert.match(mimoSectionText, /USD 12\.34/);
  assert.doesNotMatch(mimoSectionText, /%/);

  // 2. Unconfirmed currency: 'ZZZ' or null displays '通貨未確認' through pipeline, and DTO has currency: null and currency_verified: false
  const rawUnconfirmed = fullInput({ balance: { amount: 12.34, currency: 'ZZZ', observed_at: iso(initial) } });
  const dtoUnconfirmed = sanitizeUsage(rawUnconfirmed, initial);
  const mimoDto = dtoUnconfirmed.cards.find(c => c.provider === 'mimo');
  assert.equal(mimoDto.balance.currency, null);
  assert.equal(mimoDto.balance.currency_verified, false);
  assert.equal(mimoDto.balance.amount, 12.34);
  const e2eUnconfirmed = await renderPipeline(rawUnconfirmed);
  assert.match(text(e2eUnconfirmed.summary.children[3]), /通貨未確認/);
  assert.doesNotMatch(e2eUnconfirmed.text, /ZZZ/);

  // 3. Stale via fresh_until elapsed: preserves amount with '参考' and '古い情報'
  const e2eStaleFreshUntil = await renderPipeline(fullInput({ stale_after_seconds: 60 }), initial + 61000);
  const staleText1 = text(e2eStaleFreshUntil.summary.children[3]);
  assert.match(staleText1, /USD 12\.34.*参考/);
  assert.match(staleText1, /古い情報/);

  // 4. Stale via status='stale': preserves amount with '参考' and '古い情報'
  const e2eStaleStatus = await renderPipeline(fullInput({ status: 'stale' }));
  const staleText2 = text(e2eStaleStatus.summary.children[3]);
  assert.match(staleText2, /USD 12\.34.*参考/);
  assert.match(staleText2, /古い情報/);

  // 4b. Stale via status='stale' with NO current balance, but with last_known_balance and success timestamp:
  // Preserves amount, currency, observed_at, last_success_collected_at, and renders '前回参考' and '古い情報'
  const rawStalePastOnly = fullInput({
    status: 'stale',
    balance: null,
    collected_at: iso(initial),
    last_success_collected_at: iso(initial - 7200000),
    last_known_balance: { amount: 25.5, currency: 'USD', observed_at: iso(initial - 7200000) }
  });
  const dtoStalePast = sanitizeUsage(rawStalePastOnly, initial);
  const mimoStalePastDto = dtoStalePast.cards.find(c => c.provider === 'mimo');
  assert.equal(mimoStalePastDto.status, 'stale');
  assert.equal(mimoStalePastDto.balance, null);
  assert.equal(mimoStalePastDto.last_success_collected_at, iso(initial - 7200000));
  assert.equal(mimoStalePastDto.last_known_balance.amount, 25.5);
  assert.equal(mimoStalePastDto.last_known_balance.currency, 'USD');
  assert.equal(mimoStalePastDto.last_known_balance.collected_at, iso(initial - 7200000));

  const e2eStalePastOnly = await renderPipeline(rawStalePastOnly);
  const stalePastText = text(e2eStalePastOnly.summary.children[3]);
  assert.match(stalePastText, /USD 25\.50/);
  assert.match(stalePastText, /前回参考/);
  assert.match(stalePastText, /古い情報/);
  assert.match(e2eStalePastOnly.text, /前回残高：USD 25\.50/);
  assert.match(e2eStalePastOnly.text, /前回参考（現在値ではありません）/);

  // 4c. When last_success_collected_at is null, displays '成功時刻不明' and separate '観測' label:
  const rawNoSuccessTime = fullInput({
    status: 'stale',
    balance: null,
    collected_at: iso(initial),
    last_success_collected_at: null,
    last_known_balance: { amount: 25.5, currency: 'USD', observed_at: iso(initial - 7200000) }
  });
  const e2eNoSuccessTime = await renderPipeline(rawNoSuccessTime);
  const noSuccessText = text(e2eNoSuccessTime.summary.children[3]);
  assert.match(noSuccessText, /成功時刻不明/);
  assert.match(noSuccessText, /観測/);
  assert.match(noSuccessText, /USD 25\.50/);
  assert.match(noSuccessText, /前回参考/);

  // 5. Micro-negative in stale state: retains negative sign and displays '残高不足'
  const e2eMicroNegStale = await renderPipeline(fullInput({
    status: 'stale',
    balance: { amount: -0.004, currency: 'USD', observed_at: iso(initial) }
  }));
  const microNegStaleText = text(e2eMicroNegStale.summary.children[3]);
  assert.match(microNegStaleText, /USD > -0\.01/);
  assert.match(microNegStaleText, /残高不足/);
  assert.match(microNegStaleText, /参考/);

  // 6. Micro-negative in last_known state: retains negative sign and displays '残高不足' and '前回参考'
  const e2eMicroNegLastKnown = await renderPipeline(fullInput({
    status: 'fetch_failed',
    balance: null,
    last_known_balance: { amount: -0.004, currency: 'USD', observed_at: iso(initial - 3600000) }
  }));
  const microNegLastKnownText = text(e2eMicroNegLastKnown.summary.children[3]);
  assert.match(microNegLastKnownText, /USD > -0\.01/);
  assert.match(microNegLastKnownText, /残高不足/);
  assert.match(microNegLastKnownText, /前回参考/);

  // 7. Exact zero: displays USD 0.00 normally
  const e2eZero = await renderPipeline(fullInput({ balance: { amount: 0, currency: 'USD', observed_at: iso(initial) } }));
  assert.match(text(e2eZero.summary.children[3]), /USD 0\.00/);
  assert.doesNotMatch(text(e2eZero.summary.children[3]), /残高不足|未取得/);

  // 8. Account alignment mismatch: clears amount, displays '—' / 'アカウント不一致（旧残高破棄）'
  const e2eMismatch = await renderPipeline(fullInput({
    account_alignment: 'mismatch',
    last_known_balance: { amount: 15.0, currency: 'USD', observed_at: iso(initial - 3600000) }
  }));
  assert.doesNotMatch(text(e2eMismatch.summary.children[3]), /USD/);
  assert.match(text(e2eMismatch.summary.children[3]), /アカウント不一致/);

  // 9. Claude and AG remain completely intact when MiMo is failed or unconfirmed
  const e2eMimoFailed = await renderPipeline(fullInput({ status: 'fetch_failed', balance: null, last_known_balance: null }));
  const claudeText = text(e2eMimoFailed.summary.children[0]);
  const agText = text(e2eMimoFailed.summary.children[1]);
  assert.match(claudeText, /5h 80%/);
  assert.match(agText, /5h 70%/);
  assert.match(text(e2eMimoFailed.summary.children[3]), /取得失敗/);

  // 10. Existing data without MiMo card still displays 'MiMo API' to the right of AG with '取得方法未確認'
  const e2eMissingMimo = await renderPipeline({
    display_schema_version: 1,
    view_read_at: iso(initial),
    cards: [
      { provider: 'claude', status: 'available', account_alignment: 'verified', collected_at: iso(initial), last_success_collected_at: iso(initial), stale_after_seconds: 3600,
        current_rows: [makeRow('claude', 'own_subscription', 'five_hour', 80), makeRow('claude', 'own_subscription', 'weekly', 90)], last_known_rows: [] },
      { provider: 'antigravity', status: 'available', account_alignment: 'verified', collected_at: iso(initial), last_success_collected_at: iso(initial), stale_after_seconds: 3600,
        current_rows: [makeRow('gemini', 'antigravity_shared', 'five_hour', 70, 'gemini_shared'), makeRow('claude', 'antigravity_shared', 'five_hour', 60, 'claude_gpt_shared')], last_known_rows: [] }
    ]
  });
  const missingMimoHeaders = e2eMissingMimo.summary.children.map(sec => sec.children[0].children[0].textContent);
  assert.deepEqual(missingMimoHeaders, ['Claude', 'AG Gemini', 'AG Claude/GPT', 'MiMo API']);
  const missingMimoText = text(e2eMissingMimo.summary.children[3]);
  assert.match(missingMimoText, /MiMo API/);
  assert.match(missingMimoText, /取得方法未確認/);
  assert.match(missingMimoText, /—/);
  assert.match(e2eMissingMimo.text, /残高照会API：未確認（推測接続なし）/);
});

test('TASK-17 defense: malformed payload (missing cards) handled safely before render; preserves prior display as 更新失敗・前回値, shows read failure on initial', async () => {
  const initial = Date.parse('2025-01-01T00:00:00Z');
  let now = initial;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.style = {}; }
    setAttribute(k, v) { this[k] = v; }
    append(...items) { this.children.push(...items); }
    prepend(item) { this.children.unshift(item); }
    replaceChildren(...items) { this.children = items; }
  }
  class Clock extends Date { static now() { return now; } }
  const text = e => [e.textContent, ...e.children.map(text)].join(' ');
  const code = (await import('node:fs')).readFileSync(new URL('../scripts/usage-display.js', import.meta.url), 'utf8');
  const { runInNewContext } = await import('node:vm');

  // 1. Initial load with missing cards: displays "残量データの読取失敗。" without throwing TypeError
  {
    const body = new Element('body');
    const intervals = new Map();
    let fetchCalled = false;
    const context = {
      Date: Clock,
      document: { readyState: 'complete', body, createElement: tag => new Element(tag) },
      fetch: async () => { fetchCalled = true; return { ok: true, json: async () => ({ display_schema_version: 1 }) }; },
      setInterval: (fn, delay) => intervals.set(delay, fn)
    };
    runInNewContext(code, context);
    await new Promise(setImmediate);
    assert.equal(fetchCalled, true);
    const panel = body.children[0];
    assert.match(text(panel), /残量データの読取失敗/);
    assert.equal(panel.children.some(c => c.tag === 'div'), false);
  }

  // 2. Successful initial load followed by malformed payload on refresh:
  // Preserves existing cards and marks '更新失敗・前回値'
  {
    const body = new Element('body');
    const intervals = new Map();
    const validDto = {
      display_schema_version: 1,
      view_read_at: iso(initial),
      cards: [
        { provider: 'claude', status: 'available', account_alignment: 'verified', collected_at: iso(initial), last_success_collected_at: iso(initial), current_rows: [{ model_family: 'claude', quota_scope: 'own_subscription', period: 'five_hour', remaining_percent: 80, fresh_until: iso(initial + 3600000), reset_at: iso(initial + 7200000), status: 'available' }], last_known_rows: [] },
        { provider: 'antigravity', status: 'available', account_alignment: 'verified', collected_at: iso(initial), last_success_collected_at: iso(initial), current_rows: [{ model_family: 'gemini', quota_scope: 'antigravity_shared', shared_pool: 'gemini_shared', period: 'five_hour', remaining_percent: 70, fresh_until: iso(initial + 3600000), reset_at: iso(initial + 7200000), status: 'available' }], last_known_rows: [] }
      ]
    };
    let payload = validDto;
    const context = {
      Date: Clock,
      document: { readyState: 'complete', body, createElement: tag => new Element(tag) },
      fetch: async () => ({ ok: true, json: async () => payload }),
      setInterval: (fn, delay) => intervals.set(delay, fn)
    };
    runInNewContext(code, context);
    await new Promise(setImmediate);

    const panel = body.children[0];
    const summaryBefore = panel.children.find(e => e.tag === 'div');
    assert.ok(summaryBefore);
    const cardHeadersBefore = summaryBefore.children.map(sec => sec.children[0].children[0].textContent);
    assert.deepEqual(cardHeadersBefore, ['Claude', 'AG Gemini', 'AG Claude/GPT', 'MiMo API']);
    assert.doesNotMatch(text(panel), /更新失敗/);

    // Refresh with malformed payload (missing cards)
    payload = { display_schema_version: 1, corrupt: true };
    await intervals.get(30000)();

    // Prior display is preserved! Cards are NOT deleted!
    const summaryAfter = panel.children.find(e => e.tag === 'div');
    assert.ok(summaryAfter);
    const cardHeadersAfter = summaryAfter.children.map(sec => sec.children[0].children[0].textContent);
    assert.deepEqual(cardHeadersAfter, ['Claude', 'AG Gemini', 'AG Claude/GPT', 'MiMo API']);

    // Clearly marked as '更新失敗・前回値'
    assert.match(text(panel), /更新失敗・前回値を表示中/);
    assert.match(text(panel), /表示通信に失敗。最後の表示は過去の参考値です。/);
  }
});
