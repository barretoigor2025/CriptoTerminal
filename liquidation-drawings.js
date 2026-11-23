function bindLiquidationDrawings({canvas, asset, candles, plotBounds, chartView, localPoint, scheduleDraw, priceLabel, clearHover}) {
  const menu = document.getElementById('drawing-tools');
  const mode = document.getElementById('drawing-mode');
  const color = document.getElementById('drawing-color');
  const style = document.getElementById('drawing-style');
  const width = document.getElementById('drawing-width');
  const selection = document.getElementById('drawing-selection');
  const remove = document.getElementById('drawing-delete');
  const status = document.getElementById('drawing-status');
  const steps = {
    horizontal:['Marque o preço da linha'],
    line:['Marque o início da linha', 'Marque o fim da linha'],
    channel:['Marque o início da primeira linha', 'Marque o fim da primeira linha', 'Marque a largura do canal'],
    fib:['Marque o início do movimento', 'Marque o fim do movimento']
  };
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const saved = new Map();
  let anchors = [];
  let preview, press;

  const active = () => Boolean(mode.value);
  const storageKey = () => 'liquidation-drawings:' + asset();
  const readStyle = () => ({color:color.value, dashed:style.value === 'dash', width:Number(width.value)});

  function items() {
    const key = storageKey();
    if (!saved.has(key)) {
      let drawings = [];
      try {
        const stored = JSON.parse(localStorage.getItem(key));
        if (Array.isArray(stored)) drawings = stored;
      } catch {}
      saved.set(key, drawings);
    }
    return saved.get(key);
  }

  function save() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(items()));
    } catch {}
    scheduleDraw();
  }

  function updateSelection(index = '') {
    selection.replaceChildren(new Option('Desenhos salvos', ''));
    items().forEach((drawing, position) => {
      const label = [...mode.options].find(option => option.value === drawing.kind)?.textContent;
      selection.add(new Option((position + 1) + '. ' + label, position));
    });
    selection.value = index;
    remove.disabled = selection.value === '';
  }

  function syncMode() {
    status.hidden = !active();
    status.textContent = active() ? steps[mode.value][anchors.length] : '';
    canvas.classList.toggle('drawing', active());
    menu.querySelector('summary').classList.toggle('active', active());
    clearHover();
    scheduleDraw();
  }

  function cancel() {
    mode.value = '';
    anchors = [];
    preview = press = undefined;
    syncMode();
  }

  mode.addEventListener('change', () => {
    anchors = [];
    preview = press = undefined;
    if (active()) {
      selection.value = '';
      remove.disabled = true;
      menu.open = false;
    }
    syncMode();
  });

  selection.addEventListener('change', () => {
    remove.disabled = selection.value === '';
    if (remove.disabled) return;
    cancel();
    const drawing = items()[Number(selection.value)];
    color.value = drawing.color;
    style.value = drawing.dashed ? 'dash' : 'solid';
    width.value = drawing.width;
  });

  for (const control of [color, style, width]) {
    control.addEventListener('input', () => {
      if (selection.value === '') {
        scheduleDraw();
        return;
      }
      Object.assign(items()[Number(selection.value)], readStyle());
      save();
    });
  }

  remove.addEventListener('click', () => {
    if (selection.value === '') return;
    items().splice(Number(selection.value), 1);
    updateSelection();
    save();
  });

  function timeAt(data, column) {
    const i = Math.max(0, Math.min(Math.floor(column), data.length - 2));
    const nextTime = data[i + 1]?.time ?? data[i].time + 1;
    return data[i].time + (nextTime - data[i].time) * (column - i);
  }

  function columnAt(data, time) {
    let left = 0;
    let right = data.length - 1;
    while (right - left > 1) {
      const mid = Math.floor((left + right) / 2);
      if (data[mid].time <= time) left = mid;
      else right = mid;
    }
    return left + (time - data[left].time) / (data[right].time - data[left].time || 1);
  }

  function anchorAt(point) {
    const data = candles();
    if (!data?.length) return;
    const {left, right, top, bottom} = plotBounds();
    if (point.x < left || point.x >= right || point.y < top || point.y > bottom || bottom <= top) return;
    const {first, count, low, high} = chartView();
    const column = first + (point.x - left) / (right - left) * count - 0.5;
    return {
      time:timeAt(data, column),
      price:low + (bottom - point.y) / (bottom - top) * (high - low)
    };
  }

  canvas.addEventListener('pointerdown', event => {
    if (!active() || !event.isPrimary || event.button !== 0) return;
    const point = localPoint(event);
    if (!anchorAt(point)) return;
    press = {id:event.pointerId, ...point};
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!active() || !event.isPrimary) return;
    const point = localPoint(event);
    if (press && Math.hypot(point.x - press.x, point.y - press.y) > 10) press = undefined;
    preview = event.pointerType === 'mouse' ? anchorAt(point) : undefined;
    if (anchors.length) scheduleDraw();
  });

  canvas.addEventListener('pointerup', event => {
    if (!active() || press?.id !== event.pointerId) return;
    const point = localPoint(event);
    const moved = Math.hypot(point.x - press.x, point.y - press.y) > 10;
    press = undefined;
    const anchor = moved ? undefined : anchorAt(point);
    if (!anchor) return;
    const kind = mode.value;
    if (anchors.length === 1 && kind === 'channel' && anchor.time === anchors[0].time) return;
    anchors.push(anchor);
    if (anchors.length < steps[kind].length) {
      preview = undefined;
      syncMode();
      return;
    }
    items().push({kind, anchors, ...readStyle()});
    save();
    cancel();
    updateSelection();
  });

  for (const event of ['pointercancel', 'lostpointercapture', 'pointerleave']) {
    canvas.addEventListener(event, () => {
      press = preview = undefined;
      if (active()) scheduleDraw();
    });
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active()) {
      event.preventDefault();
      cancel();
    }
  }, true);

  function paint(ctx, data, {left, right}, first, stride, y) {
    const x = time => left + (columnAt(data, time) - first + 0.5) * stride;

    function paintDrawing({kind, anchors:[a,b,c], color, dashed, width}) {
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [6, 4] : []);
      function segment(x1, y1, x2, y2) {
        ctx.beginPath();
        ctx.moveTo(x1,y1);
        ctx.lineTo(x2,y2);
        ctx.stroke();
      }
      function priceLine(x1, x2, price, prefix = '') {
        const height = y(price);
        segment(x1, height, x2, height);
        const label = prefix + priceLabel(price);
        const labelX = Math.min(x2, right) - ctx.measureText(label).width - 4;
        if (x2 > left && x1 < right) {
          const start = Math.max(left + 4, labelX);
          ctx.strokeStyle = '#171717';
          ctx.lineWidth = 3;
          ctx.strokeText(label, start, height - 3);
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.fillText(label, start, height - 3);
        }
      }
      if (kind === 'horizontal') {
        priceLine(left, right, a.price);
      } else if (!b) {
        ctx.fillRect(x(a.time) - 2, y(a.price) - 2, 4, 4);
      } else if (kind === 'fib') {
        for (const level of levels) {
          priceLine(Math.min(x(a.time), x(b.time)), Math.max(x(a.time), x(b.time)),
            b.price + (a.price - b.price) * level, Number((level * 100).toFixed(1)) + '% · ');
        }
      } else {
        const start = x(a.time);
        const end = x(b.time);
        segment(start, y(a.price), end, y(b.price));
        if (kind === 'channel' && c && end !== start) {
          const fraction = (c.time - a.time) / (b.time - a.time);
          const offset = c.price - (a.price + (b.price - a.price) * fraction);
          segment(start, y(a.price + offset), end, y(b.price + offset));
        }
      }
    }

    const drawings = items();
    if (!drawings.length && !anchors.length) return;
    ctx.save();
    for (const drawing of drawings) paintDrawing(drawing);
    if (anchors.length) {
      ctx.globalAlpha = 0.75;
      paintDrawing({kind:mode.value, anchors:preview ? [...anchors, preview] : anchors, ...readStyle()});
    }
    ctx.restore();
  }

  updateSelection();
  return {active, paint, reset() { cancel(); updateSelection(); }};
}
