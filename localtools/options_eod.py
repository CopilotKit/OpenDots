"""End of day for the options guide: save today's 1-minute prices (Cboe only
serves the current day), score finished suggestions, and report how the
autopilot's picks did (live) or would have done (dry run). Run after 4pm New
York, e.g. from a scheduled task; the options_review tool does the same on demand."""
import json
import time

import options_guide as og


def autopilot_report(journal: og.Journal) -> dict | None:
    """Today's autopilot picks, scored, sent to the owner (toast and app banner)."""
    import autopilot
    import options_watch
    now = og.now_eastern()
    results = options_watch.pick_results(journal, autopilot.Orders(journal.path), now, days=14)
    today = [p for p in results['picks'] if p['day'] == now.date().isoformat()]
    if not today:
        return None
    day = next(d for d in results['days'] if d['day'] == now.date().isoformat())
    lines = [f'{p["time"]} {p["ticker"]} {p["kind"]} at ${p["price"]:.2f}: '
             + (f'still open (now ${p["pnl"]:+.2f})' if p['how'] == 'still open' else f'{p["how"]} ${p["pnl"]:+.2f}')
             for p in today[::-1]]
    closed = day['picks'] - day['open']
    label = 'Autopilot (dry run)' if all(p['mode'] == 'dry_run' for p in today) else 'Autopilot'
    alert = {'at': time.time(), 'trade': f'report-{day["day"]}', 'event': 'daily report',
             'title': f'{label} today: {day["picks"]} pick{"s" if day["picks"] != 1 else ""}, ${day["pnl"]:+.2f}',
             'message': (f'{day["wins"]} of {closed} closed with a profit. ' if closed else '') + ' | '.join(lines)}
    options_watch.notify(alert)
    return alert


def main() -> dict:
    journal = og.Journal()
    closes, ivs = {}, {}
    for ticker in og.TICKERS:
        journal.save_bars(ticker, og.minute_bars(ticker))
        closes[ticker] = {d['date']: d['close'] for d in og.fetch(f'charts/historical/{ticker}.json', 3600)['data'][-30:]}
        ivs.update({o['symbol']: o['iv'] for o in og.parse_chain(og.fetch(f'options/{ticker}.json'))['options']})
    journal.settle(closes)
    journal.settle_managed(og.now_eastern(), ivs)
    summary = journal.summary()
    summary['autopilot_today'] = autopilot_report(journal)
    return summary


if __name__ == '__main__':
    print(json.dumps(main(), indent=1))
