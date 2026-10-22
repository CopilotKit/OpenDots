/**
 * Money numbers in an owner's goal, computed by code so a small model cannot
 * drift: "we have 50 … till you get 1k or lose 90%" becomes start $50, target
 * $1,000 and stop at or below $5. Models re-derive these every turn and get
 * them wrong (a "90% loss" of $50 computed as $45, the start re-anchored to the
 * current balance), so the run pins them instead.
 */
export interface GoalNumbers {
  start?: number;
  target?: number;
  lossPercent?: number;
  stop?: number;
}

const AMOUNT = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|m\b|mil\b|million)?`;

export function amount(digits: string, unit = ''): number {
  const value = Number(digits.replace(/,/g, ''));
  const scale = /^(k|thousand)$/i.test(unit)
    ? 1_000
    : /^(m|mil|million)$/i.test(unit)
      ? 1_000_000
      : 1;
  return value * scale;
}

function first(text: string, pattern: string): number | undefined {
  const match = new RegExp(pattern, 'i').exec(text);
  if (!match) return undefined;
  // The amount is the last two groups of each pattern below.
  const groups = match.slice(1).filter((group) => group !== undefined);
  const unit = /^(k|thousand|m|mil|million)$/i.test(groups.at(-1) ?? '')
    ? groups.pop()
    : '';
  const digits = groups.pop();
  return digits ? amount(digits, unit) : undefined;
}

/** Read start, target and loss limit from goal text; missing parts stay undefined. */
export function parseGoalNumbers(text: string): GoalNumbers {
  const found: GoalNumbers = {
    start: first(
      text,
      String.raw`(?:we have|i have|starting (?:balance|at|with)|start(?:s|ing)? at|balance (?:is|of)|account (?:has|of))\s*(?:about\s*)?${AMOUNT}`,
    ),
    target: first(
      text,
      String.raw`(?:get|reach(?:es)?|make|hit|grow (?:it )?to|until (?:the balance |it )?(?:reaches|hits)|target(?: of| is)?|goal(?: of| is)?)\s*(?:to\s*)?(?:either\s*)?${AMOUNT}`,
    ),
  };
  const loss =
    /(?:lose|loss of|losing|down)\s*(\d{1,3}(?:\.\d+)?)\s*%|(\d{1,3}(?:\.\d+)?)\s*%\s*(?:loss|drawdown|down)/i.exec(
      text,
    );
  if (loss) found.lossPercent = Number(loss[1] ?? loss[2]);
  const floor = first(
    text,
    String.raw`(?:falls? below|drops? below|goes below|under|stop (?:at|if (?:it|the balance) (?:falls|drops) (?:below|to)))\s*${AMOUNT}`,
  );
  if (floor !== undefined && floor !== found.target) found.stop = floor;
  else if (found.lossPercent !== undefined && found.start !== undefined)
    found.stop = round(found.start * (1 - found.lossPercent / 100));
  return Object.fromEntries(
    Object.entries(found).filter(
      ([, value]) => value !== undefined && Number.isFinite(value),
    ),
  ) as GoalNumbers;
}

/** The original goal's numbers, with later owner updates overriding what they mention. */
export function mergeGoalNumbers(goal: string, updates: string[]): GoalNumbers {
  const merged = parseGoalNumbers(goal);
  for (const update of updates) {
    const next = parseGoalNumbers(update);
    Object.assign(merged, next);
    if (
      next.lossPercent !== undefined &&
      next.stop === undefined &&
      merged.start !== undefined
    )
      merged.stop = round(merged.start * (1 - next.lossPercent / 100));
  }
  return merged;
}

const round = (value: number) => Math.round(value * 100) / 100;
export const money = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The pinned numbers in words, or '' when the goal has none worth pinning. */
export function describeGoalNumbers(numbers: GoalNumbers): string {
  if (numbers.target === undefined && numbers.stop === undefined) return '';
  const parts = [
    numbers.start !== undefined && `starting balance ${money(numbers.start)}`,
    numbers.target !== undefined &&
      `goal reached when the balance is ${money(numbers.target)} or more`,
    numbers.stop !== undefined &&
      `stop when the balance is ${money(numbers.stop)} or less${numbers.lossPercent !== undefined && numbers.start !== undefined ? ` (a ${numbers.lossPercent}% loss of the starting ${money(numbers.start)})` : ''}`,
  ].filter(Boolean);
  return `Fixed numbers, computed by OpenDots from my goal; use them exactly, do not recalculate or re-anchor them to the current balance, and do not repeat them in your reply: ${parts.join('; ')}.`;
}

/**
 * The balance a completion claim reports, if it states one: the last amount
 * written after a word like "balance" or "account value".
 */
export function claimedBalance(text: string): number | undefined {
  const pattern = new RegExp(
    String.raw`(?:current balance|balance|account value|wallet|total)[^$\d\n]{0,40}${AMOUNT}`,
    'gi',
  );
  let last: number | undefined;
  for (const match of text.matchAll(pattern))
    last = amount(match[1], match[2] ?? '');
  return last;
}

/** Why a completion claim cannot be right, or '' when it may be. */
export function claimContradiction(text: string, numbers: GoalNumbers): string {
  const balance = claimedBalance(text);
  if (balance === undefined) return '';
  const aboveStop = numbers.stop === undefined || balance > numbers.stop;
  const belowTarget = numbers.target === undefined || balance < numbers.target;
  if (!aboveStop || !belowTarget) return '';
  return `Not finished: the balance you report (${money(balance)}) is${numbers.stop !== undefined ? ` above the stop level (${money(numbers.stop)})` : ''}${numbers.stop !== undefined && numbers.target !== undefined ? ' and' : ''}${numbers.target !== undefined ? ` below the goal (${money(numbers.target)})` : ''}. Neither condition is met, so keep working.`;
}

/**
 * The account balance shown on a page, read by code so the model cannot
 * "remember" a wrong one: the first amount after a balance label such as
 * "QT Demo USD 657.40", "Balance: $575.00" or "Account value 1,204.10".
 */
export function pageBalance(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match =
    /(?:QT Demo|QT Real|Demo account|Real account|Available (?:funds|balance)|Account (?:balance|value)|Balance|Wallet)\s*[:-]?\s*(?:USD|EUR|GBP|USDT|\$|€|£)?\s*[:-]?\s*[$€£]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/i.exec(
      text,
    );
  return match ? amount(match[1]) : undefined;
}

/**
 * Whether the page lists a trade that is still running. Pocket Option shows
 * "Trades / Opened / Closed" followed by the open trades, or "No opened trades".
 * While one is open the shown balance leaves out its stake (a $49.92 stake on a
 * $49.92 account shows $0), so the balance cannot decide the goal or the stop.
 */
export function pageOpenTrades(text: string | undefined): boolean {
  const next =
    /\bOpened\s*\n\s*Closed\s*\n\s*([^\n]*)/.exec(text ?? '')?.[1] ?? '';
  return !!next.trim() && !/no opened trades|^signals$/i.test(next.trim());
}

/** Why the run cannot end at the page's real balance, or '' when it may. */
export function pageContradiction(
  balance: number | undefined,
  numbers: GoalNumbers,
  openTrades = false,
): string {
  if (
    openTrades &&
    (numbers.stop !== undefined || numbers.target !== undefined)
  )
    return `Not finished: a trade is still open on the page, so the balance shown${balance !== undefined ? ` (${money(balance)})` : ''} leaves out its stake. Wait for it to close, then judge the goal and the stop from the balance.`;
  if (balance === undefined) return '';
  const aboveStop = numbers.stop === undefined || balance > numbers.stop;
  const belowTarget = numbers.target === undefined || balance < numbers.target;
  if (
    !aboveStop ||
    !belowTarget ||
    (numbers.stop === undefined && numbers.target === undefined)
  )
    return '';
  return `Not finished: the balance on the page right now is ${money(balance)}, which is${numbers.stop !== undefined ? ` above the stop level (${money(numbers.stop)})` : ''}${numbers.stop !== undefined && numbers.target !== undefined ? ' and' : ''}${numbers.target !== undefined ? ` below the goal (${money(numbers.target)})` : ''}. Keep working.`;
}
