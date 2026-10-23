"""End of day for the options guide: save today's 1-minute prices (Cboe only
serves the current day), score finished suggestions, and report how the
autopilot's picks did (live) or would have done (dry run), and step the weekly put
spread paper record (weekly_puts.py). Run after 4pm New
York, e.g. from a scheduled task; the options_review tool does the same on demand."""
import json
import time

import option_history
import options_guide as og


def autopilot_report(journal: og.Journal) -> dict | None:
    """The autopilot's picks (live, dry run, or the shadow record kept while it is off):
    those made today and those that closed today, scored, sent to the owner (toast and banner)."""
    import autopilot
    import options_watch
    now = og.now_eastern()
    today = now.date().isoformat()
    results = options_watch.pick_results(journal, autopilot.Orders(journal.path), now, days=14)
    opened = [p for p in results['picks'] if p['day'] == today]
    closed = [p for p in results['picks'] if p.get('closed_day') == today]
    if not opened and not closed:
        return None
    describe = lambda p: (f'{p["ticker"]} {p["kind"]} from {p["day"][5:]} at ${p["price"]:.2f}: '
                          + (f'still open (now ${p["pnl"]:+.2f})' if p['how'] == 'still open' else f'{p["how"]} ${p["pnl"]:+.2f}'))
    made = sum(p['pnl'] for p in closed)
    modes = {p['mode'] for p in opened + closed}
    label = 'Autopilot' if 'live' in modes else 'Autopilot (not live)'
    all_closed = [p for p in results['picks'] if p['how'] != 'still open']
    record = (f' Last 14 days: {sum(p["pnl"] > 0 for p in all_closed)} of {len(all_closed)} closed picks won, '
              f'${sum(p["pnl"] for p in all_closed):+.2f}.' if all_closed else '')
    alert = {'at': time.time(), 'trade': f'report-{today}', 'event': 'daily report',
             'title': f'{label}: {len(closed)} closed today (${made:+.2f}), {len(opened)} new',
             'message': ' | '.join(describe(p) for p in closed + opened) + record}
    options_watch.notify(alert)
    return alert


def weekly(document: dict) -> dict:
    """The weekly uptrend put spread's paper record: tonight's step, from the real chain."""
    import weekly_puts
    try:
        chain = og.parse_chain(document)
        closes = {d['date']: d['close'] for d in og.fetch('charts/historical/SPY.json', 3600)['data']}
        closes.setdefault(chain['asof'].date().isoformat(), chain['price'])  # Today's close, if not posted yet.
        step = weekly_puts.evening(chain, closes)
    except Exception as error:  # The rest of the evening still runs.
        return {'error': f'{type(error).__name__}: {error}'[:300]}
    news = []
    if 'closed' in step:
        news.append(f'closed ({step["closed"]["how"]}) ${step["closed"]["pnl"]:+.2f}')
    if isinstance(step.get('entry'), dict):
        e = step['entry']
        news.append(f'new: sell {e["short"]:g}P / buy {e["long"]:g}P {e["expiry"]} at about ${e["mid"]:.2f}')
    if news:
        import options_watch
        options_watch.notify({'at': time.time(), 'trade': f'weekly-puts-{chain["asof"].date()}', 'event': 'paper pick',
                              'title': 'Weekly put spread (paper)', 'message': '; '.join(news) + '. Recorded only.'})
    return step


def main() -> dict:
    journal = og.Journal()
    summary_puts = None
    closes, ivs = {}, {}
    for ticker in og.TICKERS:
        journal.save_bars(ticker, og.minute_bars(ticker))
        closes[ticker] = {d['date']: d['close'] for d in og.fetch(f'charts/historical/{ticker}.json', 3600)['data'][-30:]}
        document = og.fetch(f'options/{ticker}.json')
        ivs.update({o['symbol']: o['iv'] for o in og.parse_chain(document)['options']})
        option_history.save_cboe(ticker, document, og.now_eastern().date().isoformat())  # Real history from now on.
        if ticker == 'SPY':
            summary_puts = weekly(document)
    journal.settle(closes)
    journal.settle_managed(og.now_eastern(), ivs)
    summary = journal.summary()
    summary['autopilot_today'] = autopilot_report(journal)
    summary['weekly_puts'] = summary_puts
    try:  # A little more past history each day, within the free key's limit.
        summary['option_history'] = option_history.fetch_next(log=lambda *a: None)
    except LookupError as error:
        summary['option_history'] = str(error)
    return summary


if __name__ == '__main__':
    print(json.dumps(main(), indent=1))
