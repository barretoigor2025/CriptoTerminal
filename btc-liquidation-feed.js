// Public BTC perpetual feeds. A reported liquidation's price may be a
// bankruptcy price, so its plotted location and quote value are approximate.
function watchBtcLiquidations({onMark, onLiquidation, onState}) {
  const venues = [
    {
      name:'Binance',
      url:'wss://fstream.binance.com/market/stream?streams=btcusdt@forceOrder/btcusdt@markPrice@1s',
      receive(message, mark, liquidation) {
        const data = message.data;
        if (data?.e === 'markPriceUpdate') mark(data.p);
        const order = data?.o;
        if (data?.e === 'forceOrder' && ['BUY', 'SELL'].includes(order?.S)) {
          liquidation(order.S === 'SELL' ? 'long' : 'short', order.T, order.ap, order.z);
        }
      }
    },
    {
      name:'Bybit',
      url:'wss://stream.bybit.com/v5/public/linear',
      subscribe:{op:'subscribe', args:['allLiquidation.BTCUSDT', 'tickers.BTCUSDT']},
      ping:'{"op":"ping"}',
      receive(message, mark, liquidation) {
        if (message.topic === 'tickers.BTCUSDT') mark(message.data?.markPrice);
        if (message.topic !== 'allLiquidation.BTCUSDT') return;
        for (const order of message.data ?? []) {
          if (['Buy', 'Sell'].includes(order.S)) {
            liquidation(order.S === 'Buy' ? 'long' : 'short', order.T, order.p, order.v);
          }
        }
      }
    },
    {
      name:'OKX',
      url:'wss://ws.okx.com:8443/ws/v5/public',
      subscribe:{op:'subscribe', args:[{channel:'mark-price', instId:'BTC-USDT-SWAP'}]},
      ping:'ping',
      receive(message, mark) {
        if (message.arg?.channel === 'mark-price') mark(message.data?.[0]?.markPx);
      }
    },
    {
      name:'Hyperliquid',
      url:'wss://api.hyperliquid.xyz/ws',
      subscribe:{method:'subscribe', subscription:{type:'activeAssetCtx', coin:'BTC'}},
      ping:'{"method":"ping"}',
      receive(message, mark) {
        if (message.channel === 'activeAssetCtx') mark(message.data?.ctx?.markPx);
      }
    }
  ];
  for (const venue of venues) {
    let retry = 1000;
    function connect() {
      onState(venue.name, false);
      const socket = new WebSocket(venue.url);
      const timeout = setTimeout(() => socket.close(), 10000);
      let heartbeat;
      socket.onopen = () => {
        if (venue.subscribe) socket.send(JSON.stringify(venue.subscribe));
        if (venue.ping) heartbeat = setInterval(() => socket.send(venue.ping), 18000);
      };
      socket.onmessage = ({data}) => {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (!message || typeof message !== 'object') return;
        const mark = price => {
          price = Number(price);
          if (!Number.isFinite(price) || price <= 0) return;
          clearTimeout(timeout);
          retry = 1000;
          onMark(venue.name, price);
          onState(venue.name, true);
        };
        const liquidation = (side, time, price, size) => {
          [time, price, size] = [time, price, size].map(Number);
          if (![time, price, size].every(value => Number.isFinite(value) && value > 0)) return;
          onLiquidation({venue:venue.name, side, time, price, size});
        };
        venue.receive(message, mark, liquidation);
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        onState(venue.name, false);
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30000);
      };
    }
    connect();
  }
}

function startOkxLiquidationPolling(onLiquidation) {
  const base = 'https://www.okx.com/api/v5/public/';
  let multiplier;
  let polling = false;
  async function poll() {
    if (document.hidden || polling) return;
    polling = true;
    try {
      if (!multiplier) {
        const response = await fetch(base + 'instruments?instType=SWAP&instId=BTC-USDT-SWAP',
          {signal:AbortSignal.timeout(6000)});
        if (!response.ok) return;
        const instrument = (await response.json()).data?.[0];
        if (instrument?.ctValCcy !== 'BTC') return;
        const value = Number(instrument.ctVal) * Number(instrument.ctMult);
        if (!Number.isFinite(value) || value <= 0) return;
        multiplier = value;
      }
      const response = await fetch(base + 'liquidation-orders?instType=SWAP&instFamily=BTC-USDT&state=filled&limit=50',
        {cache:'no-store', signal:AbortSignal.timeout(6000)});
      if (!response.ok) return;
      const series = (await response.json()).data ?? [];
      for (const contract of series) {
        if (contract.instId !== 'BTC-USDT-SWAP') continue;
        for (const order of contract.details ?? []) {
          if (!['long', 'short'].includes(order.posSide)) continue;
          const [time, price, contracts] = [order.ts, order.bkPx, order.sz].map(Number);
          if (![time, price, contracts].every(value => Number.isFinite(value) && value > 0)) continue;
          onLiquidation({venue:'OKX', side:order.posSide, time, price, size:contracts * multiplier});
        }
      }
    } catch {
      // The next poll retries transient connection failures.
    } finally {
      polling = false;
    }
  }
  poll();
  setInterval(poll, 7000);
}
