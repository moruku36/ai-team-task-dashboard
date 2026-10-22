/* Display adapter for the official Backlog.md v1.53.0 UI. No task/config writes. */
(() => {
  // The board shows four columns (To Do / In Progress / Blocked / Done). Cards that still carry a legacy status are NOT
  // dropped, auto-completed or re-saved: their own legacy column is hidden by CSS and each card is mirrored into the
  // column it is read as, with a badge naming the saved legacy status. The mirror is a display-only proxy; clicking it
  // clicks the real (hidden) card, so details, search and re-renders keep working. Saved data is never touched.
  const label = '旧「最終確認」（要確認）';
  const explanation = '旧状態です。完了とは限りません。実態を確認し、To Do / In Progress / Blocked / Done のいずれかへ移してください';
  const legacy = {
    'Verifying': {target: 'In Progress', badge: '旧「最終確認」'},
    'Awaiting Approval': {target: 'Blocked', badge: '旧「承認待ち」'}
  };
  const css = `
    [data-dashboard-legacy-column]{display:none!important}
    [data-dashboard-legacy-proxies]{display:flex;flex-direction:column;gap:.5rem;margin-top:.5rem}
    .dashboard-legacy-proxy{font:inherit;text-align:left;color:inherit;cursor:pointer;border:1px dashed currentColor;border-color:color-mix(in srgb,currentColor 45%,transparent);background:color-mix(in srgb,currentColor 6%,transparent);border-radius:.5rem;padding:.5rem .6rem;display:flex;flex-direction:column;gap:.25rem}
    .dashboard-legacy-proxy:hover,.dashboard-legacy-proxy:focus-visible{background:color-mix(in srgb,currentColor 14%,transparent);outline:2px solid currentColor;outline-offset:1px}
    .dashboard-legacy-proxy .dashboard-legacy-badge{align-self:flex-start;font-size:.6875rem;font-weight:700;padding:.05rem .45rem;border-radius:9999px;border:1px solid currentColor}
    .dashboard-legacy-proxy .dashboard-legacy-text{font-size:.8125rem;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere}`;
  const cardSelector = '[aria-label^="Open "]';
  const columnOf = heading => heading.closest('div.flex-1');
  const mirrorLegacy = () => {
    if (!document.getElementById('dashboard-legacy-style')) {
      const style = document.createElement('style'); style.id = 'dashboard-legacy-style'; style.textContent = css; document.head.append(style);
    }
    const headings = [...document.querySelectorAll('.flex.items-center.justify-between.mb-4 h3')];
    const byText = new Map(headings.map(h => [h.textContent.trim(), h]));
    const wanted = new Map();
    for (const [status, rule] of Object.entries(legacy)) {
      const heading = byText.get(status) ?? (status === 'Verifying' ? byText.get(label) : undefined);
      const column = heading && columnOf(heading);
      if (!column) continue;
      // Hide unconditionally: an empty (or still loading) board must not bring the legacy columns back.
      if (!column.hasAttribute('data-dashboard-legacy-column')) column.setAttribute('data-dashboard-legacy-column', '');
      for (const card of column.querySelectorAll(cardSelector)) {
        if (!wanted.has(rule.target)) wanted.set(rule.target, []);
        wanted.get(rule.target).push({card, badge: rule.badge});
      }
    }
    for (const target of new Set(Object.values(legacy).map(rule => rule.target))) {
      const heading = byText.get(target), column = heading && columnOf(heading);
      if (!column) continue;
      let holder = column.querySelector(':scope>[data-dashboard-legacy-proxies]');
      const entries = wanted.get(target) ?? [];
      if (!entries.length) { holder?.remove(); continue; }
      if (!holder) { holder = document.createElement('div'); holder.setAttribute('data-dashboard-legacy-proxies', ''); column.append(holder); }
      // Rebuild only when the mirrored set or its text changed, so the observer does not loop on its own writes.
      const signature = entries.map(({card, badge}) => `${badge}|${(card.textContent || '').trim()}`).join('\n');
      if (holder.dataset.signature === signature) continue;
      holder.dataset.signature = signature;
      holder.replaceChildren(...entries.map(({card, badge}) => {
        const proxy = document.createElement('button'); proxy.type = 'button'; proxy.className = 'dashboard-legacy-proxy';
        proxy.setAttribute('aria-label', `${badge}から表示: ${(card.textContent || '').trim().slice(0, 80)}`);
        const tag = document.createElement('span'); tag.className = 'dashboard-legacy-badge'; tag.textContent = `${badge}から表示（要確認）`;
        const text = document.createElement('span'); text.className = 'dashboard-legacy-text'; text.textContent = (card.textContent || '').trim();
        proxy.append(tag, text);
        proxy.addEventListener('click', () => card.click());
        return proxy;
      }));
    }
  };
  const selector = '.flex.items-center.justify-between.mb-4 h3, option[value="Verifying"], span.rounded-circle, span.shrink-0.rounded-md';
  const refresh = () => {
    mirrorLegacy();
    for (const element of document.querySelectorAll(selector)) {
      // Only a sole status text node; never rewrite task titles, prose or form values.
      if (element.childNodes.length !== 1 || element.firstChild.nodeType !== 3) continue;
      const text = element.firstChild;
      if (text.data.trim() === 'Verifying') {
        text.data = text.data.replace('Verifying', label);
        element.dataset.dashboardStatusLabel = 'Verifying';
        element.setAttribute('title', explanation);
        element.setAttribute('aria-label', label);
      } else if (element.dataset.dashboardStatusLabel && text.data.trim() !== label) {
        delete element.dataset.dashboardStatusLabel;
        element.removeAttribute('title');
        element.removeAttribute('aria-label');
      }
    }
  };
  const start = () => {
    refresh();
    new MutationObserver(refresh).observe(document.body, {childList: true, subtree: true, characterData: true});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
