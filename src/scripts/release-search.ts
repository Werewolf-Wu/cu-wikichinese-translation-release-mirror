function initializeReleaseSearch(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>('[data-release-search]');
  const input = root.querySelector<HTMLInputElement>('[data-release-query]');
  const groups = root.querySelector<HTMLElement>('[data-release-groups]');
  const results = root.querySelector<HTMLElement>('[data-release-results]');
  const list = root.querySelector<HTMLElement>('[data-release-results-list]');
  const status = root.querySelector<HTMLElement>('[data-release-search-status]');
  const empty = root.querySelector<HTMLElement>('[data-release-no-results]');
  const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-search-card]'));
  if (!form || !input || !groups || !results || !list || !status || !empty) return;

  const normalize = (text: string): string => text.normalize('NFKC').toLocaleLowerCase('zh-CN');
  const update = (): void => {
    const query = normalize(input.value.trim());
    const searching = query.length > 0;
    let count = 0;
    for (const card of cards) {
      const matches = !searching || (card.dataset.searchText ?? '').includes(query);
      card.hidden = !matches;
      if (matches) count++;
    }
    // Keeping the history element mounted preserves its previous open state.
    groups.hidden = searching;
    results.hidden = !searching;
    empty.hidden = !searching || count > 0;
    const scroll = searching && count > 10;
    list.classList.toggle('scroll-list', scroll);
    if (scroll) {
      list.tabIndex = 0;
      list.setAttribute('role', 'region');
      list.setAttribute('aria-label', '版本搜索结果，可滚动');
    } else {
      list.removeAttribute('tabindex');
      list.removeAttribute('role');
      list.removeAttribute('aria-label');
    }
    status.textContent = searching ? (count > 0 ? `找到 ${count} 个版本。` : '没有找到匹配的版本。') : '';
  };

  form.addEventListener('submit', (event) => event.preventDefault());
  input.addEventListener('input', update);
  form.addEventListener('reset', (event) => {
    event.preventDefault();
    input.value = '';
    update();
    input.focus();
  });
  input.disabled = false;
  form.hidden = false;
  update();
}

document.querySelectorAll<HTMLElement>('[data-release-browser]').forEach(initializeReleaseSearch);
