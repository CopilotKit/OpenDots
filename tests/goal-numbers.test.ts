import { describe, expect, it } from 'vitest';
import {
  claimContradiction,
  claimedBalance,
  describeGoalNumbers,
  mergeGoalNumbers,
  pageBalance,
  pageContradiction,
  pageOpenTrades,
  parseGoalNumbers,
} from '../src/server/goal-numbers.js';

describe("goal numbers from the owner's own wording", () => {
  it.each([
    [
      'we have 50 in cash in our demo account, trade it the best you can till you get 1k or lose 90% of the account value.',
      { start: 50, target: 1000, lossPercent: 90, stop: 5 },
    ],
    [
      'we have 140K i want you to trade for me while im away. your goal: reach 1 Million Dollars, OR Lose 90% of the current wallet amount.',
      { start: 140000, target: 1000000, lossPercent: 90, stop: 14000 },
    ],
    [
      'we have $587 I want you to trade using the RSI and MACD signals you decide when. you can buy or sell the goal is to get 5K of available funds or lose 90% of the total.',
      { start: 587, target: 5000, lossPercent: 90, stop: 58.7 },
    ],
    [
      'proceed to trade automatically for me we have 140k make either 500k or lose 90% take as many trades as you need in any direction',
      { start: 140000, target: 500000, lossPercent: 90, stop: 14000 },
    ],
    [
      'Keep placing trades until the balance reaches $13,000 or falls below $7,000, then stop.',
      { target: 13000, stop: 7000 },
    ],
  ])('%s', (goal, expected) => {
    expect(parseGoalNumbers(goal)).toEqual(expected);
  });
  it('leaves goals without money numbers alone', () => {
    expect(parseGoalNumbers('Click BUY two times and SELL one time.')).toEqual(
      {},
    );
    expect(
      describeGoalNumbers(parseGoalNumbers('Open the page and read it.')),
    ).toBe('');
  });
  it('lets a later owner update override what it mentions', () => {
    const goal = 'we have 50 in cash, get 1k or lose 90%';
    expect(mergeGoalNumbers(goal, ['stop at $2,000 instead'])).toMatchObject({
      start: 50,
      target: 1000,
      stop: 2000,
    });
    expect(mergeGoalNumbers(goal, ['new goal: reach 500'])).toMatchObject({
      target: 500,
      stop: 5,
    });
    expect(mergeGoalNumbers(goal, ['only lose 50% now'])).toMatchObject({
      lossPercent: 50,
      stop: 25,
    });
  });
  it('states the numbers so the model cannot re-derive them', () => {
    const text = describeGoalNumbers(
      parseGoalNumbers('we have 50 in cash, till you get 1k or lose 90%'),
    );
    expect(text).toContain('starting balance $50.00');
    expect(text).toContain('$1,000.00 or more');
    expect(text).toContain(
      'stop when the balance is $5.00 or less (a 90% loss of the starting $50.00)',
    );
    expect(text).toContain('do not recalculate');
  });
});

describe('completion claims checked against the pinned numbers', () => {
  const numbers = parseGoalNumbers(
    'we have 50 in cash, till you get 1k or lose 90%',
  );
  it('catches the claim that ended the 10:31 run', () => {
    // The model's actual final message: wrong threshold, balance far above the real stop.
    const claim =
      'Initial Balance: $239.40 USD. 90% Loss Threshold: $239.40 * 0.90 = $215.46 USD. Current Balance (after the most recent BUY trade): $214.40 USD. The stop-loss condition has been met.';
    expect(claimedBalance(claim)).toBe(214.4);
    expect(claimContradiction(claim, numbers)).toContain('$214.40');
    expect(claimContradiction(claim, numbers)).toContain('stop level ($5.00)');
  });
  it('accepts claims at the goal or the stop, and claims without a balance', () => {
    expect(
      claimContradiction(
        'TASK COMPLETE: the balance is now $1,012.50.',
        numbers,
      ),
    ).toBe('');
    expect(
      claimContradiction(
        'TASK COMPLETE: account value $4.10, the loss limit was hit.',
        numbers,
      ),
    ).toBe('');
    expect(claimContradiction('TASK COMPLETE: done.', numbers)).toBe('');
  });
});

describe('the balance read from the page', () => {
  it.each([
    ['QT Demo\nUSD\n657.40\nTop up', 657.4],
    ['Balance: $575.00', 575],
    ['Account value 1,204.10', 1204.1],
    ['EUR/USD 1.0832 OTC', undefined],
    ['', undefined],
  ])('%j', (text, expected) => {
    expect(pageBalance(text)).toBe(expected);
  });
  it('refuses to end between the stop and the goal', () => {
    const numbers = parseGoalNumbers('we have 657 in cash, get 3k or lose 90%');
    expect(pageContradiction(575, numbers)).toContain('$575.00');
    expect(pageContradiction(3100, numbers)).toBe('');
    expect(pageContradiction(60, numbers)).toBe('');
    expect(pageContradiction(undefined, numbers)).toBe('');
    expect(pageContradiction(575, {})).toBe('');
  });
});

describe('open trades on the page', () => {
  // Real page text: a $49.92 trade running (balance shows $0), then none open.
  const open =
    'QT Demo\nUSD\n0\nTime\n00:00:11\nTrades\nOpened\nClosed\nGBP/JPY OTC +57%\n00:11\n$49.92\n$49.92\n$0\nSignals';
  const closed =
    'QT Demo\nUSD\n78.37\nTime\n00:00:11\nTrades\nOpened\nClosed\nNo opened trades\nSignals';
  const numbers = parseGoalNumbers(
    'we have 49.92 in cash, get $500 or lose 90%',
  );
  it('tells a running trade from none', () => {
    expect(pageOpenTrades(open)).toBe(true);
    expect(pageOpenTrades(closed)).toBe(false);
    expect(pageOpenTrades('Balance: $5.00')).toBe(false);
    expect(pageOpenTrades(undefined)).toBe(false);
  });
  it('never treats a balance with a trade open as the stop (the 18:06 run)', () => {
    expect(pageBalance(open)).toBe(0);
    expect(pageContradiction(0, numbers)).toBe(''); // what let it finish
    expect(pageContradiction(0, numbers, true)).toContain(
      'a trade is still open',
    );
    expect(pageContradiction(78.37, numbers, false)).toContain('$78.37');
  });
});
