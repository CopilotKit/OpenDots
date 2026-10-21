"""End of day for the options guide: save today's 1-minute prices (Cboe only
serves the current day) and score finished suggestions. Run after 4pm New York,
e.g. from a scheduled task; the options_review tool does the same on demand."""
import json

import options_guide as og


def main() -> dict:
    journal = og.Journal()
    closes, ivs = {}, {}
    for ticker in og.TICKERS:
        journal.save_bars(ticker, og.minute_bars(ticker))
        closes[ticker] = {d['date']: d['close'] for d in og.fetch(f'charts/historical/{ticker}.json', 3600)['data'][-30:]}
        ivs.update({o['symbol']: o['iv'] for o in og.parse_chain(og.fetch(f'options/{ticker}.json'))['options']})
    journal.settle(closes)
    journal.settle_managed(og.now_eastern(), ivs)
    return journal.summary()


if __name__ == '__main__':
    print(json.dumps(main(), indent=1))
