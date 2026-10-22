/**
 * Owner messages sent to a conversation while its Dot is working. The running
 * unattended task ends its current turn after the tool step in progress, takes
 * these as real owner messages, and carries on in the new direction; nothing
 * is stopped or replayed.
 */
export const MAX_STEER_LENGTH = 4000;
const MAX_PENDING = 20;

export class SteeringInbox {
  private pending = new Map<string, string[]>();
  /** Queue a message for the run in `threadId`; returns how many are waiting. */
  push(threadId: string, text: string) {
    const message = text.trim();
    if (!message || message.length > MAX_STEER_LENGTH)
      throw new Error(
        `Enter a message of 1–${MAX_STEER_LENGTH} characters for the running task.`,
      );
    const queue = this.pending.get(threadId) ?? [];
    if (queue.length >= MAX_PENDING)
      throw new Error(
        'Too many messages are waiting; let the task read them first.',
      );
    queue.push(message);
    this.pending.set(threadId, queue);
    return queue.length;
  }
  has(threadId: string) {
    return (this.pending.get(threadId)?.length ?? 0) > 0;
  }
  /** Take every waiting message for `threadId`, oldest first. */
  drain(threadId: string) {
    const queue = this.pending.get(threadId) ?? [];
    this.pending.delete(threadId);
    return queue;
  }
}
