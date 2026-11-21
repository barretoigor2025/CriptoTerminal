const get = id => document.getElementById(id);
const asset = get('asset'), range = get('range'), historyWindow = get('window'), bookVenue = get('book');
const canvas = get('profile'), tip = get('tip'), pen = canvas.getContext('2d');
const available = Array.from(asset.options, option => option.value);
const requested = new URLSearchParams(location.search).get('asset')?.toUpperCase();
if (available.includes(requested)) asset.value = requested;

const hour = 3600000, rows = 120, tiers = [10, 25, 50, 100];
const colors = {
  long:['#a95b22','#e88738','#ffbb63','#ffe3aa'],
  short:['#186ba7','#269cdd','#62dcff','#caf7ff']
};
const quote = new Intl.NumberFormat('pt-BR', {notation:'compact', maximumFractionDigits:2});
const priceLabel = new Intl.NumberFormat('pt-BR', {maximumSignificantDigits:7});
const clock = new Intl.DateTimeFormat('pt-BR', {timeZone:'Asia/Tokyo', timeStyle:'medium'});
const events = new Map(available.map(name => [name + 'USDT', []]));
const collected = new Map();
const prices = {binance:new Map(), bybit:new Map()};
const feeds = {binance:'Binance', bybit:'Bybit'};
let market = {}, model = null, modelKey, book, bookAt, pointer, renderFrame;
const symbol = () => asset.value + 'USDT';
const usdt = value => quote.format(value) + ' USDT';

function markFeed(venue, label, live = false) {
  get(venue).textContent = feeds[venue] + ' · ' + label;
  get(venue).dataset.live = live;
}

function connect(venue, url, receive, onOpen) {
  let retry = 1000;
  function open() {
    markFeed(venue, 'conectando');
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => socket.close(), 10000);
    let heartbeat, confirmation;
    socket.onopen = () => {
      clearTimeout(timeout);
      if (onOpen) {
        onOpen(socket);
        confirmation = setTimeout(() => socket.close(), 10000);
        heartbeat = setInterval(() => socket.send('{"op":"ping"}'), 20000);
      } else {
        retry = 1000;
        collected.set(venue, collected.get(venue) ?? Date.now());
        markFeed(venue, 'ao vivo', true);
      }
    };
    socket.onmessage = event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.op === 'subscribe') {
        if (!data.success) { socket.close(); return; }
        clearTimeout(confirmation);
        retry = 1000;
        collected.set(venue, collected.get(venue) ?? Date.now());
        markFeed(venue, 'ao vivo', true);
      }
      receive(data);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      clearTimeout(confirmation);
      markFeed(venue, 'reconectando');
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30000);
    };
  }
  open();
}

function record(venue, pair, side, time, price, quantity) {
  const list = events.get(pair);
  const value = price * quantity;
  if (!list || !Number.isFinite(value) || value <= 0 || !Number.isFinite(time) || time < Date.now() - hour) return;
  list.push({venue, side, time, value});
}

const streams = [...events.keys()].map(pair => pair.toLowerCase()).flatMap(pair =>
  [pair + '@forceOrder', pair + '@markPrice@1s']).join('/');
connect('binance', 'wss://fstream.binance.com/market/stream?streams=' + streams, ({data}) => {
  if (data?.e === 'markPriceUpdate' && Number(data.p) > 0) {
    prices.binance.set(data.s, {price:Number(data.p), time:Date.now(), source:'Binance'});
  }
  const order = data?.o;
  if (data?.e === 'forceOrder' && ['BUY','SELL'].includes(order?.S)) {
    record('binance', order.s, order.S === 'SELL' ? 'long' : 'short', Number(order.T), Number(order.ap), Number(order.z));
  }
});
connect('bybit', 'wss://stream.bybit.com/v5/public/linear', message => {
  if (message.topic?.startsWith('tickers.') && Number(message.data?.markPrice) > 0) {
    prices.bybit.set(message.data.symbol, {price:Number(message.data.markPrice), time:Date.now(), source:'Bybit'});
  }
  if (!message.topic?.startsWith('allLiquidation.') || !Array.isArray(message.data)) return;
  for (const order of message.data) {
    if (['Buy','Sell'].includes(order.S)) {
      record('bybit', order.s, order.S === 'Buy' ? 'long' : 'short', Number(order.T), Number(order.p), Number(order.v));
    }
  }
}, socket => socket.send(JSON.stringify({
  op:'subscribe', args:[...events.keys()].flatMap(pair => ['allLiquidation.' + pair, 'tickers.' + pair])
})));

function renderCards() {
  const now = Date.now();
  for (const [pair, list] of events) events.set(pair, list.filter(event => event.time >= now - hour));
  const totals = {long:0, short:0}, recent = {long:0, short:0}, counts = {long:0, short:0};
  let largest;
  for (const event of events.get(symbol())) {
    totals[event.side] += event.value;
    counts[event.side]++;
    if (event.time >= now - 300000) recent[event.side] += event.value;
    if (!largest || event.value > largest.value) largest = event;
  }
  for (const side of ['long','short']) {
    get(side).textContent = collected.size ? usdt(totals[side]) : '—';
    get(side + '-5').textContent = collected.size ? usdt(recent[side]) : '—';
    get(side + '-count').textContent = collected.size ? counts[side] + ' eventos recebidos' : '';
  }
  get('largest').textContent = largest ? usdt(largest.value) : '—';
  get('largest-detail').textContent = largest ? [feeds[largest.venue], largest.side, clock.format(largest.time) + ' JST'].join(' · ') : '';
}

async function loadModel(state) {
  if (state.loading) return;
  state.loading = true;
  const limit = Number(historyWindow.value) * 12;
  const sources = [
    {name:'Bybit perpétuos', url:'https://api.bybit.com/v5/market/kline?' + new URLSearchParams({category:'linear', symbol:state.pair, interval:'5', limit}), read:data => data.result?.list},
    {name:'Binance perpétuos', url:'https://fapi.binance.com/fapi/v1/klines?' + new URLSearchParams({symbol:state.pair, interval:'5m', limit}), read:data => data}
  ];
  try {
    for (const source of sources) {
      try {
        const response = await fetch(source.url, {signal:AbortSignal.any([state.signal, AbortSignal.timeout(6000)]), cache:'no-store'});
        if (!response.ok) continue;
        const list = source.read(await response.json());
        if (!Array.isArray(list)) continue;
        const candles = list.map(row => {
          const [time,,high,low,close,volume] = row.map(Number);
          return {time, high, low, close, volume};
        }).filter(candle => Object.values(candle).every(Number.isFinite) && candle.low > 0 && candle.close > 0);
        if (!candles.length || state !== market) continue;
        state.candles = candles.sort((a, b) => a.time - b.time);
        state.source = source.name;
        state.updated = Date.now();
        return;
      } catch {
        if (state.signal.aborted) return;
      }
    }
  } finally {
    state.loading = false;
    if (state === market) scheduleDraw();
  }
}

let bookRequest;
async function loadBook() {
  if (!bookVenue.value || bookRequest) return;
  const request = new AbortController();
  bookRequest = request;
  try {
    const result = await getExchangeBook(bookVenue.value, symbol(), request.signal, 1000);
    if (request === bookRequest) { book = result; bookAt = Date.now(); }
  } catch {
    if (request === bookRequest) book = null;
  } finally {
    if (request === bookRequest) { bookRequest = null; scheduleDraw(); }
  }
}

function resetBook() {
  bookRequest?.abort();
  bookRequest = null;
  book = null;
  loadBook();
  scheduleDraw();
}

function selectMarket() {
  market.controller?.abort();
  const controller = new AbortController();
  market = {controller, signal:controller.signal, pair:symbol()};
  get('history-link').href = 'liquidacoes.html?asset=' + asset.value;
  const url = new URL(location.href);
  url.searchParams.set('asset', asset.value);
  history.replaceState(null, '', url);
  pointer = undefined;
  resetBook();
  loadModel(market);
  renderCards();
}

function profile(reference) {
  const distance = Number(range.value) / 100;
  const min = reference * (1 - distance), max = reference * (1 + distance);
  const bins = Array.from({length:rows}, () => ({tiers:[0,0,0,0], bids:0, asks:0, sum:0, cumulative:0}));
  const bucket = price => Math.floor((price - min) / (max - min) * rows);
  if (market.candles) {
    const {active} = calculateLiquidationGrid(market.candles, min, max, rows, tiers, 'USDT');
    for (const zone of active) {
      if (zone.long ? zone.row >= rows / 2 : zone.row < rows / 2) continue;
      bins[zone.row].tiers[tiers.indexOf(zone.leverage)] += zone.weight;
      bins[zone.row].sum += zone.weight;
    }
  }
  for (const [key, levels] of Object.entries(book ?? {})) {
    for (const [price, size] of levels) {
      const bin = bins[bucket(price)];
      if (bin) bin[key] += price * size;
    }
  }
  for (let offset = 0; offset < rows / 2; offset++) {
    const left = rows / 2 - 1 - offset, right = rows / 2 + offset;
    bins[left].cumulative = bins[left].sum + (offset ? bins[left + 1].cumulative : 0);
    bins[right].cumulative = bins[right].sum + (offset ? bins[right - 1].cumulative : 0);
  }
  return {bins, min, max};
}

function scheduleDraw() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = 0; draw(); });
}

function draw() {
  const size = canvas.getBoundingClientRect();
  const width = size.width, height = size.height, ratio = devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  pen.setTransform(ratio, 0, 0, ratio, 0, 0);
  tip.hidden = true;
  const mark = [prices.binance, prices.bybit].map(feed => feed.get(symbol()))
    .find(tick => tick && Date.now() - tick.time < 5000);
  const reference = mark?.price ?? market.candles?.at(-1)?.close;
  const unit = bookVenue.value === 'coinbase' ? 'USD' : 'USDT';
  get('chart-title').textContent = 'Perfil estimado · ' + asset.value + ' · ±' + range.value + '% · ' + historyWindow.value + ' h';
  const coverage = Object.entries(feeds).map(([id, name]) =>
    name + (collected.has(id) ? ' desde ' + clock.format(collected.get(id)) + ' JST' : ' aguardando conexão')).join(' / ');
  const status = [
    'Eventos desta sessão · ' + coverage,
    market.source ? 'Modelo · ' + market.source + ' · ' + clock.format(market.updated) + ' JST' : 'Velas do modelo indisponíveis ou carregando',
    bookVenue.value && (book ? 'Livro à vista · ' + unit + ' · ' + clock.format(bookAt) + ' JST' : 'Livro aguardando dados')
  ].filter(Boolean).join(' | ');
  if (get('status').textContent !== status) get('status').textContent = status;
  pen.font = '11px system-ui';
  pen.fillStyle = '#b4c2d6';
  if (!reference || width < 130) {
    pen.fillText('Aguardando preço de referência…', 10, 30);
    return;
  }
  const key = [reference, market.updated, range.value, book ? bookAt : ''].join('/');
  if (!model || modelKey !== key) {
    model = profile(reference);
    modelKey = key;
  }
  const {bins, min, max} = model;
  const left = 49, right = width - 12, top = 29, axis = height * .72, bottom = height - 6;
  const stride = (right - left) / rows;
  const barMax = Math.max(1, ...bins.map(bin => bin.sum));
  const lineMax = Math.max(1, bins[0].cumulative, bins.at(-1).cumulative);
  const bookMax = Math.max(1, ...bins.map(bin => Math.max(bin.bids, bin.asks)));
  for (let i = 0; i <= 4; i++) {
    const y = axis - i / 4 * (axis - top);
    pen.fillStyle = '#304057';
    pen.fillRect(left, y, right - left, 1);
    pen.fillStyle = '#b4c2d6';
    if (i && barMax > 1) pen.fillText(quote.format(barMax * i / 4), 2, y + 4);
  }
  bins.forEach((bin, index) => {
    const x = left + index * stride;
    let y = axis;
    const palette = colors[index < rows / 2 ? 'long' : 'short'];
    bin.tiers.forEach((value, tier) => {
      const bar = value / barMax * (axis - top);
      pen.fillStyle = palette[tier];
      pen.fillRect(x, y - bar, Math.max(1, stride - 1), bar);
      y -= bar;
    });
    for (const [key, color] of [['bids','#4dbfba'], ['asks','#ed9763']]) {
      pen.fillStyle = color;
      pen.fillRect(x + (key === 'asks' ? stride / 2 : 0), axis + 18, Math.max(1, stride / 2), bin[key] / bookMax * (bottom - axis - 18));
    }
  });
  for (const [side, start, end] of [['long',0,rows / 2], ['short',rows / 2,rows]]) {
    pen.beginPath();
    pen.strokeStyle = colors[side][2];
    pen.setLineDash(side === 'long' ? [5,3] : []);
    pen.lineWidth = 1.5;
    for (let i = start; i < end; i++) {
      const x = left + (i + .5) * stride;
      const y = axis - bins[i].cumulative / lineMax * (axis - top);
      if (i === start) pen.moveTo(x,y); else pen.lineTo(x,y);
    }
    pen.stroke();
    pen.setLineDash([]);
  }
  const center = (left + right) / 2;
  pen.fillStyle = '#e1edff';
  pen.textAlign = 'center';
  pen.fillText((mark ? 'Marca ' + mark.source + ' ' : 'Último fechamento ') + priceLabel.format(reference), center, 16);
  pen.fillRect(center, top, 1, bottom - top);
  const ticks = width > 650 ? 8 : 4;
  for (let i = 0; i <= ticks; i++) {
    if (i === ticks / 2) continue;
    pen.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
    pen.fillText(priceLabel.format(min + (max - min) * i / ticks), left + (right - left) * i / ticks, axis + 13);
  }
  pen.textAlign = 'left';
  if (book) pen.fillText('Livro', 2, axis + 32);
  if (pointer == null || pointer < left || pointer >= right) return;
  const index = Math.floor((pointer - left) / stride);
  const bin = bins[index], low = min + (max - min) * index / rows;
  pen.fillStyle = '#ffffff38';
  pen.fillRect(left + index * stride, top, stride, bottom - top);
  tip.textContent = [
    priceLabel.format(low) + '–' + priceLabel.format(low + (max - min) / rows),
    (index < rows / 2 ? 'Longs' : 'Shorts') + (market.candles ? ' estimados · ≈ ' + usdt(bin.sum) : ' · modelo indisponível'),
    market.candles && 'Acumulado desde o preço · ≈ ' + usdt(bin.cumulative),
    ...tiers.map((tier, i) => bin.tiers[i] ? tier + '× · ≈ ' + usdt(bin.tiers[i]) : ''),
    book && 'Compras ' + quote.format(bin.bids) + ' / vendas ' + quote.format(bin.asks) + ' ' + unit
  ].filter(Boolean).join('\n');
  tip.hidden = false;
  tip.style.left = Math.max(0, Math.min(pointer + 10, width - tip.offsetWidth)) + 'px';
}

asset.addEventListener('change', selectMarket);
historyWindow.addEventListener('change', selectMarket);
range.addEventListener('change', scheduleDraw);
bookVenue.addEventListener('change', resetBook);
canvas.addEventListener('pointermove', event => { pointer = event.offsetX; scheduleDraw(); });
canvas.addEventListener('pointerdown', event => { pointer = event.offsetX; scheduleDraw(); });
canvas.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') { pointer = undefined; scheduleDraw(); } });
new ResizeObserver(scheduleDraw).observe(canvas);
const fullscreen = get('fullscreen');
if (document.fullscreenEnabled) {
  fullscreen.hidden = false;
  fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {}
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  });
}
selectMarket();
setInterval(() => { renderCards(); scheduleDraw(); }, 1000);
setInterval(loadBook, 5000);
setInterval(() => loadModel(market), 30000);
