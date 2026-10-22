import type { Trigger } from './types.js';

export function parseTrigger(value: string | null | undefined): Trigger | null {
  if (!value) return null;
  try {
    const trigger = JSON.parse(value) as Trigger;
    return trigger && typeof trigger === 'object' && 'type' in trigger
      ? trigger
      : null;
  } catch {
    return null;
  }
}

/** Next local time matching HH:MM on one of the allowed weekdays (0=Sunday). */
export function nextDailyRun(
  trigger: Extract<Trigger, { type: 'daily' }>,
  from: number,
): number {
  const [hours, minutes] = trigger.time.split(':').map(Number);
  const days = trigger.days.length ? trigger.days : [0, 1, 2, 3, 4, 5, 6];
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > from && days.includes(candidate.getDay()))
      return candidate.getTime();
  }
  return from + 86_400_000;
}

/** Glob with * and ? to a case-insensitive whole-name RegExp. */
export function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
