import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {convertBacklogFiles} from '../import-snapshot.mjs';
import {createVercelHandler} from '../server.mjs';
import {SyntheticStore} from '../synthetic.mjs';
const raw=id=>`---\nid: ${id}\ntitle: 'Synthetic: 日本語 task'\nstatus: Blocked\nassignee:\n  - '@primary'\nlabels:\n  - '表示:現行'\ncreated_date: '2026-10-11 09:54'\n---\n## Description\n${'Synthetic history\n'.repeat(3200)}\nobserved_at: 2026-10-10T00:00:00Z\n`;
const file=(id)=>({filename:id+'.md',base64:Buffer.from(raw(id)).toString('base64')});
const usage={display_schema_version:1,view_read_at:'2026-10-11T00:00:00Z',cards:[{provider:'codex',status:'available',account_alignment:'verified',collected_at:'2026-10-11T00:00:00Z',last_success_collected_at:'2026-10-11T00:00:00Z',current_rows:[{quota_scope:'own_subscription',model_family:'codex',period:'five_hour',observed_at:'2026-10-11T00:00:00Z',reset_at:'2026-10-11T05:00:00Z',used_percent:20,remaining_percent:80,status:'available'}],last_known_rows:[]}]};
test('lossless source history, primary owner, original dates, groups and duplicate rejection',()=>{
 const out=convertBacklogFiles([file('TASK-1')]);assert.equal(out.board.tasks[0].detail,raw('TASK-1'));assert.equal(out.board.tasks[0].owner,'@primary');assert.equal(out.board.tasks[0].updatedAt,'2026-10-11T00:54:00.000Z');assert.equal(Buffer.from(out.archives[0].base64,'base64').toString(),raw('TASK-1'));assert.throws(()=>convertBacklogFiles([file('TASK-1'),file('TASK-1')]));
});
test('imported long history survives owner-only GET and status change; persisted quota is historical with original collection time',async t=>{
 const store=new SyntheticStore();store.state=convertBacklogFiles([file('TASK-1')]).board;store.state.quota={records:[],usageSnapshot:usage};store.readQuota=async()=>store.state.quota;
 let allowed=false;const server=createServer(createVercelHandler({env:{DASHBOARD_ORIGIN:'https://synthetic.invalid',DATABASE_URL:'synthetic-binding'},connect:async()=>store,authorize:async()=>allowed?{verified:true,role:'owner',subject:'synthetic'}:null}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/api/tasks')).status,401);allowed=true;
 const snapshot=await(await fetch(base+'/api/tasks')).json();assert.equal(snapshot.tasks[0].detail,raw('TASK-1'));
 const {version,updatedAt,...task}=snapshot.tasks[0];task.status='Done';
 const res=await fetch(base+'/api/tasks',{method:'POST',headers:{Origin:'https://synthetic.invalid','x-dashboard-write':'1','content-type':'application/json'},body:JSON.stringify({requestId:'synthetic-import-change',expectedVersion:version,task})});assert.equal(res.status,200);assert.equal((await res.json()).detail,raw('TASK-1'));
 const quota=await(await fetch(base+'/api/quota')).json();assert.equal(quota.usage.cards[0].collected_at,usage.cards[0].collected_at.replace('Z','.000Z'));assert.equal(quota.usage.cards[0].current_rows[0].stale,true);assert.equal(quota.usage.cards[0].current_rows[0].status,'unavailable');assert.equal(quota.usage.cards[0].current_rows[0].used_percent,null);
});
