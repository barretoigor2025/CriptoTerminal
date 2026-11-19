const coinbaseExchange = 'https://api.exchange.coinbase.com/products/';

function coinbaseProduct(symbol) {
  return symbol.replace(/USDT$/, '') + '-USD';
}

async function getExchangeBook(venue, symbol, signal, limit) {
  const url = venue === 'coinbase'
    ? coinbaseExchange + encodeURIComponent(coinbaseProduct(symbol)) + '/book?level=2'
    : 'https://data-api.binance.vision/api/v3/depth?' + new URLSearchParams({symbol, limit});
  const response = await fetch(url, {signal:AbortSignal.any([signal, AbortSignal.timeout(8000)]), cache:'no-store'});
  if (!response.ok) throw Object.assign(new Error('Livro indisponível'), {status:response.status});
  const book = await response.json();
  const normalize = side => {
    if (!Array.isArray(side)) throw new Error('Livro inválido');
    const levels = side.slice(0, limit).map(([p, q]) => [+p, +q]);
    if (!levels.length || !levels.every(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)) {
      throw new Error('Livro inválido');
    }
    return levels;
  };
  return {bids:normalize(book.bids), asks:normalize(book.asks)};
}

function bindExchangeBook(button, getSymbol, getVenue = () => null) {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'exchange-book-title');
  dialog.style.cssText = 'width:min(390px,calc(100% - 24px));max-height:85dvh;padding:14px;border:1px solid #555;border-radius:8px;background:#171717;color:#eee;font:13px system-ui;box-sizing:border-box';
  dialog.innerHTML = `
    <form method="dialog" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <strong id="exchange-book-title">Livro de ofertas</strong>
      <button type="submit" autofocus>Fechar</button>
    </form>
    <p><label>Corretora <select aria-label="Corretora do livro"><option value="binance">Binance</option><option value="coinbase">Coinbase</option></select></label></p>
    <p data-unit></p>
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
  const venueSelect = dialog.querySelector('select');
  const unitLabel = dialog.querySelector('[data-unit]');
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
    const venue = venueSelect.value;
    try {
      const {bids, asks} = await getExchangeBook(venue, symbol, request.signal, 10);
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
    } catch (error) {
      if (activeRequest !== request || !dialog.open) return;
      clearBook();
      status.textContent = error.status === 404 ? 'Par indisponível nesta corretora.' : 'Livro indisponível. Nova tentativa em instantes.';
      if (error.status === 404) activeRequest = undefined;
    } finally {
      if (activeRequest === request && dialog.open) timer = setTimeout(() => refresh(symbol), 10000);
    }
  }

  function loadBook() {
    clearTimeout(timer);
    activeRequest?.abort();
    activeRequest = undefined;
    const symbol = getSymbol();
    const coinbase = venueSelect.value === 'coinbase';
    const pair = coinbase ? coinbaseProduct(symbol) : symbol;
    title.textContent = pair + (coinbase ? ' · Coinbase à vista' : ' · Binance à vista');
    unitLabel.textContent = '10 melhores preços de cada lado · valores em ' + (coinbase ? 'USD' : 'USDT');
    clearBook();
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
      status.textContent = 'Selecione um ativo com par em USD ou USDT.';
      return;
    }
    status.textContent = 'Carregando ofertas…';
    refresh(symbol);
  }

  button.addEventListener('click', () => {
    const venue = getVenue();
    if (venue === 'binance' || venue === 'coinbase') venueSelect.value = venue;
    dialog.showModal();
    loadBook();
  });
  venueSelect.addEventListener('change', loadBook);
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    activeRequest?.abort();
    activeRequest = undefined;
  });
}

const coinbaseGranularity = {'1m':60,'5m':300,'15m':900,'1h':3600,'4h':3600,'12h':21600,'1d':86400,'1w':86400,'1M':86400};

function coinbaseBucket(time, tf) {
  if (tf === '1M') {
    const date = new Date(time * 1000);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
  }
  if (tf === '1w') return Math.floor((time + 259200) / 604800) * 604800 - 259200;
  const seconds = {'4h':14400, '12h':43200}[tf] ?? coinbaseGranularity[tf];
  return Math.floor(time / seconds) * seconds;
}

async function coinbaseCandles(tf, symbol, recent = false) {
  const granularity = coinbaseGranularity[tf];
  const now = Math.floor(Date.now() / 1000);
  const previous = coinbaseBucket(coinbaseBucket(now, tf) - 1, tf);
  const start = recent ? previous : coinbaseBucket(now - granularity * 260, tf);
  const url = new URL(coinbaseExchange + encodeURIComponent(coinbaseProduct(symbol)) + '/candles');
  const iso = time => new Date(time * 1000).toISOString();
  url.search = new URLSearchParams({granularity, start:iso(start), end:iso(now)});
  const response = await fetch(url, {signal:AbortSignal.timeout(8000), cache:'no-store'});
  if (!response.ok) throw new Error(response.status === 404 ? 'Par indisponível na Coinbase' : 'Coinbase HTTP ' + response.status);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Velas inválidas da Coinbase');
  const candles = new Map();
  for (const [time, low, high, open, close, volume] of data.sort((a,b) => a[0] - b[0])) {
    if (time < start || time > now || ![time, low, high, open, close, volume].every(Number.isFinite)) continue;
    const bucket = coinbaseBucket(time, tf);
    const candle = candles.get(bucket);
    if (candle) {
      candle.low = Math.min(candle.low, low);
      candle.high = Math.max(candle.high, high);
      candle.close = close;
      candle.volume += volume;
    } else {
      candles.set(bucket, {time:bucket, low, high, open, close, volume});
    }
  }
  return [...candles.values()];
}

const coinbaseChart = {
  rest:coinbaseCandles,
  ws(tf, onCandle, symbol) {
    let stopped = false;
    let timer;
    let lastTime;
    async function poll() {
      try {
        const candles = await coinbaseCandles(tf, symbol, true);
        if (stopped || !candles.length) return;
        const latest = candles.at(-1);
        if (lastTime !== undefined && latest.time > lastTime) {
          const closed = candles.find(candle => candle.time === lastTime);
          if (closed) onCandle(closed, true);
        }
        onCandle(latest, false);
        lastTime = latest.time;
      } catch {
        // A próxima consulta recupera atualizações perdidas.
      } finally {
        if (!stopped) timer = setTimeout(poll, 15000);
      }
    }
    timer = setTimeout(poll, 15000);
    return {close() { stopped = true; clearTimeout(timer); }};
  }
};
