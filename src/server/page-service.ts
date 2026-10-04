import { randomUUID } from 'node:crypto';
import { PageError } from './pages.js';
import type { WorkspaceStore } from './workspace.js';
export interface PageIntelligence {
  getOrCreateThread(input: {
    threadId: string;
    userId: string;
    agentId: string;
    name: string;
  }): Promise<unknown>;
  getThreadMessages(input: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: { role: string; content?: unknown }[] }>;
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Intelligence request timed out. Retry to recover the same conversation.',
              ),
            ),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class PageService {
  private pending = new Map<
    string,
    Promise<ReturnType<WorkspaceStore['requireThread']>>
  >();
  constructor(
    private workspace: WorkspaceStore,
    private intelligence: () => PageIntelligence,
    private useCodex: () => boolean = () => false,
    private codexMessages?: (
      threadId: string,
    ) => Promise<{ role: string; content?: unknown }[]>,
  ) {}
  async conversation(spaceId: string, pageId: string, dotId: string) {
    const page = this.workspace.pages.get(spaceId, pageId);
    const dot = this.workspace.dot(dotId);
    if (!dot || !this.workspace.canAccessSpace(dotId, spaceId))
      throw new PageError(
        'Choose a specialist in this Space with access enabled.',
        400,
      );
    const key = `${pageId}:${dotId}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const current = this.workspace.pages.thread(pageId, dotId);
    if (current?.ready)
      return this.workspace.requireThread(current.threadId, dotId);
    const sdk = this.useCodex() ? undefined : this.intelligence();
    const task = (async () => {
      const candidateId = randomUUID();
      if (!this.workspace.pages.reserveThread(pageId, dotId, candidateId))
        throw new PageError(
          'This page conversation is being created. Retry shortly.',
          409,
        );
      const threadId = this.workspace.pages.thread(pageId, dotId)!.threadId;
      try {
        if (sdk)
          await bounded(
            sdk.getOrCreateThread({
              threadId,
              userId: this.workspace.ownerId,
              agentId: dotId,
              name: page.title,
            }),
          );
        if (!this.workspace.canAccessSpace(dotId, spaceId))
          throw new PageError('Space access has been revoked.');
        const thread =
          this.workspace.conversations().find((t) => t.id === threadId) ??
          this.workspace.bindThread(threadId, dotId, page.title);
        this.workspace.pages.finishThread(pageId, dotId);
        return thread;
      } catch (error) {
        this.workspace.pages.releaseThread(pageId, dotId);
        throw error;
      }
    })();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async saveConversation(
    threadId: string,
    title: string,
    parentId: string | null,
  ) {
    const thread = this.workspace.requireThread(threadId);
    const dot = this.workspace.dot(thread.dotId)!;
    const messages = this.useCodex()
      ? await bounded(this.codexMessages?.(threadId) ?? Promise.resolve([]))
      : (
          await bounded(
            this.intelligence().getThreadMessages({
              threadId,
              userId: this.workspace.ownerId,
            }),
          )
        ).messages;
    const chunks: string[] = [];
    for (const message of messages) {
      if (!['user', 'assistant'].includes(message.role)) continue;
      let text = '';
      if (typeof message.content === 'string') text = message.content;
      else if (Array.isArray(message.content)) {
        text = message.content
          .flatMap((part) =>
            part &&
            typeof part === 'object' &&
            'text' in part &&
            typeof part.text === 'string'
              ? [part.text]
              : [],
          )
          .join('\n');
      }
      if (text.trim())
        chunks.push(`## ${message.role === 'user' ? 'You' : 'Dot'}\n\n${text}`);
    }
    const content = chunks.join('\n\n');
    if (!content)
      throw new PageError('This conversation has no persisted text to save.');
    if (content.length > 100000)
      throw new PageError(
        'This conversation exceeds the 100,000 character page limit. Save a shorter conversation.',
      );
    const destination =
      this.workspace.pages.forThread(threadId)?.spaceId ?? dot.spaceId;
    if (!this.workspace.canAccessSpace(dot.id, destination))
      throw new PageError('Space access has been revoked.', 400);
    return this.workspace.pages.create(
      destination,
      { title, content, parentId },
      threadId,
    );
  }
}
