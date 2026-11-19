function bindBinanceBook(button, getSymbol) {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'binance-book-title');
  dialog.style.cssText = 'width:min(390px,calc(100% - 24px));max-height:85dvh;padding:14px;border:1px solid #555;border-radius:8px;background:#171717;color:#eee;font:13px system-ui;box-sizing:border-box';
  dialog.innerHTML = `
    <form method="dialog" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <strong id="binance-book-title">Binance à vista</strong>
      <button type="submit" autofocus>Fechar</button>
    </form>
    <p>10 melhores preços de cada lado · valores em USDT</p>
    <table style="width:100%;text-align:right;font-variant-numeric:tabular-nums">
      <thead><tr><th colspan="2" style="color:#81d5b3">Compras</th><th colspan="2" style="color:#ffa2a2">Vendas</th></tr>
      <tr><th>Preço</th><th>Valor</th><th>Preço</th><th>Valor</th></tr></thead>
      <tbody></tbody>
      <tfoot><tr><th>Total</th><td></td><th>Total</th><td></td></tr></tfoot>
    </table>
    <p role="status" style="margin-bottom:0"></p>`;
  button.parentElement.append(dialog);
  const body = dialog.querySelector('tbody');
  const totals = dialog.querySelectorAll('tfoot td');
  const title = dialog.querySelector('strong');
  const status = dialog.querySelector('[role="status"]');
  const price = new Intl.NumberFormat('pt-BR', {maximumFractionDigits:8});
  const value = new Intl.NumberFormat('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  let activeRequest;
  let timer;

  function clearBook() {
    body.replaceChildren();
    for (const cell of totals) cell.textContent = '—';
  }

  async function refresh(symbol) {
    const request = new AbortController();
    activeRequest = request;
    const timeout = setTimeout(() => request.abort(), 6000);
    try {
      const url = new URL('https://data-api.binance.vision/api/v3/depth');
      url.search = new URLSearchParams({symbol, limit:10});
      const response = await fetch(url, {signal:request.signal, cache:'no-store'});
      if (!response.ok) throw new Error('Livro indisponível');
      const {bids, asks} = await response.json();
      if (![bids, asks].every(side => Array.isArray(side) && side.length && side.every(level =>
        Array.isArray(level) && [+level[0], +level[1]].every(n => Number.isFinite(n) && n > 0)))) {
        throw new Error('Livro inválido');
      }
      if (activeRequest !== request || !dialog.open) return;
      clearBook();
      for (let i = 0; i < Math.max(bids.length, asks.length); i++) {
        const row = body.insertRow();
        for (const level of [bids[i], asks[i]]) {
          row.insertCell().textContent = level ? price.format(+level[0]) : '—';
          row.insertCell().textContent = level ? value.format(level[0] * level[1]) : '—';
        }
      }
      for (const [i, side] of [bids, asks].entries()) {
        totals[i].textContent = value.format(side.reduce((sum, [p, q]) => sum + p * q, 0));
      }
      status.textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', {timeZone:'Asia/Tokyo'}) + ' JST';
    } catch {
      if (activeRequest !== request || !dialog.open) return;
      clearBook();
      status.textContent = 'Livro indisponível. Nova tentativa em instantes.';
    } finally {
      clearTimeout(timeout);
      if (activeRequest === request && dialog.open) timer = setTimeout(() => refresh(symbol), 10000);
    }
  }

  button.addEventListener('click', () => {
    const symbol = getSymbol();
    title.textContent = symbol + ' · Binance à vista';
    clearBook();
    dialog.showModal();
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
      status.textContent = 'Selecione um par USDT para abrir o livro.';
      return;
    }
    status.textContent = 'Carregando ofertas…';
    refresh(symbol);
  });
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    activeRequest?.abort();
    activeRequest = undefined;
  });
}
