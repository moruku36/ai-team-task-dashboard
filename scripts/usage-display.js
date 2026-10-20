/* Private, read-only metadata. No provider CLI, auth, keys or collection requests. */
(() => {
  let data = null, failed = false;
  const panel = document.createElement('aside');
  panel.id = 'dashboard-usage';
  panel.setAttribute('aria-label', 'AI残量の採集値');
  panel.style.cssText = 'padding:6px 12px;font-size:12px;line-height:1.4;font-family:ui-sans-serif,system-ui,sans-serif;background:inherit;color:inherit;border-bottom:1px solid #374151';
  let detailsOpen = false, disclosure = null;
  const names = {codex: 'Codex', claude: 'Claude（本人契約）', antigravity: 'Antigravity（共有枠）', mimo: 'MiMo API'};
  const errors = {rate_limited:'取得制限中（cooldown）', executable_not_found:'タスク環境でCLI未検出', timeout:'取得timeout', parse_error:'読取失敗', version_mismatch:'版不一致', authentication_required:'認証確認待ち', permission_denied:'アクセス拒否', unknown:'取得失敗'};
  const pools = {gemini_shared:'AG Gemini共有枠',claude_gpt_shared:'AG Claude / GPT共有枠'};
  const ISO_CURRENCIES = new Set(['USD', 'EUR', 'JPY', 'GBP', 'CNY', 'CHF', 'CAD', 'AUD', 'HKD', 'SGD', 'KRW', 'INR', 'BRL', 'TWD', 'SEK', 'NOK', 'NZD', 'MXN', 'ZAR', 'RUB']);
  const formatMimoMoney = (item) => {
    if (!item || typeof item.amount !== 'number' || !Number.isFinite(item.amount)) {
      return { text: '未取得', isNegative: false, isDebt: false, valid: false };
    }
    const amount = item.amount;
    const isNegative = amount < 0 || Object.is(amount, -0);
    const abs = Math.abs(amount);
    let numStr;
    if (abs === 0) {
      numStr = '0.00';
    } else if (abs < 0.01) {
      numStr = isNegative ? '> -0.01' : '< 0.01';
    } else {
      const fixed = abs.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      const parts = fixed.split('.');
      const fracPart = (parts[1] || '').padEnd(2, '0');
      numStr = (isNegative ? '-' : '') + parts[0] + '.' + fracPart;
    }
    // An unrecognised currency string is never echoed or guessed: keep the amount as a reference only.
    if (!item.currency_verified || !item.currency || !ISO_CURRENCIES.has(item.currency)) {
      return { text: `${numStr} 通貨未確認`, isNegative, isDebt: isNegative, valid: false, unconfirmedCurrency: true };
    }
    return { text: `${item.currency} ${numStr}`, isNegative, isDebt: isNegative, valid: true };
  };
  // Cards hug their content (no flex-grow) so the right side is not left empty; narrow widths simply wrap.
  const cardStyle = accent => `flex:0 1 auto;min-width:150px;max-width:100%;box-sizing:border-box;border-left:3px solid ${accent};border-radius:4px;padding:4px 10px 4px 8px;background:transparent;color:inherit`;
  const hasAmount = item => !!item && typeof item.amount === 'number' && Number.isFinite(item.amount);
  // Last money value that was actually shown from a collected payload; survives display-communication failures.
  let mimoLastGood = null;
  const rememberMimo = (money, collectedAt, observedAt) => {
    if (mimoLastGood?.collectedAt && collectedAt && Date.parse(mimoLastGood.collectedAt) > Date.parse(collectedAt)) return;
    mimoLastGood = {money: {amount: money.amount, currency: money.currency, currency_verified: money.currency_verified}, collectedAt, observedAt};
  };
  const mimoView = (card, now) => {
    const cur = card.balance, past = card.last_known_balance;
    if (card.account_alignment === 'mismatch') { mimoLastGood = null; return {kind: 'none', label: 'アカウント不一致（旧残高破棄）'}; }
    const reference = (money, collectedAt, observedAt, label) => ({kind: 'reference', money, collectedAt, observedAt, label});
    const lastGood = () => mimoLastGood && reference(mimoLastGood.money, mimoLastGood.collectedAt, mimoLastGood.observedAt, '更新失敗');
    if (failed) return lastGood() || {kind: 'none', label: '取得失敗'};
    const future = card.collected_at && Date.parse(card.collected_at) > now;
    let view = null;
    if (hasAmount(cur)) {
      const verified = !!cur.currency_verified;
      const fresh = verified && !cur.stale && (!cur.fresh_until || Date.parse(cur.fresh_until) >= now) && card.status === 'available' && !future;
      const expired = cur.stale || (cur.fresh_until && Date.parse(cur.fresh_until) < now) || card.status === 'stale';
      if (fresh) view = {kind: 'current', money: cur, collectedAt: card.collected_at, observedAt: cur.observed_at};
      else if (verified && expired) view = {kind: 'stale', money: cur, collectedAt: card.collected_at, observedAt: cur.observed_at, label: '古い情報'};
      else if (!verified) view = reference(cur, card.collected_at, cur.observed_at, '通貨未確認');
    }
    if (!view && hasAmount(past)) {
      view = past.currency_verified ? reference(past, card.last_success_collected_at, past.observed_at, card.status === 'stale' ? '古い情報' : '更新失敗')
        : reference(past, card.last_success_collected_at, past.observed_at, '通貨未確認');
    }
    if (view) { rememberMimo(view.money, view.collectedAt, view.observedAt); return view; }
    return lastGood() || {kind: 'none', label: card.status === 'unconfirmed' ? '取得方法未確認' : card.status === 'fetch_failed' ? '取得失敗' : '未取得'};
  };
  const stamp = value => value ? new Date(value).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' JST' : '未提供';
  const shortStamp = value => {
    if(!value)return '時刻不明';
    const options={timeZone:'Asia/Tokyo'},date=new Date(value),today=new Date(Date.now());
    const day=date.toLocaleDateString('ja-JP',options)===today.toLocaleDateString('ja-JP',options)?'':date.toLocaleDateString('ja-JP',{...options,month:'numeric',day:'numeric'})+' ';
    return day+date.toLocaleTimeString('ja-JP',{...options,hour:'2-digit',minute:'2-digit'});
  };
  const applyTheme = () => {
    if(typeof getComputedStyle!=='function')return;
    const root=document.getElementById?.('root'),frame=root?.firstElementChild || document.body;
    const style=getComputedStyle(frame),text=getComputedStyle(root?.querySelector('h3,h1') || frame);
    panel.style.backgroundColor=style.backgroundColor;panel.style.color=text.color;panel.style.fontFamily=style.fontFamily;
    panel.style.borderBottomColor=root?.closest('.dark') || document.documentElement?.classList.contains('dark')?'#374151':'#e5e7eb';
  };
  const append = (parent, tag, text) => {const item = document.createElement(tag); item.textContent = text; parent.append(item); return item;};
  const rowName = row => row.shared_pool ? `${pools[row.shared_pool]} / ${row.period === 'weekly' ? '週間' : '短期5時間'}` : `${row.quota_scope === 'antigravity_shared' ? 'AG内部 ' : ''}${row.model_family} / ${row.period === 'weekly' ? '週間' : '短期5時間'}${row.window_id?.startsWith('g') ? ` (${row.window_id})` : ''}`;
  const currentRow = (card,row,now=Date.now()) => {
    const future=[card.collected_at,row.observed_at].some(value=>value && Date.parse(value)>now);
    const resetValid=row.reset_at && Date.parse(row.reset_at)>now && Date.parse(row.reset_at)-now<=(row.period==='five_hour'?18000:604800)*1000+300000;
    return !failed && !future && row.status==='available' && row.remaining_percent!==null && row.fresh_until && Date.parse(row.fresh_until)>=now && resetValid;
  };
  const render = () => {
    const restoreFocus=!!document.activeElement && document.activeElement===disclosure?.firstElementChild;
    detailsOpen=disclosure?.open ?? detailsOpen;
    panel.replaceChildren();
    applyTheme();
    if(!data || !Array.isArray(data.cards)) {append(panel,'p','残量データの読取失敗。'); return;}
    if(failed){const alert=append(panel,'p','更新失敗・前回値を表示中');alert.style.cssText='color:#ef4444;font-size:11px;font-weight:600;margin:0 0 4px 0';}
    const summaryGrid=document.createElement('div'); summaryGrid.style.cssText='display:flex;flex-wrap:wrap;gap:4px 10px;align-items:flex-start'; panel.append(summaryGrid);
    const details=document.createElement('details'); details.open=detailsOpen; disclosure=details;
    details.style.cssText='margin-top:4px;max-height:36vh;overflow:auto';
    details.addEventListener?.('toggle',()=>{if(disclosure===details)detailsOpen=details.open;});
    const toggle=append(details,'summary','残量の詳細（JST）');toggle.style.cssText='cursor:pointer;color:inherit;opacity:.75;font-size:11px';
    if(failed)append(details,'p','表示通信に失敗。最後の表示は過去の参考値です。');
    const resetGrid=document.createElement('div');resetGrid.style.cssText='display:flex;flex-wrap:wrap;gap:12px';details.append(resetGrid);
    const stateNames={available:'取得済み',stale:'古い取得値',fetch_failed:'取得失敗',missing:'未取得',not_reported:'未提供',ambiguous:'対応不明',awaiting_refresh:'再取得確認待ち'};
    const order=['codex','claude','antigravity','mimo'];
    const cards=[...data.cards];
    if(!cards.some(c=>c.provider==='mimo')){
      cards.push({provider:'mimo',status:'unconfirmed',account_alignment:'not_verified',collected_at:null,last_success_collected_at:null,balance:null,last_known_balance:null});
    }
    const orderedCards=[...cards].sort((a,b)=>{const ai=order.indexOf(a.provider),bi=order.indexOf(b.provider); return (ai===-1?99:ai)-(bi===-1?99:bi);});
    for(const card of orderedCards){
      if(card.provider==='mimo'){
        const section=document.createElement('section');section.style.cssText=cardStyle('#0284c7');summaryGrid.append(section);
        const heading=document.createElement('div');heading.style.cssText='display:flex;align-items:center;gap:6px;flex-wrap:wrap';section.append(heading);
        append(heading,'strong','MiMo API').style.cssText='color:inherit;font-family:inherit;font-size:12px';
        const rates=document.createElement('div');rates.style.cssText='display:flex;gap:12px;flex-wrap:wrap;font-size:13px;font-weight:600';section.append(rates);
        const expanded=document.createElement('section');expanded.style.cssText='flex:1 1 220px;min-width:0';resetGrid.append(expanded);
        const view=mimoView(card,Date.now());
        const shownCollected=view.kind==='none'?card.collected_at:view.collectedAt;
        append(expanded,'strong','MiMo API（従量課金残高）');append(expanded,'small',` ／ 採集 ${stamp(shownCollected)}`);
        const small=text=>append(heading,'small',text).style.cssText='color:inherit;opacity:.7;font-family:inherit;font-size:10px';
        if(view.kind==='none'){
          append(rates,'span','—');small(view.label);
          append(expanded,'div',`API残高：— ／ ${view.label}`);
        } else {
          const fmt=formatMimoMoney(view.money),debt=fmt.isDebt?'（残高不足）':'';
          const times=[view.kind==='current'?(view.collectedAt?`取得 ${shortStamp(view.collectedAt)}`:'取得 時刻不明'):(view.collectedAt?`${view.kind==='reference'?'参考':'採集'} ${shortStamp(view.collectedAt)}`:'参考 成功時刻不明')];
          if(view.observedAt && view.observedAt!==view.collectedAt)times.push(`観測 ${shortStamp(view.observedAt)}`);
          if(view.kind==='current'){
            append(rates,'span',`${fmt.text}${debt}`);small(times.join(' ／ '));
            append(expanded,'div',`API残高：${fmt.text}${debt} ／ 取得済み`);
          } else if(view.kind==='stale'){
            append(rates,'span',`${fmt.text}${debt} 参考`);small(`${times.join(' ／ ')}（古い情報）`);
            append(expanded,'div',`API残高：${fmt.text}${debt} ／ 古い取得値`);
          } else {
            append(rates,'span',`${fmt.text}${debt} 前回参考`);small(`${times.join(' ／ ')}（${view.label}）`);
            append(expanded,'div',`API残高：${fmt.text}${debt} ／ ${view.label}（前回参考値）`);
          }
        }
        continue;
      }
      for(const pool of card.provider==='antigravity'?['gemini_shared','claude_gpt_shared']:[null]){
      const colors={codex:'#2563eb',claude:'#c2410c',antigravity:'#7c3aed'},accent=colors[card.provider];
      const section=document.createElement('section');section.style.cssText=cardStyle(accent);summaryGrid.append(section);
      const label=pool==='gemini_shared'?'AG Gemini':pool==='claude_gpt_shared'?'AG Claude/GPT':card.provider==='claude'?'Claude':names[card.provider];
      const heading=document.createElement('div');heading.style.cssText='display:flex;align-items:center;gap:6px;flex-wrap:wrap';section.append(heading);
      append(heading,'strong',label).style.cssText='color:inherit;font-family:inherit;font-size:12px';
      const rates=document.createElement('div');rates.style.cssText='display:flex;gap:12px;flex-wrap:wrap;font-size:13px;font-weight:600';section.append(rates);
      const expanded=document.createElement('section');expanded.style.cssText='flex:1 1 220px;min-width:0';resetGrid.append(expanded);
      append(expanded,'strong',pool?pools[pool]:names[card.provider]);append(expanded,'small',` ／ 採集 ${stamp(card.collected_at)}`);
      let historical=false,hasCurrent=false;
      for(const period of ['five_hour','weekly']){
        const matches=card.current_rows.filter(row=>row.period===period && row.shared_pool===pool),row=matches.length===1?matches[0]:null;
        const contract=card.reset_windows?.find(window=>window.period===period && window.shared_pool===pool);
        const reset=contract?contract.resetAt:row?.status==='not_reported'||row?.reset_invalid?null:row?.reset_at;
        const now=Date.now(),delta=reset?Date.parse(reset)-now:null,valid=row && currentRow(card,row,now);
        const future=card.collected_at && Date.parse(card.collected_at)>now;
        const state=failed?'表示通信失敗':card.status==='fetch_failed'?'取得失敗':future?'時計不整合':row?.stale || (row?.fresh_until && Date.parse(row.fresh_until)<now)?'古い取得値':delta!==null && delta<=0?'再取得確認待ち':valid?'取得済み':stateNames[contract?.state] || (row?.status==='not_reported'?'未提供':'未取得');
        const seconds=delta===null?null:Math.max(0,Math.ceil(delta/1000));
        const countdown=seconds===null?'未提供':seconds===0?'0秒・再取得確認待ち':`${Math.floor(seconds/86400)}日 ${Math.floor(seconds%86400/3600)}時間 ${Math.floor(seconds%3600/60)}分 ${seconds%60}秒`;
        const past=card.last_known_rows.filter(item=>item.period===period && item.shared_pool===pool),reference=!valid && past.length===1 && past[0].remaining_percent!==null;
        historical ||= reference;
        hasCurrent ||= valid;
        const value=valid?row.remaining_percent:reference?past[0].remaining_percent:null;
        const rate=append(rates,'span',`${period==='five_hour'?'5h':'週'} ${value===null?'—':`${Number(value.toFixed(1))}%`}${reference?' 参考':''}`);
        rate.setAttribute('aria-label',`${period==='five_hour'?'5時間':'週間'} ${value===null?'現在値不明':reference?'過去の参考値':'採集時点の残率'} ${value===null?'':value+'%'}`);
        append(expanded,'div',`${period==='five_hour'?'5時間':'週間'}：${valid?`残り${Number(row.remaining_percent.toFixed(2))}%`:'—'} ／ ${state}`);
        if(reference)append(expanded,'small',`前回参考 ${Number(past[0].remaining_percent.toFixed(2))}%（現在値ではありません）／ 採集 ${stamp(card.last_success_collected_at)}`);
        append(expanded,'div',`報告reset：${stamp(reset)} ／ 残り ${countdown}${!valid && reset?'（記録値）':''}`);
      }
      if(pool==='gemini_shared'){
        // Gemini 4 Argon weekly is its own window: never folded into the Gemini shared 5h/weekly values above.
        const now=Date.now(),a=card.argon_weekly,past=card.last_known_argon_weekly;
        const future=card.collected_at && Date.parse(card.collected_at)>now;
        const live=!!a && !failed && !future && a.status==='available' && a.remaining_percent!==null && a.fresh_until && Date.parse(a.fresh_until)>=now && (!a.reset_at || Date.parse(a.reset_at)>now);
        const ref=!live ? [a,past].find(item=>item && item.remaining_percent!==null && item.limit_id) : null;
        const shown=live?a:ref;
        const rate=append(rates,'span',`Argon週 ${shown?`${Number(shown.remaining_percent.toFixed(1))}%`:'—'}${ref?' 参考':shown?'':'（未確認）'}`);
        rate.setAttribute('data-limit','gemini_4_argon_weekly');
        rate.setAttribute('aria-label',`Gemini 4 Argon 週間 ${shown?(live?'採集時点の残率 ':'過去の参考値 ')+shown.remaining_percent+'%':'未確認'}`);
        const basis=a?.percent_basis||past?.percent_basis;
        const state=failed?'表示通信失敗':!a&&!past?'入力なし（未確認）':a&&a.status==='basis_unconfirmed'?'残率/使用率の別が未確認':live?'取得済み':a?.reset_passed||(a?.reset_at&&Date.parse(a.reset_at)<=now)?'再取得確認待ち':a?.stale||(a?.fresh_until&&Date.parse(a.fresh_until)<now)?'古い取得値':future?'時計不整合':'未取得';
        append(expanded,'div',`Gemini 4 Argon 週間（共有枠とは別）：${live?`残り${Number(a.remaining_percent.toFixed(2))}%（使用${Number(a.used_percent.toFixed(2))}%）`:'—'} ／ ${state}`);
        if(ref)append(expanded,'small',`前回参考 ${Number(ref.remaining_percent.toFixed(2))}%（現在値ではありません）／ 観測 ${stamp(ref.observed_at)}`);
        const cause=a||past;
        if(cause?.reset_approximate){
          // "Resets in N" has no confirmed rounding rule: show it as an approximate hint, never as a deadline or countdown.
          const days=cause.reset_relative_seconds/86400,approx=days>=1?`${Number(days.toFixed(1))}日`:`${Number((cause.reset_relative_seconds/3600).toFixed(1))}時間`;
          append(expanded,'div',`Argon reset：約${approx}後と表示（概算・精度未確認）／ 観測 ${stamp(cause.observed_at)} ／ 確定時刻なし`);
        } else if(cause?.reset_at){
          const delta=Date.parse(cause.reset_at)-now,seconds=Math.max(0,Math.ceil(delta/1000));
          const rest=seconds===0?'0秒・再取得確認待ち':`${Math.floor(seconds/86400)}日 ${Math.floor(seconds%86400/3600)}時間`;
          append(expanded,'div',`Argon reset：${stamp(cause.reset_at)} ／ 残り ${rest}${live?'':'（記録値）'}`);
        } else append(expanded,'div','Argon reset：未提供');
        if(basis)append(expanded,'small',`百分率の基準：${basis==='remaining'?'残率':'使用率から換算'}`);
      }
      const acquiredAt=card.reset_windows?.find(window=>window.shared_pool===pool)?.collectedAt ?? card.collected_at;
      const times=[];if(hasCurrent)times.push(`取得 ${shortStamp(acquiredAt)}`);if(historical)times.push(`参考 ${shortStamp(card.last_success_collected_at)}`);
      if(!times.length)times.push(card.status==='fetch_failed'?'取得失敗':'未取得');
      append(heading,'small',times.join(' ／ ')).style.cssText='color:inherit;opacity:.7;font-family:inherit;font-size:10px';
    }}
    append(details,'p','残率は採集時点の値です。参考値は現在値ではありません。resetは報告予定時刻で、0秒は回復未確認。5時間枠と週間枠を併せて確認してください。');
    panel.append(details);if(restoreFocus)toggle.focus?.({preventScroll:true});

    const grid = document.createElement('div'); grid.style.cssText='display:flex;flex-wrap:wrap;gap:16px'; details.append(grid);
    for(const card of cards) {
      const block=document.createElement('section'); block.style.cssText='flex:1;min-width:220px'; grid.append(block);
      if(card.provider==='mimo'){
        append(block,'strong','MiMo API');
        append(block,'p',card.status==='unconfirmed'?'残高照会API：未確認（推測接続なし）':card.status==='available'?'採集成功':card.status==='fetch_failed'?'取得失敗':'現在値なし');
        append(block,'p',`GUI/ACPアカウント一致：${card.account_alignment==='verified'?'確認済み':card.account_alignment==='mismatch'?'不一致（旧残高破棄）':'未照合'}`);
        append(block,'p',`採集：${stamp(card.collected_at)} ／最終成功：${stamp(card.last_success_collected_at)}`);
        append(block,'strong','現在欄（採集時点）');
        if(card.balance && typeof card.balance.amount==='number'){
          const fmt=formatMimoMoney(card.balance);
          append(block,'p',`API残高：${fmt.text}${fmt.isDebt?'（残高不足）':''} ／観測：${stamp(card.balance.observed_at)}${card.balance.stale?'（古い情報）':''}`);
        } else {
          append(block,'p',card.status==='unconfirmed'?'取得方法未確認':'欠測');
        }
        append(block,'strong',`前回参考（現在値ではありません）：${stamp(card.last_success_collected_at)}`);
        if(card.last_known_balance && typeof card.last_known_balance.amount==='number'){
          const fmt=formatMimoMoney(card.last_known_balance);
          append(block,'p',`前回残高：${fmt.text}${fmt.isDebt?'（残高不足）':''} ／観測：${stamp(card.last_known_balance.observed_at)}`);
        } else {
          append(block,'p','なし');
        }
        continue;
      }
      append(block,'strong',names[card.provider]);
      append(block,'p',card.error_kind ? errors[card.error_kind] || '取得失敗' : card.status === 'partial' ? '一部未報告' : card.status === 'available' ? '採集成功' : '現在値なし');
      append(block,'p',`GUI/ACPアカウント一致：${card.account_alignment === 'verified' ? '確認済み' : card.account_alignment === 'mismatch' ? '不一致' : '未照合'}`);
      append(block,'p',`採集：${stamp(card.collected_at)} ／CLI snapshot生成：${stamp(card.snapshot_updated_at)} ／provider更新：${stamp(card.provider_updated_at)}`);
      append(block,'p',`試行開始：${stamp(card.attempt_started_at)} ／終了：${stamp(card.attempt_finished_at)} ／再試行可能：${stamp(card.retry_not_before)}`);
      append(block,'strong','現在欄（採集時点）');
      if(!card.current_rows.length) append(block,'p','欠測');
      for(const row of card.current_rows) {
        const now=Date.now();
        const future=[card.collected_at,row.observed_at].some(value=>value && Date.parse(value)>now);
        const resetValid=row.reset_at && Date.parse(row.reset_at)>now && Date.parse(row.reset_at)-now<=(row.period==='five_hour'?18000:604800)*1000+300000;
        const current=currentRow(card,row,now);
        const reason=row.status==='not_reported' ? '未報告' : future ? '時計ずれ・欠測' : row.reset_passed || (row.reset_at && Date.parse(row.reset_at)<=now) ? 'reset経過・欠測' : !resetValid ? 'reset不明・欠測' : '古い値または取得失敗';
        append(block,'p',`${rowName(row)}：${current ? `残${row.remaining_percent}%` : `— (${reason})`} ／reset：${stamp(row.reset_at)}`);
      }
      append(block,'strong',`前回参考（現在値ではありません）：${stamp(card.last_success_collected_at)}`);
      if(!card.last_known_rows.length) append(block,'p','なし');
      for(const row of card.last_known_rows) append(block,'p',`${rowName(row)}：${row.remaining_percent === null ? '—' : `前回残${row.remaining_percent}%`} ／観測：${stamp(row.observed_at)}${row.stale || (row.fresh_until && Date.parse(row.fresh_until)<=Date.now()) ? '（古い）' : ''}${row.reset_at && Date.parse(row.reset_at)<=Date.now() ? '（reset経過）' : ''}`);
      if(card.provider==='antigravity') {
        append(block,'strong','モデル（共有枠への参照・個別残量未提供）');
        if(!card.model_references?.length) append(block,'p','モデル参照metadataは未提供です。');
        for(const reference of card.model_references??[]) {
          const available=card.current_rows.some(row=>row.shared_pool===reference.shared_pool && reference.shared_window_ids.includes(row.window_id) && currentRow(card,row));
          append(block,'p',`${reference.official_name}：${reference.shared_pool ? 'Claude / GPT共有枠の参照' : '共有対応未確認'}。個別使用率・残率・resetは未提供。${available ? '共有値は上の共有欄を参照。' : '共有枠の現在値も未取得。'}`);
          append(block,'small',`カタログ確認履歴：${stamp(reference.catalog_observed_at)}（quota取得時刻・実利用資格ではありません）`);
        }
        append(block,'p',`${card.model_references?.some(reference=>reference.pool_mapping_source==='official_models_documentation') ? '共有対応は公式Models資料に基づきます。' : '共有対応の確認metadataは未提供です。'}CLIのモデル→pool所属表・GUIアカウント一致・実利用資格は未確認です。3モデルの残量を合算しません。`);
      }
    }
  };
  const refresh = async () => {
    try {
      const response=await fetch('/__dashboard/usage',{cache:'no-store'});
      if(!response.ok) throw new Error('Unavailable');
      const next=await response.json();
      if(!next || !Array.isArray(next.cards)) throw new Error('Invalid usage payload');
      data=next;
      failed=false;
    } catch {
      failed=true;
    }
    render();
  };
  const start=()=>{document.body.prepend(panel); refresh(); setInterval(refresh,30000); setInterval(render,1000);};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
