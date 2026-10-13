const states = ['To Do', 'In Progress', 'Awaiting Approval', 'Blocked', 'Verifying', 'Done'];
const names = ['未着手', '進行中', '承認待ち', '中断・保留', '検証中', '完了'];
const groups = ['現行', '要棚卸し', '完了履歴'];
let snapshot = { tasks: [] }, group = '現行', online = false, selected, busy = false;
const pendingRequests = new Map();
const acknowledgedVersions = new Map();
let readGeneration = 0;
let detailGeneration = 0, selectedStale = false;
const taskFields = ['id', 'title', 'owner', 'status', 'group', 'detail', 'lastConfirmedAt'];
const sameTask = (a, b, metadata = true) => [...taskFields, ...(metadata ? ['version', 'updatedAt'] : [])].every(key => a[key] === b[key]);
const validTime = value => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const ms = Date.parse(value), parsed = new Date(ms);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(ms) && parsed.getUTCFullYear() >= 1 && parsed.getUTCFullYear() <= 9999;
};
const validTask = task => task && typeof task === 'object' && !Array.isArray(task) &&
  typeof task.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(task.id) &&
  typeof task.title === 'string' && task.title.trim() && task.title.length <= 300 &&
  typeof task.owner === 'string' && task.owner.trim() && task.owner.length <= 100 &&
  typeof task.detail === 'string' && task.detail.length <= 10000 &&
  states.includes(task.status) && groups.includes(task.group) &&
  Number.isSafeInteger(task.version) && task.version > 0 && validTime(task.updatedAt) &&
  (task.lastConfirmedAt === null || validTime(task.lastConfirmedAt));
function validSnapshot(value) {
  return value && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    validTime(value.observedAt) && Array.isArray(value.tasks) && value.tasks.length <= 1000 &&
    Math.abs(Date.now() - Date.parse(value.observedAt)) <= 60000 &&
    value.tasks.every(task => validTask(task) && task.version <= value.revision) && new Set(value.tasks.map(task => task.id)).size === value.tasks.length;
}
function advancesSnapshot(next) {
  const incoming = new Map(next.tasks.map(task => [task.id, task]));
  if ([...acknowledgedVersions].some(([id, version]) => !incoming.has(id) || incoming.get(id).version < version)) return false;
  if (snapshot.revision === undefined) return true;
  if (next.revision < snapshot.revision || Date.parse(next.observedAt) < Date.parse(snapshot.observedAt)) return false;
  const previous = new Map(snapshot.tasks.map(task => [task.id, task]));
  if (next.revision === snapshot.revision && next.tasks.length !== previous.size) return false;
  return next.tasks.every(task => {
    const old = previous.get(task.id);
    if (next.revision === snapshot.revision) return old && sameTask(task, old);
    const delta = next.revision - snapshot.revision;
    if (!old) return task.version <= delta;
    return task.version >= old.version && task.version - old.version <= delta && (task.version !== old.version || sameTask(task, old));
  });
}
const el = id => document.getElementById(id);
// A count is only real after a validated successful /api/tasks snapshot; until then it is unfetched ("—"), never 0.
const fetched = () => snapshot.revision !== undefined;
const count = n => fetched() ? n : '—';
const time = value => value ? new Date(value).toLocaleString('ja-JP') : '未記録';
const node = (tag, text, className) => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
function render() {
  el('groups').replaceChildren(...groups.map(g => {
    const b = node('button', `${g} · ${count(snapshot.tasks.filter(t => t.group === g).length)}`, group === g ? 'active' : '');
    b.onclick = () => { group = g; render(); }; return b;
  }));
  const query = el('search').value.toLocaleLowerCase();
  el('board').replaceChildren(...states.map((s, i) => {
    const column = node('section', '', 'column');
    const tasks = snapshot.tasks.filter(t => t.group === group && t.status === s && `${t.title} ${t.owner} ${t.detail}`.toLocaleLowerCase().includes(query));
    column.append(node('h2', `${names[i]} · ${count(tasks.length)}`));
    for (const task of tasks) {
      const card = node('button', '', 'card'); card.append(node('span', task.id, 'id'), node('strong', task.title),
        node('small', `主担当: ${task.owner}`), node('small', `更新: ${time(task.updatedAt)}`), node('small', `確認: ${time(task.lastConfirmedAt)}`));
      if (pendingRequests.has(task.id)) card.append(node('small', '保存結果が未確認'));
      card.onclick = () => {
        if (busy) return;
        ++detailGeneration; selected = task; selectedStale = false; const pending = pendingRequests.get(task.id);
        el('detailTitle').textContent = task.title;
        el('detailBody').textContent = `${task.id} / 主担当: ${task.owner}\n更新: ${time(task.updatedAt)} / 確認: ${time(task.lastConfirmedAt)}\n\n${task.detail}`;
        el('status').value = pending?.task.status ?? task.status; el('status').disabled = Boolean(pending);
        el('saveNotice').textContent = pending ? '保存結果が未確認です。同じ要求ID・内容で再送します。' : '';
        el('save').disabled = !online; el('detail').showModal();
      }; column.append(card);
    } return column;
  }));
}
async function refresh() {
  if (busy || document.hidden) return;
  const generation = ++readGeneration;
  try {
    const response = await fetch('/api/tasks', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (generation !== readGeneration || busy) return;
    if (!validSnapshot(next) || !advancesSnapshot(next)) throw new Error('Invalid or older snapshot');
    snapshot = next; online = true;
    el('connection').textContent = '接続中'; el('times').textContent = `最終取得: ${time(snapshot.observedAt)} · 30秒ごとに確認`;
    el('notice').textContent = ''; render();
    if (selected && !pendingRequests.has(selected.id)) {
      const current = snapshot.tasks.find(task => task.id === selected.id);
      selectedStale = !current || !sameTask(current, selected);
      if (selectedStale) el('saveNotice').textContent = '詳細を開いた後に更新されました。閉じて最新のカードを開き直してください。';
    }
  } catch {
    if (generation !== readGeneration || busy) return;
    online = false; el('connection').textContent = '接続できません';
    // Only claim "last received" when an accepted snapshot actually exists; otherwise nothing was ever received.
    if (fetched()) { el('times').textContent = `最終取得: ${time(snapshot.observedAt)} · 古い可能性があります(再取得できていません)`; el('notice').textContent = '表示は最後に取得した状態で、古い可能性があります。更新ボタンで再接続できます。'; }
    else { el('times').textContent = '未取得'; el('notice').textContent = 'まだタスクを取得できていません(0件ではありません)。更新ボタンで再接続できます。'; }
  }
  el('save').disabled = busy || !online || !selected || selectedStale;
}
el('detail').onclose = () => { ++detailGeneration; selected = undefined; selectedStale = false; el('save').disabled = true; };
el('status').append(...states.map((s, i) => { const option = node('option', names[i]); option.value = s; return option; }));
el('search').oninput = render; el('refresh').onclick = refresh;
el('status').onchange = () => { const pending = selected && pendingRequests.get(selected.id); if (pending) el('status').value = pending.task.status; };
el('save').onclick = async () => {
  if (!selected || selectedStale || busy || !online) return;
  const generation = detailGeneration;
  const taskId = selected.id;
  const request = pendingRequests.get(taskId) ?? { requestId: crypto.randomUUID(), expectedVersion: selected.version,
    task: { id: selected.id, title: selected.title, owner: selected.owner, group: selected.group, detail: selected.detail,
      lastConfirmedAt: selected.lastConfirmedAt, status: el('status').value } };
  pendingRequests.set(taskId, request);
  ++readGeneration; // Reads started before this write cannot acknowledge a newer state.
  busy = true; el('save').disabled = true; el('status').disabled = true;
  try {
    const response = await fetch('/api/tasks', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: JSON.stringify(request) });
    if (response.status === 409) {
      pendingRequests.delete(taskId);
      if (generation === detailGeneration) { el('saveNotice').textContent = '別の更新がありました。詳細を閉じて、最新のカードを開き直してください。'; selected = undefined; }
    }
    else {
      if (!response.ok) throw new Error(); const saved = await response.json();
      if (!validTask(saved) || !sameTask(saved, request.task, false) || saved.version !== request.expectedVersion + 1) throw new Error('Unconfirmed acknowledgement');
      pendingRequests.delete(taskId);
      acknowledgedVersions.set(taskId, Math.max(acknowledgedVersions.get(taskId) ?? 0, saved.version));
      if (generation === detailGeneration) { selected = saved; el('status').disabled = false; el('saveNotice').textContent = '保存しました'; }
    }
  } catch { if (generation === detailGeneration) el('saveNotice').textContent = '保存結果が未確認です。状態を変えずに保存を再度押すと、同じ要求を再送します。'; }
  finally { busy = false; el('save').disabled = !online || !selected || selectedStale; await refresh(); }
};
// Quota summary. Freshness is decided by the server only (single TTL definition); this code just displays it and never upgrades it.
const quotaProviders = { codex: 'Codex', claude: 'Claude', ag: 'AG' };
const quotaFreshness = { current: '最新', stale: '古い可能性', reference: '参考値', unknown: '不明' };
const quotaResets = ['none', 'pending', 'awaiting_refresh', 'invalid'];
const nullableTime = value => value === null || validTime(value);
const validQuotaEntry = entry => entry && typeof entry === 'object' && Object.hasOwn(quotaProviders, entry.provider) && Object.hasOwn(quotaFreshness, entry.freshness) &&
  quotaResets.includes(entry.resetState) && ['observedAt', 'collectedAt', 'lastSuccessAt', 'resetAt'].every(key => nullableTime(entry[key])) &&
  (entry.usedPercent === null || typeof entry.usedPercent === 'number');
function validQuota(value) {
  return value && validTime(value.servedAt) && Math.abs(Date.now() - Date.parse(value.servedAt)) <= 60000 &&
    Array.isArray(value.entries) && value.entries.length <= 6 && value.entries.every(validQuotaEntry);
}
function renderQuota(quota) {
  const items = quota.entries.map(entry => {
    const item = node('div', '', `quota-item ${entry.freshness}`);
    const percent = entry.usedPercent === null ? (entry.lastKnown ? `前回値(参考) ${entry.lastKnown.usedPercent}%` : '使用率: 不明') : `${entry.freshness === 'current' ? '使用率' : '使用率(参考)'}: ${entry.usedPercent}%`;
    item.append(node('h3', `${quotaProviders[entry.provider]} · ${quotaFreshness[entry.freshness]}`), node('small', percent),
      node('small', `観測: ${time(entry.observedAt)}`), node('small', `収集: ${time(entry.collectedAt)}`), node('small', `最終成功: ${time(entry.lastSuccessAt)}`),
      node('small', `リセット: ${time(entry.resetAt)}${entry.resetState === 'awaiting_refresh' ? ' (更新待ち)' : ''}`));
    if (entry.state !== 'ok') item.append(node('small', '取得状態: 失敗・曖昧・欠測のいずれか'));
    return item;
  });
  items.push(node('small', `配信: ${time(quota.servedAt)}`));
  el('quota').replaceChildren(...(quota.entries.length ? items : [node('p', 'クォータ情報は未接続です(不明)'), items.at(-1)]));
}
async function refreshQuota() {
  try {
    const response = await fetch('/api/quota', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!validQuota(next)) throw new Error('Invalid quota');
    renderQuota(next);
  } catch { el('quota').replaceChildren(node('p', 'クォータ情報を取得できません(不明)')); }
}
// Sign-in panel. State comes from the server (/api/auth/status: anonymous|owner|forbidden); no name, email or account id is ever requested or shown.
const authLabels = { anonymous: 'サインインしてください', owner: 'サインイン済み', forbidden: 'このアカウントには権限がありません' };
async function authPost(path, body) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function signIn() {
  try {
    const result = await authPost('/api/auth/sign-in/social', { provider: 'vercel', callbackURL: '/' });
    // Navigate only to the Vercel authorization endpoint returned by the library.
    if (typeof result?.url === 'string' && result.url.startsWith('https://vercel.com/')) location.assign(result.url); else throw new Error('Unexpected sign-in response');
  } catch { el('auth').replaceChildren(node('span', 'サインインを開始できません')); }
}
async function signOut() {
  try { await authPost('/api/auth/sign-out', {}); } catch { /* the session status below is authoritative */ }
  await refreshAuth(); refresh(); refreshQuota();
}
async function refreshAuth() {
  try {
    const response = await fetch('/api/auth/status', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { state } = await response.json();
    if (!Object.hasOwn(authLabels, state)) throw new Error('Invalid state');
    const button = node('button', state === 'anonymous' ? 'Vercelでサインイン' : 'サインアウト'); button.onclick = state === 'anonymous' ? signIn : signOut;
    el('auth').replaceChildren(node('span', authLabels[state]), button);
  } catch { el('auth').replaceChildren(node('span', '認証が利用できません')); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshQuota(); } });
el('times').textContent = '未取得'; render(); refresh(); setInterval(refresh, 30000); setInterval(refreshQuota, 30000);
if (typeof setTimeout === 'function') { setTimeout(refreshQuota, 0); setTimeout(refreshAuth, 0); }
