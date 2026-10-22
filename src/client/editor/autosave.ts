import type { Page } from '../../server/pages';
export type PageDraft = Pick<Page, 'title' | 'content' | 'parentId'>;
export type SaveState = {
  page?: Page;
  draft?: PageDraft;
  remote?: Page;
  status: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
  error?: string;
};
export type SavePage = (
  id: string,
  patch: PageDraft & { expectedRevision: number },
  signal: AbortSignal,
) => Promise<Page>;
const fields = (page: Page): PageDraft => ({
  title: page.title,
  content: page.content,
  parentId: page.parentId,
});
const equal = (a: PageDraft, b: PageDraft) =>
  a.title === b.title && a.content === b.content && a.parentId === b.parentId;
export class PageAutosave {
  private state: SaveState = { status: 'saved' };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private pending?: Promise<boolean>;
  private generation = 0;
  constructor(private save: SavePage) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<SaveState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private get changed() {
    return !!(
      this.state.page &&
      this.state.draft &&
      !equal(fields(this.state.page), this.state.draft)
    );
  }
  get dirty() {
    return (
      !!this.pending ||
      this.changed ||
      ['error', 'conflict'].includes(this.state.status)
    );
  }
  receive(page: Page) {
    if (this.state.page?.id !== page.id) {
      this.generation++;
      clearTimeout(this.timer);
      this.controller?.abort();
      this.pending = undefined;
      this.publish({
        page,
        draft: fields(page),
        remote: page,
        status: 'saved',
        error: undefined,
      });
      return;
    }
    if (page.revision <= (this.state.remote?.revision ?? 0)) return;
    if (this.pending) {
      this.publish({ remote: page });
      return;
    }
    if (this.changed || this.state.status === 'conflict') {
      clearTimeout(this.timer);
      this.publish({
        remote: page,
        status: 'conflict',
        error:
          'This page changed elsewhere. Your draft is safe. Copy it before loading the latest version.',
      });
    } else
      this.publish({
        page,
        remote: page,
        draft: fields(page),
        status: 'saved',
        error: undefined,
      });
  }
  edit(patch: Partial<PageDraft>) {
    if (!this.state.draft) return;
    this.publish({ draft: { ...this.state.draft, ...patch } });
    if (['error', 'conflict'].includes(this.state.status)) return;
    this.publish({
      status: this.pending ? 'saving' : this.changed ? 'dirty' : 'saved',
      error: undefined,
    });
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (
      this.changed &&
      !this.pending &&
      !['error', 'conflict'].includes(this.state.status)
    )
      this.timer = setTimeout(() => void this.flush(), 800);
  }
  async flush(retry = false): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.pending) {
      await this.pending;
      return this.changed ? this.flush(retry) : this.state.status === 'saved';
    }
    if (!this.state.page || !this.state.draft) return false;
    if (
      this.state.status === 'conflict' ||
      (this.state.status === 'error' && !retry)
    )
      return false;
    if (!this.changed && this.state.status !== 'error') {
      this.publish({ status: 'saved', error: undefined });
      return true;
    }
    const page = this.state.page,
      draft = { ...this.state.draft },
      generation = this.generation;
    if (
      !draft.title.trim() ||
      draft.title.length > 160 ||
      draft.content.length > 100000
    ) {
      this.publish({
        status: 'error',
        error:
          'Use a title up to 160 characters and a document up to 100,000 characters. Your draft is still here.',
      });
      return false;
    }
    this.controller = new AbortController();
    const controller = this.controller;
    this.publish({ status: 'saving', error: undefined });
    const pending = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.save(
            page.id,
            { ...draft, expectedRevision: page.revision },
            controller.signal,
          ),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              controller.abort();
              reject(
                new Error(
                  'Saving timed out. Your draft is safe; retry when connected.',
                ),
              );
            }, 10000);
          }),
        ]);
        if (generation !== this.generation) return false;
        const unchanged = equal(this.state.draft!, draft);
        const remote =
          this.state.remote && this.state.remote.revision > result.revision
            ? this.state.remote
            : result;
        this.publish({
          page: result,
          remote,
          draft: unchanged ? fields(result) : this.state.draft,
        });
        this.publish({
          status:
            remote.revision > result.revision
              ? 'conflict'
              : this.changed
                ? 'dirty'
                : 'saved',
          error:
            remote.revision > result.revision
              ? 'A newer revision exists. Your draft is preserved.'
              : undefined,
        });
        return this.state.status !== 'conflict';
      } catch (error) {
        if (generation !== this.generation) return false;
        const conflict =
          error &&
          typeof error === 'object' &&
          'status' in error &&
          error.status === 409;
        this.publish({
          status: conflict ? 'conflict' : 'error',
          error: conflict
            ? 'This page changed elsewhere. Your draft is safe. Copy it before loading the latest version.'
            : error instanceof Error
              ? error.message
              : 'Could not save. Your draft is safe.',
        });
        return false;
      } finally {
        clearTimeout(deadline);
        if (generation === this.generation) {
          this.pending = undefined;
          this.publish({});
          this.schedule();
        }
      }
    })();
    this.pending = pending;
    const success = await pending;
    if (success && generation === this.generation && this.changed)
      return this.flush(retry);
    return success;
  }
  useLatest() {
    const page = this.state.remote;
    if (!page) return;
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.pending = undefined;
    this.publish({
      page,
      draft: fields(page),
      remote: page,
      status: 'saved',
      error: undefined,
    });
  }
  dispose() {
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.pending = undefined;
    this.listeners.clear();
  }
}
