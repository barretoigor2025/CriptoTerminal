#!/usr/bin/env python3
"""Refresh public BingX candles; no wallet or account data."""
import argparse, concurrent.futures, json, pathlib, time, urllib.request
def fetch(job):
    asset, interval = job
    error = None
    for attempt in range(3):
        try:
            url = ("https://open-api.bingx.com/openApi/spot/v2/market/kline"
                   f"?symbol={asset.upper()}-USDT&interval={interval}&limit=180&timestamp={int(time.time()*1000)}")
            with urllib.request.urlopen(url, timeout=20) as response:
                data = json.load(response)
            if data.get("code") != 0 or not isinstance(data.get("data"), list) or len(data["data"]) < 30:
                raise ValueError("Invalid BingX candle response")
            times = [int(row[0]) for row in data["data"]]
            if max(times) > int(time.time()*1000) + 60000:
                raise ValueError("Future candle")
            return asset, interval, data
        except Exception as exc:
            error = exc
            if attempt < 2: time.sleep(attempt + 1)
    raise RuntimeError(f"{asset} {interval}: {error}")
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    path = pathlib.Path(parser.parse_args().output)
    result = {"source":"BingX","fetchedAt":int(time.time()*1000),"assets":{}}
    jobs = [(a, tf) for a in ("mstrx","crclx") for tf in ("1h","4h","1d")]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for a, tf, data in pool.map(fetch, jobs):
            result["assets"].setdefault(a,{})[tf] = data
    path.parent.mkdir(parents=True,exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(result,separators=(",",":")),encoding="utf-8")
    temp.replace(path)
if __name__ == "__main__": main()
