import test from 'node:test';
import assert from 'node:assert/strict';
import { runInContext, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { app, FixtureStore } from './fixtures.mjs';
import { emptyBoard, mutate } from '../model.mjs';

// DOM data harness; this verifies rendering logic, not browser layout/screenshots.
class Element {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  showModal() {}
}
const text = element => [element.textContent, ...element.children.map(text)].join(' ');
test('HTTP snapshot renders lifecycle, private groups, literal details and reconnection', async () => {
  let board = emptyBoard();
  const store = { async read() { return structuredClone(board); }, async transaction(change) { const next = structuredClone(board); const result = change(next); board = next; return result; } };
  const a = await app(store); const base = a.url;
  try {
    const elements = new Map(); const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    let disconnected = false;
    const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} },
      crypto: { randomUUID }, AbortSignal, setInterval() {}, fetch: (path, options) => {
        if (disconnected) return Promise.reject(new Error('offline'));
        return fetch(base + path, { ...options, headers: { ...options?.headers, Origin: 'http://synthetic.invalid' } });
      } });
    runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
    const input = { id: 'UI-SYNTH', title: '<script>unsafe()</script>', owner: 'synthetic-agent', group: '現行', status: 'To Do', detail: '合成詳細', lastConfirmedAt: null };
    for (const [i, [status, label]] of [['To Do', 'To Do'], ['In Progress', 'In Progress'], ['Blocked', 'Blocked'], ['Done', 'Done']].entries()) {
      await mutate(store, { requestId: `ui-state-${i}`, expectedVersion: i, task: { ...input, status } });
      await runInContext('refresh()', context);
      const column = el('board').children.find(c => c.children[0].textContent.startsWith(label + ' ·'));
      assert.equal(column.children.length, 2); assert.match(text(column), /synthetic-agent/); assert.match(text(column), /<script>unsafe\(\)<\/script>/);
      assert.match(text(el('groups')), /現行 · 1/); assert.match(el('times').textContent, /タスク一覧の同期/);
    }
    const saved = text(el('board')); disconnected = true;
    await runInContext('refresh()', context); assert.equal(text(el('board')), saved); assert.match(el('connection').textContent, /接続できません/);
    disconnected = false;
    await mutate(store, { requestId: 'ui-reconnected', expectedVersion: 4, task: { ...input, title: '再接続後の最新', status: 'Blocked' } });
    await runInContext('refresh()', context); assert.match(text(el('board')), /再接続後の最新/); assert.equal(el('connection').textContent, '接続中');
  } finally { await a.close(); }
});
test('UI retry retains ID/body through HTTP write failure, lost ACK, reopen and another task', async () => {
  const store = new FixtureStore(); const a = await app(store);
  try {
    const input = { id: 'UI-RETRY', title: '合成再送', owner: 'synthetic-agent', group: '現行', status: 'To Do', detail: '', lastConfirmedAt: null };
    await mutate(store, { requestId: 'retry-seed-a', expectedVersion: 0, task: input });
    await mutate(store, { requestId: 'retry-seed-b', expectedVersion: 0, task: { ...input, id: 'UI-OTHER', title: '別の合成タスク' } });
    const elements = new Map(), requests = []; let loseAck = true;
    const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {},
      fetch: async (path, options) => {
        if (options?.method === 'POST') requests.push(JSON.parse(options.body));
        const response = await fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: 'http://synthetic.invalid' } });
        if (options?.method === 'POST' && response.ok && loseAck) { loseAck = false; await response.text(); throw new Error('ACK lost after commit'); }
        return response;
      } });
    runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
    await runInContext('refresh()', context);
    const card = id => el('board').children.flatMap(c => c.children).find(c => c.children?.[0]?.textContent === id);
    store.failWrite = true;
    card('UI-RETRY').onclick(); el('status').value = 'In Progress'; await el('save').onclick();
    assert.equal((await store.read()).tasks.find(t => t.id === 'UI-RETRY').version, 1);
    store.failWrite = false; card('UI-RETRY').onclick(); await el('save').onclick();
    assert.equal((await store.read()).tasks.find(t => t.id === 'UI-RETRY').version, 2);
    assert.match(text(card('UI-RETRY')), /未確認/);
    card('UI-OTHER').onclick(); el('status').value = 'Done'; await el('save').onclick();
    const revision = (await store.read()).revision;
    card('UI-RETRY').onclick(); assert.equal(el('status').disabled, true); assert.equal(el('status').value, 'In Progress');
    el('status').value = 'Done'; el('status').onchange(); assert.equal(el('status').value, 'In Progress');
    await el('refresh').onclick(); card('UI-RETRY').onclick(); await el('save').onclick();
    assert.deepEqual(requests[1], requests[0]); assert.deepEqual(requests[3], requests[0]); assert.notEqual(requests[2].requestId, requests[0].requestId);
    assert.equal((await store.read()).revision, revision);
    assert.equal(runInContext('pendingRequests.size', context), 0);
    assert.doesNotMatch(text(card('UI-RETRY')), /未確認/);
  } finally { await a.close(); }
});

test('refresh ordering, malformed snapshots and revision rollback keep last valid data offline', async () => {
  const elements = new Map(), reads = [];
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} },
    crypto: { randomUUID }, AbortSignal, setInterval() {}, fetch: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) });
  const snapshot = (revision, title) => ({ revision, observedAt: new Date().toISOString(), tasks: [{ id: 'ORDER-SYNTH', title, owner: 'synthetic-agent', group: '現行', status: 'To Do', detail: '', lastConfirmedAt: null, version: revision, updatedAt: '2026-10-13T00:00:00.000Z' }] });
  const ok = value => ({ ok: true, json: async () => value });
  runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  reads[0].resolve(ok(snapshot(1, 'initial'))); await new Promise(setImmediate);
  const older = runInContext('refresh()', context), newer = runInContext('refresh()', context);
  reads[2].resolve(ok(snapshot(3, 'newest'))); await newer;
  reads[1].resolve(ok(snapshot(2, 'late older'))); await older;
  assert.equal(runInContext('snapshot.revision', context), 3); assert.match(text(el('board')), /newest/); assert.doesNotMatch(text(el('board')), /late older/);
  const lateSuccess = runInContext('refresh()', context), failed = runInContext('refresh()', context);
  reads[4].reject(new Error('offline')); await failed;
  reads[3].resolve(ok(snapshot(4, 'late success'))); await lateSuccess;
  assert.equal(runInContext('online', context), false); assert.match(text(el('board')), /newest/); assert.equal(el('save').disabled, true);
  const malformed = runInContext('refresh()', context);
  reads[5].resolve(ok({ ...snapshot(5, 'invalid'), tasks: [{ ...snapshot(5, 'invalid').tasks[0], owner: ['two', 'owners'] }] })); await malformed;
  assert.equal(runInContext('snapshot.revision', context), 3); assert.equal(runInContext('online', context), false);
  const rollback = runInContext('refresh()', context); reads[6].resolve(ok(snapshot(1, 'rollback'))); await rollback;
  assert.equal(runInContext('snapshot.revision', context), 3); assert.equal(runInContext('online', context), false);
  const duplicate = runInContext('refresh()', context); const value = snapshot(6, 'duplicate'); value.tasks.push(value.tasks[0]); reads[7].resolve(ok(value)); await duplicate;
  assert.equal(runInContext('snapshot.revision', context), 3); assert.equal(runInContext('online', context), false);
  const reconnect = runInContext('refresh()', context); reads[8].resolve(ok(snapshot(6, 'reconnected'))); await reconnect;
  assert.equal(runInContext('online', context), true); assert.equal(runInContext('snapshot.revision', context), 6); assert.match(text(el('board')), /reconnected/);
});

test('malformed success ACK remains pending and retries exactly once with unchanged request', async () => {
  const store = new FixtureStore(), a = await app(store), elements = new Map(), requests = [];
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  try {
    await mutate(store, { requestId: 'invalid-ack-seed', expectedVersion: 0, task: { id: 'ACK-SYNTH', title: '合成ACK', owner: 'synthetic-agent', group: '現行', status: 'To Do', detail: '', lastConfirmedAt: null } });
    let corruptAck = true;
    const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} }, crypto: { randomUUID }, AbortSignal, setInterval() {},
      fetch: async (path, options) => {
        if (options?.method === 'POST') requests.push(JSON.parse(options.body));
        const response = await fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: 'http://synthetic.invalid' } });
        if (options?.method === 'POST' && response.ok && corruptAck) { corruptAck = false; const saved = await response.json(); return { ok: true, status: 200, json: async () => ({ ...saved, owner: ['invalid', 'owners'] }) }; }
        return response;
      } });
    runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context); await runInContext('refresh()', context);
    const card = () => el('board').children.flatMap(c => c.children).find(c => c.children?.[0]?.textContent === 'ACK-SYNTH');
    card().onclick(); el('status').value = 'In Progress'; await el('save').onclick();
    assert.equal(runInContext('pendingRequests.size', context), 1); assert.equal(el('status').disabled, true);
    const revision = (await store.read()).revision;
    card().onclick(); await el('save').onclick();
    assert.deepEqual(requests[1], requests[0]); assert.equal(runInContext('pendingRequests.size', context), 0); assert.equal((await store.read()).revision, revision);
  } finally { await a.close(); }
});


test('well-shaped wrong ACK does not clear pending; stale detail cannot submit a new write',async()=>{
  const store=new FixtureStore(),a=await app(store),elements=new Map(),requests=[];let wrongAck=true;
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  try{
    const input={id:'CONTENT-ACK',title:'合成要求一致',owner:'synthetic-agent',group:'現行',status:'To Do',detail:'original',lastConfirmedAt:null};await mutate(store,{requestId:'content-seed',expectedVersion:0,task:input});
    const context=createContext({document:{hidden:false,getElementById:el,createElement:()=>new Element(),addEventListener(){}},crypto:{randomUUID},AbortSignal,setInterval(){},fetch:async(path,options)=>{
      if(options?.method==='POST')requests.push(JSON.parse(options.body));
      const response=await fetch(a.url+path,{...options,headers:{...options?.headers,Origin:'http://synthetic.invalid'}});
      if(options?.method==='POST'&&response.ok&&wrongAck){wrongAck=false;const saved=await response.json();return{ok:true,status:200,json:async()=>({...saved,status:'Done'})};}return response;
    }});
    runInContext(await readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);await runInContext('refresh()',context);
    const card=()=>el('board').children.flatMap(c=>c.children).find(c=>c.children?.[0]?.textContent==='CONTENT-ACK');
    card().onclick();el('status').value='In Progress';await el('save').onclick();assert.equal(runInContext('pendingRequests.size',context),1);
    card().onclick();await el('save').onclick();assert.equal(runInContext('pendingRequests.size',context),0);assert.deepEqual(requests[1],requests[0]);
    card().onclick();await mutate(store,{requestId:'other-update',expectedVersion:2,task:{...input,status:'Blocked',detail:'other agent'}});await runInContext('refresh()',context);
    assert.equal(el('save').disabled,true);assert.match(el('saveNotice').textContent,/開き直して/);const count=requests.length;await el('save').onclick();assert.equal(requests.length,count);
  }finally{await a.close();}
});

test('closing during save and double operations cannot revive selection or cancel a committed write',async()=>{
  const store=new FixtureStore(),a=await app(store),elements=new Map();let release,postCount=0;
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  try{
    const input={id:'CLOSE-A',title:'合成取消境界',owner:'synthetic-agent',group:'現行',status:'To Do',detail:'',lastConfirmedAt:null};
    await mutate(store,{requestId:'close-seed-a',expectedVersion:0,task:input});await mutate(store,{requestId:'close-seed-b',expectedVersion:0,task:{...input,id:'CLOSE-B'}});
    const context=createContext({document:{hidden:false,getElementById:el,createElement:()=>new Element(),addEventListener(){}},crypto:{randomUUID},AbortSignal,setInterval(){},fetch:async(path,options)=>{
      const response=await fetch(a.url+path,{...options,headers:{...options?.headers,Origin:'http://synthetic.invalid'}});
      if(options?.method==='POST'){postCount++;await new Promise(resolve=>{release=resolve;});}return response;
    }});
    runInContext(await readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);await runInContext('refresh()',context);
    const card=id=>el('board').children.flatMap(c=>c.children).find(c=>c.children?.[0]?.textContent===id);
    card('CLOSE-A').onclick();el('status').value='In Progress';const saving=el('save').onclick();
    while(!release)await new Promise(setImmediate);
    await el('save').onclick();card('CLOSE-B').onclick();assert.equal(runInContext('selected.id',context),'CLOSE-A');
    el('detail').onclose();assert.equal(runInContext('selected',context),undefined);release();await saving;
    assert.equal(postCount,1);assert.equal(runInContext('selected',context),undefined);assert.equal(el('save').disabled,true);assert.equal(runInContext('pendingRequests.size',context),0);
    assert.equal((await store.read()).tasks.find(task=>task.id==='CLOSE-A').status,'In Progress');
    card('CLOSE-B').onclick();el('detail').onclose();await el('save').onclick();assert.equal(postCount,1);
  }finally{await a.close();}
});

test('snapshot coherence and timestamp age reject fabricated freshness and version regression',async()=>{
  const elements=new Map(),reads=[];const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const context=createContext({document:{hidden:false,getElementById:el,createElement:()=>new Element(),addEventListener(){}},crypto:{randomUUID},AbortSignal,setInterval(){},fetch:()=>new Promise(resolve=>reads.push(resolve))});
  const task={id:'COHERENT',title:'合成版',owner:'synthetic-agent',group:'現行',status:'To Do',detail:'',lastConfirmedAt:null,version:2,updatedAt:new Date().toISOString()};
  const board={revision:5,observedAt:new Date().toISOString(),tasks:[task]};const ok=value=>({ok:true,json:async()=>value});
  runInContext(await readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);reads[0](ok(board));await new Promise(setImmediate);
  const cases=[{...board,revision:6,tasks:[{...task,version:1}]},{...board,tasks:[{...task,title:'same revision changed'}]},{...board,tasks:[{...task,version:3}]},{...board,revision:6,tasks:[{...task,version:4}]},{...board,revision:6,tasks:[{...task,version:7}]},{...board,observedAt:new Date(Date.now()-120000).toISOString()},{...board,observedAt:new Date(Date.now()+120000).toISOString()},{...board,tasks:[{...task,updatedAt:'2026-02-30T00:00:00Z'}]}];
  for(const candidate of cases){const request=runInContext('refresh()',context);reads.at(-1)(ok(candidate));await request;assert.equal(runInContext('online',context),false);assert.equal(runInContext('snapshot.tasks[0].title',context),'合成版');assert.equal(runInContext('snapshot.tasks[0].version',context),2);}
});

test('successful write ACK sets a floor that a post-write stale GET cannot roll back',async()=>{
  const store=new FixtureStore(),a=await app(store),elements=new Map();let oldRead,serveOld=false;
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  try{
    const input={id:'ACK-FLOOR',title:'合成確認版',owner:'synthetic-agent',group:'現行',status:'To Do',detail:'',lastConfirmedAt:null};await mutate(store,{requestId:'ack-floor-seed',expectedVersion:0,task:input});
    const context=createContext({document:{hidden:false,getElementById:el,createElement:()=>new Element(),addEventListener(){}},crypto:{randomUUID},AbortSignal,setInterval(){},fetch:async(path,options)=>{
      if(options?.method!=='POST'&&serveOld)return{ok:true,json:async()=>({...oldRead,observedAt:new Date().toISOString()})};
      const response=await fetch(a.url+path,{...options,headers:{...options?.headers,Origin:'http://synthetic.invalid'}});if(options?.method==='POST')serveOld=true;return response;
    }});
    runInContext(await readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);await runInContext('refresh()',context);oldRead=JSON.parse(runInContext('JSON.stringify(snapshot)',context));
    el('board').children.flatMap(c=>c.children).find(c=>c.children?.[0]?.textContent==='ACK-FLOOR').onclick();el('status').value='In Progress';await el('save').onclick();
    assert.equal(runInContext('online',context),false);assert.equal(runInContext('acknowledgedVersions.get("ACK-FLOOR")',context),2);assert.equal(el('save').disabled,true);assert.match(el('notice').textContent,/最後に取得/);
    serveOld=false;await runInContext('refresh()',context);assert.equal(runInContext('online',context),true);assert.equal(runInContext('snapshot.tasks[0].version',context),2);
  }finally{await a.close();}
});

test('legacy-status cards render inside the four columns with a legacy badge; no extra column; storage untouched', async () => {
  const board = { ...emptyBoard(), revision: 3, tasks: ['Verifying', 'Awaiting Approval', 'Done'].map((status, i) => ({ id: `LEG-${i}`, title: `Legacy ${status}`, status, owner: 'synthetic-agent', group: '現行', detail: '合成詳細', lastConfirmedAt: null, version: i + 1, updatedAt: '2026-10-20T00:00:00.000Z' })) };
  const store = { async read() { return structuredClone(board); }, async transaction() { throw new Error('read-only test'); } };
  const a = await app(store);
  try {
    const elements = new Map(); const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const context = createContext({ document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener() {} },
      crypto: { randomUUID }, AbortSignal, setInterval() {}, fetch: (path, options) => fetch(a.url + path, { ...options, headers: { ...options?.headers, Origin: 'http://synthetic.invalid' } }) });
    runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
    await runInContext('refresh()', context);
    const columns = el('board').children;
    assert.equal(columns.length, 4);
    assert.deepEqual(columns.map(c => c.children[0].textContent.split(' ·')[0]), ['To Do', 'In Progress', 'Blocked', 'Done']);
    assert.match(text(columns[1]), /Legacy Verifying/); assert.match(text(columns[1]), /旧「最終確認」から表示/);
    assert.match(text(columns[2]), /Legacy Awaiting Approval/); assert.match(text(columns[2]), /旧「承認待ち」から表示/);
    assert.doesNotMatch(text(columns[3]), /Legacy Verifying|Legacy Awaiting/); assert.doesNotMatch(text(columns[3]), /旧「/);
    assert.equal(board.tasks[0].status, 'Verifying');
  } finally { await a.close(); }
});
