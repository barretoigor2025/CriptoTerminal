function heatColor(v){
  if(v<=0.02) return [0,0,0,0];
  const stops=[
    [0.00, 30, 12, 60,   0],
    [0.18, 45, 20,130,  40],
    [0.38, 120,26,150,  92],
    [0.58, 214,32, 86, 140],
    [0.74, 244,96, 32, 168],
    [0.88, 250,182,44, 196],
    [1.00, 255,247,190,224]
  ];
  for(let i=1;i<stops.length;i++){
    if(v<=stops[i][0]){ const a=stops[i-1],b=stops[i],t=(v-a[0])/((b[0]-a[0])||1);
      return [Math.round(a[1]+(b[1]-a[1])*t),Math.round(a[2]+(b[2]-a[2])*t),Math.round(a[3]+(b[3]-a[3])*t),Math.round(a[4]+(b[4]-a[4])*t)]; }
  }
  const l=stops[stops.length-1]; return [l[1],l[2],l[3],l[4]];
}
const liquidationLeverages = [2, 3, 5, 10, 25, 50, 100];

function calculateLiquidationGrid(candles, min, max, rows, leverages, quoteUnit) {
  const columns = candles.length;
  const last = columns - 1;
  const step = (max - min) / rows;
  const G = new Float64Array(rows * columns);
  const notional = new Float64Array(rows * columns);
  const active = [];
  const volumeMax = Math.max(0, ...candles.map(candle => candle.volume));

  // Skip whole blocks when looking for the first candle that hits a price.
  const blockSize = 32;
  const lows = [], highs = [];
  candles.forEach((candle, column) => {
    const block = Math.floor(column / blockSize);
    lows[block] = Math.min(lows[block] ?? Infinity, candle.low);
    highs[block] = Math.max(highs[block] ?? -Infinity, candle.high);
  });

  candles.forEach((candle, column) => {
    const components = candle.components ?? [{
      entry:candle.entry ?? (candle.high + candle.low + candle.close) / 3, volume:candle.volume
    }];
    for (const {entry, volume} of components) {
      const weight = volumeMax ? (0.25 / components.length) + 0.75 * volume / volumeMax : 1 / components.length;
      // Cada lado e alavancagem recebe sua parte de 1% do giro simulado.
      const share = quoteUnit ? Math.max(0, volume) * entry * 0.01 / (2 * liquidationLeverages.length) : 0;
      for (const leverage of leverages) {
        const margin = 0.985 / leverage;
        for (const long of [true, false]) {
          const price = entry * (1 + (long ? -margin : margin));
          if (price <= min || price >= max) continue;
          const row = Math.min(rows - 1, Math.floor((price - min) / step));
          let next = column + 1;
          while (next < columns) {
            const block = Math.floor(next / blockSize);
            if (next % blockSize === 0 && (long ? lows[block] > price : highs[block] < price)) {
              next += blockSize;
              continue;
            }
            if (long ? candles[next].low <= price : candles[next].high >= price) break;
            next++;
          }
          const offset = row * columns;
          G[offset + column] += weight;
          notional[offset + column] += share;
          if (next < last) {
            G[offset + next + 1] -= weight;
            notional[offset + next + 1] -= share;
          } else if (next > last) {
            active.push({price, row, long, weight:share, leverage});
          }
        }
      }
    }
  });
  for (let row = 0; row < rows; row++) {
    let weight = 0, amount = 0;
    const end = (row + 1) * columns;
    for (let cell = row * columns; cell < end; cell++) {
      weight += G[cell];
      amount += notional[cell];
      G[cell] = weight > 1e-8 ? weight : 0;
      notional[cell] = G[cell] ? Math.max(0, amount) : 0;
    }
  }
  return {G, notional, active};
}

function renderLiquidationTip(el, notional, rows, cols, min, step, column, row, reference, unit, details = []) {
    const value = notional[row * cols + column];
    const origin=Math.max(0,Math.min(rows-1,Math.floor((reference-min)/step)));
    let total=0;
    for(let bandRow=Math.min(origin,row);bandRow<=Math.max(origin,row);bandRow++){
      total+=notional[bandRow*cols+column];
    }
    if(!(total>0)) return false;
    const format=new Intl.NumberFormat('pt-BR',{maximumSignificantDigits:7});
    const amount=new Intl.NumberFormat('pt-BR',{notation:'compact',maximumFractionDigits:1});
    const band=min+row*step;
    const range=document.createElement('span');
    range.textContent='Faixa '+format.format(band)+'–'+format.format(band+step);
    const sum=document.createElement('span');
    sum.textContent='Acumulado desde '+format.format(reference);
    for(const [label,notional] of [[range,value],[sum,total]]){
      const number=document.createElement('strong');
      number.textContent='≈ '+amount.format(notional)+' '+unit;
      label.append(number);
    }
    const method=document.createElement('small');
    method.textContent='Nocional simulado · 1% do giro das velas';
    const breakdown = details.map(({leverage, side, value, origin}) => {
      const item = document.createElement('small');
      item.textContent = leverage + '×' + (side ? ' ' + side : '') + ' · ≈ ' + amount.format(value) + ' ' + unit;
      if (origin) {
        item.append(document.createElement('br'), 'Velas de origem · ' + origin);
      }
      return item;
    });
    el.replaceChildren(range,sum,...breakdown,method);
    return true;
}
