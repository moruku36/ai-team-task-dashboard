const states = ['To Do', 'In Progress', 'Blocked', 'Done'];
const names = ['To Do', 'In Progress', 'Blocked', 'Done'];
const legacyNames = { 'Awaiting Approval': '旧「承認待ち」', 'Verifying': '旧「最終確認」' };
// Legacy-status cards are only displayed as their mapped status. The detail dialog defaults to "keep as is": saving without
// choosing a status never persists the display mapping; choosing any of the four statuses is an explicit change.
const KEEP = 'keep-legacy';
const keepOption = (() => { const option = document.createElement('option'); option.textContent = '旧状態のまま（変更しない）'; option.value = KEEP; option.hidden = true; return option; })();
const statusChoice = (task, request) => request ? (request.statusChange === 'explicit' || !task.legacyStatus ? request.task.status : KEEP) : (task.legacyStatus ? KEEP : task.status);
const acknowledges = (saved, request, legacyAtRequest) => taskFields.filter(key => key !== 'legacyStatus').every(key => saved[key] === request.task[key]) &&
  (request.statusChange === 'explicit' || !legacyAtRequest ? saved.legacyStatus === undefined : saved.legacyStatus === legacyAtRequest);
const groups = ['現行', '要棚卸し', '完了履歴'];
let snapshot = { tasks: [] }, group = '現行', online = false, selected, busy = false;
const pendingRequests = new Map();
// The stored legacy status the card had when its save request was created: kept per request, because the dialog (and `selected`) may be closed before the response arrives.
const pendingLegacy = new Map();
const acknowledgedVersions = new Map();
let readGeneration = 0;
let detailGeneration = 0, selectedStale = false;
const taskFields = ['id', 'title', 'owner', 'status', 'legacyStatus', 'group', 'detail', 'lastConfirmedAt'];
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
  typeof task.owner === 'string' && (task.owner === '' || task.owner.trim()) && task.owner.length <= 100 &&
  typeof task.detail === 'string' && task.detail.length <= 100000 &&
  states.includes(task.status) && (task.group === null || groups.includes(task.group)) &&
  (task.legacyStatus === undefined || Object.hasOwn(legacyNames, task.legacyStatus)) &&
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
  el('groups').replaceChildren(...[...groups, null].map(g => {
    const b = node('button', `${g ?? '未分類'} · ${count(snapshot.tasks.filter(t => t.group === g).length)}`, group === g ? 'active' : '');
    b.onclick = () => { group = g; render(); }; return b;
  }));
  const query = el('search').value.toLocaleLowerCase();
  el('board').replaceChildren(...states.map((s, i) => {
    const column = node('section', '', 'column');
    const tasks = snapshot.tasks.filter(t => t.group === group && t.status === s && `${t.title} ${t.owner || '担当未設定'} ${t.detail}`.toLocaleLowerCase().includes(query));
    column.append(node('h2', `${names[i]} · ${count(tasks.length)}`));
    for (const task of tasks) {
      const card = node('button', '', 'card'); card.append(node('span', task.id, 'id'), node('strong', task.title),
        node('small', `主担当: ${task.owner || '未設定'}`), node('small', `更新: ${time(task.updatedAt)}`), node('small', `確認: ${time(task.lastConfirmedAt)}`));
      if (task.legacyStatus) card.append(node('small', `${legacyNames[task.legacyStatus]}から表示（要確認・自動完了にはしません）`, 'quota-badge'));
      if (pendingRequests.has(task.id)) card.append(node('small', '保存結果が未確認'));
      card.onclick = () => {
        if (busy) return;
        ++detailGeneration; selected = task; selectedStale = false; const pending = pendingRequests.get(task.id);
        el('detailTitle').textContent = task.title;
        el('detailBody').textContent = `${task.id} / 主担当: ${task.owner || '未設定'}${task.legacyStatus ? ` / 保存上の旧状態: ${task.legacyStatus}（表示上は ${task.status} 列。自動では変更されません）` : ''}\n更新: ${time(task.updatedAt)} / 確認: ${time(task.lastConfirmedAt)}\n\n${task.detail}`;
        keepOption.hidden = !task.legacyStatus;
        el('status').value = statusChoice(task, pending); el('status').disabled = Boolean(pending);
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
el('status').append(keepOption, ...states.map((s, i) => { const option = node('option', names[i]); option.value = s; return option; }));
el('search').oninput = render; el('refresh').onclick = refresh;
el('status').onchange = () => { const pending = selected && pendingRequests.get(selected.id); if (pending) el('status').value = statusChoice(selected, pending); };
el('save').onclick = async () => {
  if (!selected || selectedStale || busy || !online) return;
  const generation = detailGeneration;
  const taskId = selected.id;
  const choice = el('status').value, keep = choice === KEEP;
  const request = pendingRequests.get(taskId) ?? { requestId: crypto.randomUUID(), expectedVersion: selected.version,
    task: { id: selected.id, title: selected.title, owner: selected.owner, group: selected.group, detail: selected.detail,
      lastConfirmedAt: selected.lastConfirmedAt, status: keep ? selected.status : choice },
    ...(selected.legacyStatus && !keep ? { statusChange: 'explicit' } : {}) };
  pendingRequests.set(taskId, request);
  if (!pendingLegacy.has(taskId)) pendingLegacy.set(taskId, selected.legacyStatus ?? null);
  ++readGeneration; // Reads started before this write cannot acknowledge a newer state.
  busy = true; el('save').disabled = true; el('status').disabled = true;
  try {
    const response = await fetch('/api/tasks', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: JSON.stringify(request) });
    if (response.status === 409) {
      pendingRequests.delete(taskId); pendingLegacy.delete(taskId);
      if (generation === detailGeneration) { el('saveNotice').textContent = '別の更新がありました。詳細を閉じて、最新のカードを開き直してください。'; selected = undefined; }
    }
    else {
      if (!response.ok) throw new Error(); const saved = await response.json();
      if (!validTask(saved) || !acknowledges(saved, request, pendingLegacy.get(taskId)) || saved.version !== request.expectedVersion + 1) throw new Error('Unconfirmed acknowledgement');
      pendingRequests.delete(taskId); pendingLegacy.delete(taskId);
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
const jstSeconds = value => `${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(Date.parse(value))} JST`;
// Gemini 4 Argon weekly: its own window, never folded into the Gemini shared values. Missing/invalid -> unknown; stale or historical -> reference.
function argonWindow(card, now = Date.now()) {
  const usable = x => x && typeof x === 'object' && x.limit_id === 'gemini_4_argon_weekly' && quotaPercent(x.remaining_percent);
  const a = card?.argon_weekly, past = card?.last_known_argon_weekly;
  const collectedOk = Boolean(card) && validTime(card.collected_at) && Date.parse(card.collected_at) <= now;
  const live = usable(a) && collectedOk && ['available', 'partial'].includes(card.status) && a.status === 'available' && validTime(a.fresh_until) && Date.parse(a.fresh_until) >= now &&
    (!a.reset_at || validTime(a.reset_at) && Date.parse(a.reset_at) > now);
  const ref = !live && usable(past) ? past : null;
  const value = live ? a.remaining_percent : ref ? ref.remaining_percent : null;
  const state = live ? 'current' : ref ? 'reference' : 'unknown';
  const acquired = live ? card.collected_at : ref ? card?.last_success_collected_at : null;
  const window = node('span', `Argon Weekly ${value === null ? '不明' : `${Number(value.toFixed(1))}%`}${ref ? ' 参考' : ''}`, 'quota-window argon ' + state);
  window.setAttribute?.('data-limit', 'gemini_4_argon_weekly');
  const source = live ? a : ref;
  window.append(node('small', source?.reset_at ? quotaResetText(card, { ...source, period: 'weekly' }, Boolean(ref)) : source?.reset_approximate ? 'リセット: 概算のみ(確定時刻なし)' : 'リセット: 未取得', 'quota-reset'),
    node('small', validTime(acquired) ? `${live ? '取得' : '参考(前回成功)'}: ${jstSeconds(acquired)}` : '取得: 未確認', 'quota-observed'));
  return { window, state };
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
        const window = node('span', `${period === 'five_hour' ? '5h' : 'Weekly'} ${value === null ? (row?.status === 'disabled' ? '無効' : '?') : `${Number(value.toFixed(1))}%`}${reference ? ' reference' : ''}${provider === 'codex' && !valid ? ' (未更新)' : ''}`, 'quota-window ' + state);
        const shown = valid ? row : reference ?? (provider === 'codex' ? null : row);
        window.append(node('small', quotaResetText(card, shown, Boolean(reference)), 'quota-reset'),
          node('small', quotaObservedText(card, shown, Boolean(reference), provider), 'quota-observed'));
        rates.append(window);
      }
      item.append(rates);
      if (pool === 'gemini_shared') {
        const argon = argonWindow(card), argonRates = node('div', '', 'quota-rates');
        argonRates.append(argon.window); states.push(argon.state);
        item.append(node('strong', 'Gemini 4 Argon（共有枠とは別）'), argonRates);
      }
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
      item.append(node('h3', `${card.provider === 'antigravity' ? 'AG' : quotaProviders[card.provider]} ・ 保存済み取得値`), node('small', `収集: ${time(card.collected_at)} ・ 最終成功: ${time(card.last_success_collected_at)}`),
        node('small', `アカウント照合: ${card.account_alignment === 'verified' ? '確認済み' : card.account_alignment === 'mismatch' ? '不一致(値を表示しません)' : '未確認'}`));
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
    if (el('quotaImport')) el('quotaImport').hidden = state !== 'owner';
    if (el('planImport')) el('planImport').hidden = state !== 'owner';
  } catch { el('auth').replaceChildren(node('span', '認証が利用できません')); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshQuota(); } });
// Owner-only manual upload of the local display file. The server keeps only allowlisted fields and refuses an older snapshot; this code never reads secrets or logs.
// The upload is narrowed HERE, before it leaves the browser (the server filters again). Only fields the dashboard reads are copied; titles, HTTP details, tokens,
// debug objects, derived windows and anything unknown never enter the request body. Must stay identical to cloud/usage-project.mjs (a test compares them).
const uploadKeys = {
  card: ['provider', 'status', 'acquisition_source', 'error_kind', 'collected_at', 'provider_updated_at', 'attempted_at', 'attempt_started_at', 'attempt_finished_at', 'retry_not_before', 'snapshot_updated_at', 'stale_after_seconds', 'account_alignment', 'last_success_collected_at'],
  row: ['quota_scope', 'model_family', 'period', 'shared_pool', 'window_id', 'observed_at', 'reset_at', 'status', 'used_percent', 'remaining_percent'],
  argon: ['limit_id', 'percent', 'percent_basis', 'observed_at', 'reset_at', 'reset_in_seconds'],
  reference: ['model_id', 'quota_scope', 'shared_pool', 'pool_mapping_source', 'pool_mapping_url', 'catalog_confirmation', 'catalog_observed_at'] };
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const pickScalars = (source, keys) => Object.fromEntries(keys.filter(key => source[key] !== undefined && (typeof source[key] !== 'object' || source[key] === null)).map(key => [key, source[key]]));
const pickList = (values, keys, max) => (Array.isArray(values) ? values.slice(0, max) : []).filter(plainObject).map(item => pickScalars(item, keys));
function projectUsageForUpload(input) {
  if (!plainObject(input) || input.display_schema_version !== 1 || !Array.isArray(input.cards)) throw new Error('Unsupported usage schema');
  const cards = [];
  for (const card of input.cards) {
    if (!plainObject(card) || !['codex', 'claude', 'antigravity'].includes(card.provider) || cards.some(item => item.provider === card.provider)) continue;
    const out = { ...pickScalars(card, uploadKeys.card), current_rows: pickList(card.current_rows, uploadKeys.row, 20), last_known_rows: pickList(card.last_known_rows, uploadKeys.row, 20) };
    if (card.provider === 'antigravity') {
      const references = Array.isArray(card.model_references) ? card.model_references.slice(0, 20).filter(plainObject) : [];
      out.model_references = references.map(reference => ({ ...pickScalars(reference, uploadKeys.reference),
        ...(Array.isArray(reference.shared_window_ids) ? { shared_window_ids: reference.shared_window_ids.filter(id => typeof id === 'string').slice(0, 8) } : {}) }));
      for (const key of ['argon_weekly', 'last_known_argon_weekly']) if (plainObject(card[key])) out[key] = pickScalars(card[key], uploadKeys.argon);
    }
    cards.push(out);
  }
  return { display_schema_version: 1, view_read_at: typeof input.view_read_at === 'string' ? input.view_read_at : null, cards };
}
async function sendUsage() {
  const file = el('quotaFile').files?.[0], notice = el('quotaImportNotice');
  if (!file) { notice.textContent = 'ファイルを選んでください。'; return; }
  if (file.size > 100000) { notice.textContent = 'ファイルが大きすぎます(100KB以下)。'; return; }
  try {
    const usage = projectUsageForUpload(JSON.parse(await file.text()));
    const response = await fetch('/api/quota', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: JSON.stringify({ requestId: crypto.randomUUID(), usage }) });
    const result = await response.json().catch(() => ({}));
    notice.textContent = response.ok ? `取り込みました(受信 ${time(result.receivedAt)}・収集時刻はファイルの値のままです)` : response.status === 409 ? `取り込みを中止しました: ${result.error ?? '保存済みの方が新しい、または競合'}` : `取り込めませんでした(HTTP ${response.status})`;
    if (response.ok) await refreshQuota();
  } catch { notice.textContent = 'ファイルを読めない、または送信に失敗しました。保存済みの値は変わっていません。'; }
}
if (el('quotaSend')) el('quotaSend').onclick = sendUsage;
// Owner-only one-time apply of a ticket sync plan (made by scripts/ticket-sync-plan.mjs). Each operation is one ordinary POST /api/tasks with its own fixed requestId and
// expectedVersion, so a repeat is deduplicated and a changed card (409) stops the run. Nothing is rolled back automatically; the notice lists what was applied.
const planStatuses = ['To Do', 'In Progress', 'Blocked', 'Done'];
const validPlanOperation = op => op && typeof op === 'object' && ['create', 'status'].includes(op.kind) && typeof op.requestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(op.requestId) &&
  Number.isSafeInteger(op.expectedVersion) && op.expectedVersion >= 0 && (op.kind === 'create') === (op.expectedVersion === 0) && op.task && typeof op.task === 'object' && op.task.id === op.id &&
  typeof op.task.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(op.task.id) && typeof op.task.title === 'string' && op.task.title.trim() && op.task.title.length <= 300 &&
  planStatuses.includes(op.task.status) && typeof op.task.owner === 'string' && op.task.owner.length <= 100 && (op.task.group === null || groups.includes(op.task.group)) &&
  typeof op.task.detail === 'string' && op.task.detail.length <= 100000 && (op.task.lastConfirmedAt === null || validTime(op.task.lastConfirmedAt)) &&
  // Every operation is bound to the local source file it was made from; a plan without that binding is never applied.
  typeof op.sourceFile === 'string' && /^[^\\/]{1,200}\.md$/.test(op.sourceFile) && typeof op.sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(op.sourceSha256) && Number.isSafeInteger(op.sourceMtimeMs) && op.sourceMtimeMs > 0;
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
// The browser cannot look at the local backlog by itself. The owner must select the source files named in the plan; this code hashes exactly those bytes and refuses to send anything
// unless every one equals the plan's hash and was not modified after the plan was made. Limits (not hidden): it checks the files the owner picked, at the moment of picking; a stale copy picked
// instead of the live file, or a change after this check, is not detected here (the cloud's expectedVersion still protects the cloud side).
async function verifySources(operations, plan) {
  const picked = new Map([...(el('planSources').files ?? [])].map(file => [file.name, file])), problems = [];
  for (const op of operations) {
    const file = picked.get(op.sourceFile);
    if (!file) { problems.push(`${op.id}: ${op.sourceFile} が選ばれていません`); continue; }
    if (file.lastModified > op.sourceMtimeMs) { problems.push(`${op.id}: ファイルがプラン作成後に更新されています`); continue; }
    if (hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) !== op.sourceSha256) problems.push(`${op.id}: 内容がプラン作成時と違います`);
  }
  return problems;
}
async function applyPlan() {
  const notice = el('planNotice'), file = el('planFile').files?.[0];
  if (!file) { notice.textContent = 'プランファイルを選んでください。'; return; }
  if (file.size > 3000000) { notice.textContent = 'ファイルが大きすぎます。'; return; }
  let plan;
  try { plan = JSON.parse(await file.text()); } catch { notice.textContent = 'ファイルを読めません。何も送っていません。'; return; }
  const operations = plan?.operations;
  if (!Array.isArray(operations) || !operations.length || operations.length > 30 || !operations.every(validPlanOperation) || new Set(operations.map(op => op.id)).size !== operations.length || !validTime(plan.generatedAt)) { notice.textContent = 'プランの形式が不正です。何も送っていません。'; return; }
  const age = Date.now() - Date.parse(plan.generatedAt);
  if (age > 30 * 60000 || age < -60000) { notice.textContent = 'プランが古い(30分超)か時刻が不正です。作り直してください。何も送っていません。'; return; }
  let problems;
  try { problems = await verifySources(operations, plan); } catch { problems = ['ローカルファイルを検証できません']; }
  if (problems.length) { notice.textContent = `ローカル検証に失敗したため適用しません(何も送っていません): ${problems.slice(0, 5).join(' / ')}${problems.length > 5 ? ` ほか${problems.length - 5}件` : ''}`; return; }
  const created = operations.filter(op => op.kind === 'create').length;
  if (!globalThis.confirm?.(`${operations.length}件を順に適用します(作成 ${created}・状態更新 ${operations.length - created})。競合した時点で中止し、巻き戻しはしません。`)) { notice.textContent = '中止しました。何も送っていません。'; return; }
  const applied = []; busy = true;
  try {
    for (const op of operations) {
      const task = { id: op.task.id, title: op.task.title, status: op.task.status, owner: op.task.owner, group: op.task.group, detail: op.task.detail, lastConfirmedAt: op.task.lastConfirmedAt };
      let response;
      try { response = await fetch('/api/tasks', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1' }, body: JSON.stringify({ requestId: op.requestId, expectedVersion: op.expectedVersion, task }) }); }
      catch { notice.textContent = `${op.id}の結果が未確認です。適用済み: ${applied.join(', ') || 'なし'}。同じファイルでもう一度適用すると、同じ要求IDで重複なく再送されます。`; return; }
      if (!response.ok) { notice.textContent = `${op.id}で中止しました(HTTP ${response.status}${response.status === 409 ? '・競合: カードが変更されています' : ''})。適用済み: ${applied.join(', ') || 'なし'}。残りは送っていません。自動では戻しません。`; return; }
      applied.push(op.id);
    }
    notice.textContent = `${applied.length}件を適用しました: ${applied.join(', ')}`;
  } finally { busy = false; await refresh(); }
}
if (el('planSend')) el('planSend').onclick = applyPlan;
el('times').textContent = '未取得'; render(); refresh(); setInterval(refresh, 30000); setInterval(refreshQuota, 30000);
if (typeof setTimeout === 'function') { setTimeout(refreshQuota, 0); setTimeout(refreshAuth, 0); }
