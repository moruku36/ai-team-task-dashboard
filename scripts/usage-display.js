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
    if (!item.currency_verified && (!item.currency || !ISO_CURRENCIES.has(item.currency))) {
      return { text: '通貨未確認', isNegative: false, isDebt: false, valid: false, unconfirmedCurrency: true };
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
      const intPart = parts[0];
      const fracPart = (parts[1] || '').padEnd(2, '0');
      numStr = (isNegative ? '-' : '') + intPart + '.' + fracPart;
    }
    return {
      text: `${item.currency} ${numStr}`,
      isNegative,
      isDebt: isNegative,
      valid: true
    };
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
    const summaryGrid=document.createElement('div'); summaryGrid.style.cssText='display:flex;flex-wrap:wrap;gap:6px'; panel.append(summaryGrid);
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
        const colors={codex:'#2563eb',claude:'#c2410c',antigravity:'#7c3aed',mimo:'#0284c7'},accent=colors[card.provider];
        const section=document.createElement('section');section.style.cssText=`flex:1 1 190px;min-width:0;border-left:3px solid ${accent};border-radius:4px;padding:4px 8px;background:transparent;color:inherit`;summaryGrid.append(section);
        const heading=document.createElement('div');heading.style.cssText='display:flex;align-items:center;gap:6px;flex-wrap:wrap';section.append(heading);
        append(heading,'strong','MiMo API').style.cssText='color:inherit;font-family:inherit;font-size:12px';
        const rates=document.createElement('div');rates.style.cssText='display:flex;gap:12px;flex-wrap:wrap;font-size:13px;font-weight:600';section.append(rates);
        const expanded=document.createElement('section');expanded.style.cssText='flex:1 1 220px;min-width:0';resetGrid.append(expanded);
        append(expanded,'strong','MiMo API（従量課金残高）');append(expanded,'small',` ／ 採集 ${stamp(card.collected_at)}`);

        const cur=card.balance,past=card.last_known_balance;
        const now=Date.now();
        const future=card.collected_at && Date.parse(card.collected_at)>now;
        const curHasMoney=cur && typeof cur.amount==='number' && cur.currency_verified;
        const pastHasMoney=past && typeof past.amount==='number' && past.currency_verified;
        const isFresh=curHasMoney && !cur.stale && (!cur.fresh_until || Date.parse(cur.fresh_until)>=now) && card.status==='available' && !future;
        const isStale=curHasMoney && (cur.stale || (cur.fresh_until && Date.parse(cur.fresh_until)<now) || card.status==='stale');
        const isLastKnown=!isFresh && !isStale && pastHasMoney;

        if(isFresh){
          const fmt=formatMimoMoney(cur);
          const debt=fmt.isDebt?'（残高不足）':'';
          append(rates,'span',`${fmt.text}${debt}`);
          const times=[];
          times.push(card.collected_at ? `取得 ${shortStamp(card.collected_at)}` : '取得 時刻不明');
          if(cur.observed_at && cur.observed_at !== card.collected_at) times.push(`観測 ${shortStamp(cur.observed_at)}`);
          append(heading,'small',times.join(' ／ ')).style.cssText='color:inherit;opacity:.7;font-family:inherit;font-size:10px';
          append(expanded,'div',`API残高：${fmt.text}${debt} ／ 取得済み`);
        } else if(isStale){
          const fmt=formatMimoMoney(cur);
          const debt=fmt.isDebt?'（残高不足）':'';
          append(rates,'span',`${fmt.text}${debt} 参考`);
          const times=[];
          times.push(card.collected_at ? `採集 ${shortStamp(card.collected_at)}` : '採集 時刻不明');
          if(cur.observed_at && cur.observed_at !== card.collected_at) times.push(`観測 ${shortStamp(cur.observed_at)}`);
          append(heading,'small',`${times.join(' ／ ')}（古い情報）`).style.cssText='color:inherit;opacity:.7;font-family:inherit;font-size:10px';
          append(expanded,'div',`API残高：${fmt.text}${debt} ／ 古い取得値`);
        } else if(isLastKnown){
          const fmt=formatMimoMoney(past);
          const debt=fmt.isDebt?'（残高不足）':'';
          const lastLabel=card.status==='stale'?'古い情報':'更新失敗';
          append(rates,'span',`${fmt.text}${debt} 前回参考`);
          const times=[];
          times.push(card.last_success_collected_at ? `参考 ${shortStamp(card.last_success_collected_at)}` : '参考 成功時刻不明');
          if(past.observed_at && past.observed_at !== card.last_success_collected_at) times.push(`観測 ${shortStamp(past.observed_at)}`);
          append(heading,'small',`${times.join(' ／ ')}（${lastLabel}）`).style.cssText='color:inherit;opacity:.7;font-family:inherit;font-size:10px';
          append(expanded,'div',`API残高：${fmt.text}${debt} ／ ${lastLabel}（前回参考値）`);
        } else {
          const isCurrencyUnconfirmed=(cur && typeof cur.amount==='number' && !cur.currency_verified) ||
                                       (!cur && past && typeof past.amount==='number' && !past.currency_verified);
          const isUnconfirmed=card.status==='unconfirmed';
          const label=isCurrencyUnconfirmed?'通貨未確認':isUnconfirmed?'取得方法未確認':card.status==='fetch_failed'?'取得失敗':'未取得';
          append(rates,'span',isCurrencyUnconfirmed?'通貨未確認':'—');
          append(heading,'small',label).style.cssText='color:inherit;opacity:.7;font-family:inherit;font-size:10px';
          append(expanded,'div',`API残高：— ／ ${label}`);
        }
        continue;
      }
      for(const pool of card.provider==='antigravity'?['gemini_shared','claude_gpt_shared']:[null]){
      const colors={codex:'#2563eb',claude:'#c2410c',antigravity:'#7c3aed'},accent=colors[card.provider];
      const section=document.createElement('section');section.style.cssText=`flex:1 1 190px;min-width:0;border-left:3px solid ${accent};border-radius:4px;padding:4px 8px;background:transparent;color:inherit`;summaryGrid.append(section);
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
