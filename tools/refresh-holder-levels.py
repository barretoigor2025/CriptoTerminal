"""Aggregate public Glassnode age bands into six-month ETH/SOL levels."""
import html
import json
import re
import sys
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

BANDS = ('24h', '1d-1w', '1w-1m', '1m-3m', '3m-6m', '6m-12m',
         '1y-2y', '2y-3y', '3y-5y', '5y-7y', '7y-10y', '>10y')
METRICS = ('supply.HodlWaves', 'breakdowns.PriceRealizedUsdByAge')


def read_card(asset, metric):
    url = f'https://studio.glassnode.com/charts/{metric}?a={asset}&e=aggregated'
    page = subprocess.check_output(["curl", "-fsSL", "--max-time", "25", url], text=True)
    fields = re.findall(
        r'<span class="latestValueCard_multiline(Date|Label|Value)[^"]*">(.*?)</span>',
        page, re.DOTALL,
    )
    date = next(value for kind, value in fields if kind == 'Date')
    day = datetime.strptime(re.sub(r'<[^>]*>', '', date).removeprefix('as of ').strip(),
                            '%d %b %Y').date().isoformat()
    labels = [html.unescape(value) for kind, value in fields if kind == 'Label']
    values = [float(value.translate(str.maketrans('', '', '$%,')))
              for kind, value in fields if kind == 'Value']
    return day, dict(zip(labels, values, strict=True))


def calculate(asset):
    with ThreadPoolExecutor(max_workers=3) as executor:
        cards = list(executor.map(lambda metric: read_card(asset, metric), METRICS))
    (day, supply), (price_day, prices) = cards
    if day != price_day:
        raise ValueError(f'{asset}: source dates differ ({day}, {price_day})')
    if abs(sum(supply[band] for band in BANDS) - 100) > 0.05:
        raise ValueError(f'{asset}: supply bands do not sum to 100%')
    if any(supply[band] < 0 or (supply[band] > 0 and prices[band] <= 0) for band in BANDS):
        raise ValueError(f'{asset}: invalid supply or price')

    def group_price(bands):
        volume = sum(supply[band] for band in bands)
        if volume <= 0:
            raise ValueError(f'{asset}: empty cohort')
        return round(sum(prices[band] * supply[band] for band in bands) / volume, 2)

    return {'date': day, 'sth': group_price(BANDS[:5]), 'lth': group_price(BANDS[5:])}


def main(path):
    levels = json.loads(path.read_text()) if path.exists() else {}
    for asset in ('ETH', 'SOL'):
        try:
            result = calculate(asset)
            if result['date'] >= levels.get(asset, {}).get('date', ''):
                levels[asset] = result
        except (ValueError, KeyError, StopIteration, OSError, subprocess.CalledProcessError) as error:
            print(f'{asset}: {error}', file=sys.stderr)
    if not levels:
        raise SystemExit('No validated holder levels')
    path.write_text(json.dumps(levels, indent=2) + '\n')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
