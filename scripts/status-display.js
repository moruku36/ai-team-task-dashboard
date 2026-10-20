/* Display adapter for the official Backlog.md v1.53.0 UI. No task/config writes. */
(() => {
  const label = '最終確認';
  const explanation = '作業はできていて、動作や成果物を点検中。確認が済んだら完了へ';
  const selector = '.flex.items-center.justify-between.mb-4 h3, option[value="Verifying"], span.rounded-circle, span.shrink-0.rounded-md';
  const refresh = () => {
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
