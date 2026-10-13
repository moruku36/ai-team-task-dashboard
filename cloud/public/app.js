const states = ['To Do', 'In Progress', 'Awaiting Approval', 'Blocked', 'Verifying', 'Done'];
const names = ['未着手', '進行中', '承認待ち', '中断・保留', '検証中', '完了'];
const groups = ['現行', '要棚卸し', '完了履歴'];
let snapshot = { tasks: [] }, group = '現行', online = false, selected, busy = false;
const pendingRequests = new Map();
let readGeneration = 0;
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
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
    value.tasks.every(validTask) && new Set(value.tasks.map(task => task.id)).size === value.tasks.length;
}
const el = id => document.getElementById(id);
const time = value => value ? new Date(value).toLocaleString('ja-JP') : '未記録';
const node = (tag, text, className) => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
function render() {
  el('groups').replaceChildren(...groups.map(g => {
    const b = node('button', `${g} · ${snapshot.tasks.filter(t => t.group === g).length}`, group === g ? 'active' : '');
    b.onclick = () => { group = g; render(); }; return b;
  }));
  const query = el('search').value.toLocaleLowerCase();
  el('board').replaceChildren(...states.map((s, i) => {
    const column = node('section', '', 'column');
    const tasks = snapshot.tasks.filter(t => t.group === group && t.status === s && `${t.title} ${t.owner} ${t.detail}`.toLocaleLowerCase().includes(query));
    column.append(node('h2', `${names[i]} · ${tasks.length}`));
    for (const task of tasks) {
      const card = node('button', '', 'card'); card.append(node('span', task.id, 'id'), node('strong', task.title),
        node('small', `主担当: ${task.owner}`), node('small', `更新: ${time(task.updatedAt)}`), node('small', `確認: ${time(task.lastConfirmedAt)}`));
      if (pendingRequests.has(task.id)) card.append(node('small', '保存結果が未確認'));
      card.onclick = () => {
        if (busy) return;
        selected = task; const pending = pendingRequests.get(task.id);
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
    if (!validSnapshot(next) || next.revision < (snapshot.revision ?? 0)) throw new Error('Invalid or older snapshot');
    snapshot = next; online = true;
    el('connection').textContent = '接続中'; el('times').textContent = `最終取得: ${time(snapshot.observedAt)} · 30秒ごとに確認`;
    el('notice').textContent = ''; render();
  } catch {
    if (generation !== readGeneration || busy) return;
    online = false; el('connection').textContent = '接続できません'; el('notice').textContent = '表示は最後に取得した状態です。更新ボタンで再接続できます。';
  }
  el('save').disabled = busy || !online || !selected;
}
el('status').append(...states.map((s, i) => { const option = node('option', names[i]); option.value = s; return option; }));
el('search').oninput = render; el('refresh').onclick = refresh;
el('status').onchange = () => { const pending = selected && pendingRequests.get(selected.id); if (pending) el('status').value = pending.task.status; };
el('save').onclick = async () => {
  if (!selected || busy || !online) return;
  const taskId = selected.id;
  const request = pendingRequests.get(taskId) ?? { requestId: crypto.randomUUID(), expectedVersion: selected.version,
    task: { id: selected.id, title: selected.title, owner: selected.owner, group: selected.group, detail: selected.detail,
      lastConfirmedAt: selected.lastConfirmedAt, status: el('status').value } };
  pendingRequests.set(taskId, request);
  ++readGeneration; // Reads started before this write cannot acknowledge a newer state.
  busy = true; el('save').disabled = true; el('status').disabled = true;
  try {
    const response = await fetch('/api/tasks', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: JSON.stringify(request) });
    if (response.status === 409) { pendingRequests.delete(taskId); el('saveNotice').textContent = '別の更新がありました。詳細を閉じて、最新のカードを開き直してください。'; selected = undefined; }
    else {
      if (!response.ok) throw new Error(); const saved = await response.json();
      if (!validTask(saved) || saved.id !== taskId || saved.version !== request.expectedVersion + 1) throw new Error('Unconfirmed acknowledgement');
      selected = saved; pendingRequests.delete(taskId); el('status').disabled = false; el('saveNotice').textContent = '保存しました';
    }
  } catch { el('saveNotice').textContent = '保存結果が未確認です。状態を変えずに保存を再度押すと、同じ要求を再送します。'; }
  finally { busy = false; el('save').disabled = !online || !selected; await refresh(); }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
render(); refresh(); setInterval(refresh, 30000);
