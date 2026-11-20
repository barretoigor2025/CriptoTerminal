function createConsolidatedSource(sources) {
  const venues = ['binance', 'bybit', 'coinbase', 'hyperliquid'];
  const snapshots = new Map();

  function valid(candle) {
    return [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
      && candle.low > 0 && candle.volume >= 0;
  }

  function merge(time, candles) {
    const volume = candles.reduce((sum, candle) => sum + candle.volume, 0);
    return {
      time,
      open:candles.reduce((sum, candle) => sum + candle.open, 0) / candles.length,
      high:Math.max(...candles.map(candle => candle.high)),
      low:Math.min(...candles.map(candle => candle.low)),
      close:candles.reduce((sum, candle) => sum + candle.close, 0) / candles.length,
      volume,
      venues:candles.length
    };
  }

  function put(buckets, tf, venue, candle) {
    const time = coinbaseBucket(candle.time, tf);
    if (!buckets.has(time)) buckets.set(time, new Map());
    buckets.get(time).set(venue, candle);
    return time;
  }

  async function history(venue, tf, symbol) {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tempo limite da corretora')), 8000);
      });
      const candles = await Promise.race([sources[venue].rest(tf, symbol), timeout]);
      return candles.filter(valid);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async rest(tf, symbol) {
      const key = tf + ':' + symbol;
      const buckets = new Map();
      const results = await Promise.allSettled(venues.map(venue => history(venue, tf, symbol)));
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        for (const candle of result.value) put(buckets, tf, venues[index], candle);
      });
      if (!buckets.size) throw new Error('Nenhuma corretora retornou velas para este ativo');
      const times = [...buckets.keys()].sort((a, b) => a - b);
      if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(key, times.slice(-2).map(time => [time, buckets.get(time)]));
      return times.map(time => merge(time, [...buckets.get(time).values()]));
    },

    ws(tf, onCandle, symbol) {
      const seed = snapshots.get(tf + ':' + symbol) ?? [];
      const buckets = new Map(seed.map(([time, candles]) => [time, new Map(candles)]));
      let latest = seed.at(-1)?.[0];
      let stopped = false;
      const sockets = new Map();
      const retries = new Map();

      function connect(venue) {
        if (stopped) return;
        function retry() {
          if (!stopped) retries.set(venue, setTimeout(() => connect(venue), 5000));
        }
        try {
          const socket = sources[venue].ws(tf, candle => {
            if (stopped || !valid(candle)) return;
            const time = coinbaseBucket(candle.time, tf);
            if (latest !== undefined && time < latest) return;
            if (latest !== undefined && time > latest) {
              onCandle(merge(latest, [...buckets.get(latest).values()]), true);
              buckets.clear();
            }
            put(buckets, tf, venue, candle);
            latest = time;
            onCandle(merge(time, [...buckets.get(time).values()]), false);
          }, symbol);
          sockets.set(venue, socket);
          socket.onclose = retry;
          socket.onerror = () => socket.close();
        } catch {
          retry();
        }
      }

      for (const venue of venues) connect(venue);
      return {
        close() {
          stopped = true;
          for (const id of retries.values()) clearTimeout(id);
          for (const socket of sockets.values()) socket.close();
        }
      };
    }
  };
}
