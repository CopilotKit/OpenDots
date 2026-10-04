/**
 * A poll reports what went wrong, and clears it again once the thing it was watching answers.
 * It must not clear anything else: the banner is shared with the errors from actions the owner
 * just took, and a poll that succeeds a moment later would otherwise take those away before
 * they had been read.
 *
 * `raised` is the message this poll last failed with, and `current` whatever is on screen now.
 */
export function afterPollSuccess(current: string, raised?: string): string {
  return raised !== undefined && current === raised ? '' : current;
}
