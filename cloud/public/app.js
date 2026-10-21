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
  typeof task.detail === 'string' && task.detail.length <= 100000 &&
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
    el('connection').textContent = '接続中'; el('times').textContent = `タスク一覧の同期: ${time(snapshot.observedAt)} · 30秒ごとに表示を確認`;
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
    if (fetched()) { el('times').textContent = `タスク一覧の同期: ${time(snapshot.observedAt)} · 古い可能性があります(再取得できていません)`; el('notice').textContent = '表示は最後に取得した状態で、古い可能性があります。更新ボタンで再接続できます。'; }
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
  const usage = value?.usage;
  if (usage && (usage.display_schema_version !== 1 || !Array.isArray(usage.cards) || usage.cards.length > 3 || !usage.cards.every(c => ['codex', 'claude', 'antigravity'].includes(c.provider) && Array.isArray(c.current_rows) && Array.isArray(c.last_known_rows) && c.current_rows.length <= 20 && c.last_known_rows.length <= 20))) return false;
  return value && validTime(value.servedAt) && Math.abs(Date.now() - Date.parse(value.servedAt)) <= 60000 &&
    Array.isArray(value.entries) && value.entries.length <= 6 && value.entries.every(validQuotaEntry);
}
// A successful response does not renew a saved observation or a reset window.
let quotaDisclosure = null, quotaSummary = null, quotaDetailsOpen = false;
const quotaPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
function currentQuotaRow(card, row, now = Date.now()) {
  const reset = Date.parse(row.reset_at), fresh = Date.parse(row.fresh_until);
  const limit = row.period === 'five_hour' ? 18000000 : row.period === 'weekly' ? 604800000 : 0;
  const timestamps = [card.collected_at, row.observed_at];
  return ['available', 'partial'].includes(card.status) && row.status === 'available' && !row.stale && !row.reset_passed && !row.reset_invalid &&
    quotaPercent(row.remaining_percent) && timestamps.every(value => !value || validTime(value) && Date.parse(value) <= now) &&
    validTime(card.collected_at) && validTime(row.fresh_until) && fresh >= now && validTime(row.reset_at) && reset > now && reset - now <= limit + 300000;
}
function quotaResetText(card, row, historical = false, now = Date.now()) {
  if (!row || !validTime(row.reset_at)) return 'リセット: 未取得';
  const reset = Date.parse(row.reset_at), limit = row.period === 'five_hour' ? 18000000 : row.period === 'weekly' ? 604800000 : 0;
  const stamp = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(reset) + ' JST';
  if (row.reset_invalid || !limit || reset - now > limit + 300000) return 'リセット: 未確認';
  if (reset <= now || row.reset_passed) return `参考 ${stamp}・更新待ち`;
  const fresh = !historical && ['available', 'partial'].includes(card.status) && row.status === 'available' && !row.stale &&
    validTime(card.collected_at) && Date.parse(card.collected_at) <= now && validTime(row.fresh_until) && Date.parse(row.fresh_until) >= now &&
    (!row.observed_at || validTime(row.observed_at) && Date.parse(row.observed_at) <= now);
  if (!fresh) return `参考 ${stamp}・古い値`;
  const minutes = Math.ceil((reset - now) / 60000), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return `${stamp}・あと${days ? days + '日' : ''}${hours ? hours + '時間' : ''}${minutes % 60}分`;
}
function quotaObservedText(card, row, historical, provider) {
  const observed = row?.observed_at;
  const collected = historical ? card?.last_success_collected_at : card?.collected_at;
  const value = validTime(observed) ? observed : provider === 'antigravity' && row && validTime(collected) ? collected : null;
  if (!value) return '観測: 未確認';
  const stamp = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(Date.parse(value));
  return `${validTime(observed) ? '観測' : '収集'}: ${stamp} JST${historical ? '・参考値' : ''}`;
}
// Card-level acquisition time: only the card's own collected_at, only when the collection succeeded and it is not in the future. last_success is never promoted here.
function quotaAcquiredText(card, now = Date.now()) {
  if (!card || !['available', 'partial'].includes(card.status) || !validTime(card.collected_at) || Date.parse(card.collected_at) > now) return '取得時刻: 未確認';
  return `取得時刻: ${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(Date.parse(card.collected_at))} JST`;
}
function renderQuota(quota) {
  const restoreFocus = Boolean(quotaSummary && document.activeElement === quotaSummary);
  quotaDetailsOpen = quotaDisclosure?.open ?? quotaDetailsOpen;
  const grid = node('div', '', 'quota-summary-grid');
  // No per-model allocations: Antigravity has two shared pools.
  for (const provider of ['codex', 'claude', 'antigravity']) {
    const cards = quota.usage?.cards.filter(card => card.provider === provider) ?? [];
    const card = cards.length === 1 ? cards[0] : null;
    const item = node('section', '', `quota-summary-card provider-${provider}`);
    item.append(node('h3', provider === 'antigravity' ? 'Antigravity' : quotaProviders[provider]), node('small', provider === 'antigravity' ? 'Remaining · Antigravity内の共有枠' : 'Remaining · 本人の契約枠'),
      node('small', quotaAcquiredText(card), 'quota-acquired'));
    for (const pool of provider === 'antigravity' ? ['gemini_shared', 'claude_gpt_shared'] : [null]) {
      if (pool) item.append(node('strong', pool === 'gemini_shared' ? 'Gemini shared' : 'Claude / GPT shared'));
      const rates = node('div', '', 'quota-rates');
      const states = [];
      // Codex: this account's collector reports no five-hour window, so only the weekly slot is shown. Its main figure needs a fresh row with its own original observation time; saved references stay in the details.
      for (const period of provider === 'codex' ? ['weekly'] : ['five_hour', 'weekly']) {
        const matches = card?.current_rows.filter(row => row.period === period && (row.shared_pool ?? null) === pool) ?? [];
        const row = matches.length === 1 ? matches[0] : null;
        const valid = row && currentQuotaRow(card, row) && (provider !== 'codex' || validTime(row.observed_at));
        const past = card?.last_known_rows.filter(row => row.period === period && (row.shared_pool ?? null) === pool) ?? [];
        const reference = provider !== 'codex' && !valid && past.length === 1 && quotaPercent(past[0].remaining_percent) ? past[0] : null;
        const value = valid ? row.remaining_percent : reference ? reference.remaining_percent : null;
        const state = valid ? 'current' : reference ? 'reference' : row?.status === 'not_reported' ? 'unknown' : row && (row.stale || row.reset_passed || Date.parse(row.fresh_until) < Date.now() || Date.parse(row.reset_at) <= Date.now()) ? 'stale' : 'unknown';
        states.push(state);
        const window = node('span', `${period === 'five_hour' ? '5h' : 'Weekly'} ${value === null ? '?' : `${Number(value.toFixed(1))}%`}${reference ? ' reference' : ''}${provider === 'codex' && !valid ? ' (未更新)' : ''}`, 'quota-window ' + state);
        const shown = valid ? row : reference ?? (provider === 'codex' ? null : row);
        window.append(node('small', quotaResetText(card, shown, Boolean(reference)), 'quota-reset'),
          node('small', quotaObservedText(card, shown, Boolean(reference), provider), 'quota-observed'));
        rates.append(window);
      }
      item.append(rates);
      if (states.some(state => state !== 'current')) item.append(node('small', [...new Set(states.filter(state => state !== 'current'))].join(' / '), 'quota-badge'));
    }
    grid.append(item);
  }
  grid.append(node('p', '各枠の日時は残量の観測・収集時刻です。表示の更新だけでは残量を再取得しません。ChatGPTの単独利用枠は未取得です。', 'quota-summary-note'));
  const details = node('details', '', 'quota-details'); details.open = quotaDetailsOpen;
  const summary = node('summary', 'Quota details');
  const content = node('div', '', 'quota-detail-grid');
  details.append(summary, content);
  quotaDisclosure = details; quotaSummary = summary;
  details.addEventListener?.('toggle', () => { if (quotaDisclosure === details) quotaDetailsOpen = details.open; });
  renderQuotaDetails(quota, content);
  if (quota.usage) for (const card of quota.usage.cards) {
    const diagnostic = node('section', '', 'quota-item');
    diagnostic.append(node('h3', card.provider === 'antigravity' ? 'Antigravity shared pools' : quotaProviders[card.provider]),
      node('small', `Collection: ${card.status ?? 'unknown'}${card.error_kind ? ` / ${card.error_kind}` : ''}`));
    for (const row of card.current_rows) diagnostic.append(node('small', `${row.shared_pool ?? row.model_family} / ${row.period}: remaining ${currentQuotaRow(card, row) ? row.remaining_percent + '%' : '?'} / fresh until ${time(row.fresh_until)}`));
    for (const reference of card.model_references ?? []) diagnostic.append(node('small', `${reference.official_name}: ${reference.shared_pool ?? 'unconfirmed pool'} reference; individual quota not reported`));
    content.append(diagnostic);
  }
  el('quota').replaceChildren(grid, details);
  if (restoreFocus) summary.focus?.({ preventScroll: true });
}
function renderQuotaDetails(quota, target) {
  if (quota.usage) {
    const items = quota.usage.cards.map(card => {
      const item = node('div', '', 'quota-item reference');
      item.append(node('h3', `${card.provider === 'antigravity' ? 'AG' : quotaProviders[card.provider]} ・ 保存済み取得値`), node('small', `収集: ${time(card.collected_at)} ・ 最終成功: ${time(card.last_success_collected_at)}`));
      for (const [rows, historical] of [[card.current_rows, false], [card.last_known_rows, true]]) for (const row of rows) {
        const current = !historical && currentQuotaRow(card, row);
        const used = typeof row.used_percent === 'number' && Number.isFinite(row.used_percent) && row.used_percent >= 0 && row.used_percent <= 100 ? `${row.used_percent}%` : '不明';
        item.append(node('small', `${row.model_family} / ${row.period}${row.shared_pool ? ' / ' + row.shared_pool : ''} ・ ${current ? '取得値' : historical ? '前回値(参考)' : '現在値不明'}: ${used} ・ 観測: ${time(row.observed_at)} ・ リセット: ${time(row.reset_at)}${row.reset_passed ? ' (更新待ち)' : ''}`));
      }
      if (!card.current_rows.length && !card.last_known_rows.length) item.append(node('small', 'クォータ値は不明'));
      item.append(node('small', '新規収集は開始していません。古い値は参考情報です。'));
      return item;
    });
    items.push(node('small', `配信: ${time(quota.servedAt)}`)); target.replaceChildren(...items); return;
  }
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
  target.replaceChildren(...(quota.entries.length ? items : [node('p', 'クォータ情報は未接続です(不明)'), items.at(-1)]));
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
const authLabels = { anonymous: 'サインインしてください', owner: 'サインイン済み', forbidden: 'このアカウントには権限がありません', diagnostic: 'オーナー未設定(診断モード)' };
// Diagnostic only: remember a SHA-256-derived label of the authorization-URL state (never the state itself) so a rejected return can be matched to the server log.
// The label is NOT an authorization proof and nothing about the account is stored or shown.
function clearCorrelation() { try { sessionStorage.removeItem('authCorrelation'); } catch { /* storage unavailable */ } }
async function rememberCorrelation(authorizationUrl) {
  clearCorrelation(); // never reuse an earlier attempt's label, even if this attempt yields none
  try {
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state || typeof crypto === 'undefined' || !crypto.subtle || typeof sessionStorage === 'undefined') return;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state));
    const label = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    if (/^[0-9a-f]{16}$/.test(label)) sessionStorage.setItem('authCorrelation', label); // only the hash label is stored, never the raw state
  } catch { clearCorrelation(); }
}
// The server returns to the root with ?error=<code>. Only the exact code owner_unconfirmed may be explained as the diagnostic rejection (with its matching label);
// any other error code is reported neutrally and never claims that reason.
function returnedAuthError() {
  const match = /(?:^|[?&])error=([^&#]*)/.exec(String(location.search ?? ''));
  if (!match) return null;
  let label = null; try { label = sessionStorage.getItem('authCorrelation'); } catch { /* storage unavailable */ }
  const safeLabel = /^[0-9a-f]{16}$/.test(label ?? '') ? label : null;
  if (match[1] === 'owner_unconfirmed') return { ownerUnconfirmed: true, label: safeLabel };
  if (match[1] === 'email_not_found') return { ownerUnconfirmed: false, emailNotFound: true, label: safeLabel };
  return { ownerUnconfirmed: false, label: null };
}
async function authPost(path, body) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function signIn() {
  clearCorrelation(); // stale label from a previous attempt must not survive a new sign-in
  try {
    const result = await authPost('/api/auth/sign-in/social', { provider: 'vercel', callbackURL: '/' });
    // Navigate only to the Vercel authorization endpoint returned by the library.
    if (typeof result?.url === 'string' && result.url.startsWith('https://vercel.com/')) { await rememberCorrelation(result.url); location.assign(result.url); } else throw new Error('Unexpected sign-in response');
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
    const signingIn = state === 'anonymous' || state === 'diagnostic';
    const button = node('button', signingIn ? 'Vercelでサインイン' : 'サインアウト'); button.onclick = signingIn ? signIn : signOut;
    const parts = [node('span', authLabels[state]), button], failure = state === 'diagnostic' ? returnedAuthError() : null;
    // Only error=owner_unconfirmed gets the diagnostic explanation (+ matching label, when one is stored). Other errors are reported neutrally.
    if (failure?.ownerUnconfirmed) parts.push(node('span', `診断: サインインは「オーナー未確認」のため拒否されました。ログインもオーナー認定も成立していません。${failure.label ? `相関ID: ${failure.label}` : '(相関IDなし)'}`));
    else if (failure?.emailNotFound) parts.push(node('span', `Vercelからメール情報を取得できず、サインインは未完了です。Appのscope設定の確認が必要です。ログイン・オーナー確認は成立していません。${failure.label ? `相関ID: ${failure.label}` : '(相関IDなし)'}`));
    else if (failure) parts.push(node('span', 'サインインは完了しませんでした(エラー)。ログインは成立していません。'));
    el('auth').replaceChildren(...parts);
  } catch { el('auth').replaceChildren(node('span', '認証が利用できません')); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshQuota(); } });
el('times').textContent = '未取得'; render(); refresh(); setInterval(refresh, 30000); setInterval(refreshQuota, 30000);
if (typeof setTimeout === 'function') { setTimeout(refreshQuota, 0); setTimeout(refreshAuth, 0); }
