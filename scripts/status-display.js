/* Display adapter for the official Backlog.md v1.53.0 UI. No task/config writes. */
(() => {
  const label = '最終確認';
  const explanation = '作業はできていて、動作や成果物を点検中。確認が済んだら完了へ';
  // Display-only fold of the "Awaiting Approval" board column. Tasks, statuses and saved data are never touched:
  // the column's own markup stays in the DOM (hidden by CSS) so search, detail views and re-renders still work.
  const foldStatus = 'Awaiting Approval';
  let foldOpen = false;
  try {foldOpen = sessionStorage.getItem('dashboard-fold-awaiting') === 'open';} catch {}
  const foldCss = `
    [data-dashboard-fold="empty"]{display:none!important}
    [data-dashboard-fold="collapsed"]{flex:0 0 3.5rem!important;min-width:3.5rem!important;position:relative}
    [data-dashboard-fold="collapsed"]>:not([data-dashboard-fold-control]){display:none!important}
    [data-dashboard-fold="open"]{position:relative}
    [data-dashboard-fold-control]{font:inherit;color:#374151;cursor:pointer;border:1px solid currentColor;border-color:color-mix(in srgb,currentColor 30%,transparent);background:color-mix(in srgb,currentColor 7%,transparent);border-radius:.5rem;white-space:nowrap}
    .dark [data-dashboard-fold-control]{color:#e5e7eb}
    [data-dashboard-fold-control]:hover,[data-dashboard-fold-control]:focus-visible{background:color-mix(in srgb,currentColor 16%,transparent);outline:2px solid currentColor;outline-offset:1px}
    [data-dashboard-fold="collapsed"]>[data-dashboard-fold-control]{display:flex;flex-direction:column;align-items:center;gap:.75rem;width:100%;min-height:10rem;padding:.75rem .25rem;font-size:.8125rem;font-weight:600;line-height:1.2}
    [data-dashboard-fold-control] .dashboard-fold-count{order:-1;font-size:.875rem;font-weight:700;padding:.1rem .45rem;border-radius:9999px;background:color-mix(in srgb,currentColor 16%,transparent);writing-mode:horizontal-tb}
    [data-dashboard-fold-control] .dashboard-fold-label{writing-mode:vertical-rl;text-orientation:upright;letter-spacing:.2em}
    [data-dashboard-fold="open"]>[data-dashboard-fold-control]{position:absolute;top:.8rem;right:1rem;z-index:1;padding:.1rem .5rem;font-size:.6875rem}`;
  const foldColumn = () => {
    if (!document.getElementById('dashboard-fold-style')) {
      const style = document.createElement('style'); style.id = 'dashboard-fold-style'; style.textContent = foldCss; document.head.append(style);
    }
    const boardLoaded = !!document.querySelector('[aria-label^="Open "]');
    for (const heading of document.querySelectorAll('.flex.items-center.justify-between.mb-4 h3')) {
      if (heading.textContent.trim() !== foldStatus) continue;
      const column = heading.closest('div.flex-1');
      if (!column) continue;
      const count = column.querySelectorAll('[aria-label^="Open "]').length;
      const mode = boardLoaded && count === 0 ? 'empty' : foldOpen || !boardLoaded ? 'open' : 'collapsed';
      if (column.dataset.dashboardFold !== mode) column.dataset.dashboardFold = mode;
      let control = column.querySelector(':scope>[data-dashboard-fold-control]');
      if (!control) {
        control = document.createElement('button'); control.type = 'button'; control.setAttribute('data-dashboard-fold-control', '');
        control.addEventListener('click', () => {
          foldOpen = !foldOpen;
          try {sessionStorage.setItem('dashboard-fold-awaiting', foldOpen ? 'open' : 'closed');} catch {}
          refresh();
        });
        column.append(control);
      }
      // Collapsed rail: horizontal count pill on top, upright vertical label below (no rotated glyphs overlapping).
      const signature = `${mode}:${count}`;
      if (control.dataset.foldSignature !== signature) {
        control.dataset.foldSignature = signature;
        if (mode === 'collapsed') {
          const label = document.createElement('span'); label.className = 'dashboard-fold-label'; label.textContent = '承認待ち';
          const number = document.createElement('span'); number.className = 'dashboard-fold-count'; number.textContent = `${count}件`;
          control.replaceChildren(label, document.createTextNode(' '), number);
        } else control.textContent = `承認待ち ${count}件を折り畳む`;
      }
      const expanded = String(mode !== 'collapsed');
      if (control.getAttribute('aria-expanded') !== expanded) control.setAttribute('aria-expanded', expanded);
      const aria = mode === 'collapsed' ? `承認待ち ${count}件を表示する` : `承認待ち ${count}件の列を折り畳む`;
      if (control.getAttribute('aria-label') !== aria) control.setAttribute('aria-label', aria);
      control.hidden = mode === 'empty' || !boardLoaded;
    }
  };
  const selector = '.flex.items-center.justify-between.mb-4 h3, option[value="Verifying"], span.rounded-circle, span.shrink-0.rounded-md';
  const refresh = () => {
    foldColumn();
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
