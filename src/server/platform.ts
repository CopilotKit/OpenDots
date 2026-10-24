import { ComputerService } from './computer-service.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runLocalTurn } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { SqliteAgentRunner } from './local-runner.js';
import { ModelRegistry } from './models.js';
import { MemoryIndex } from './memory-index.js';
import { SkillStore } from './skills.js';
import { TeamBoardService, TeamBoardStore } from './team-board.js';
import { teamToolEvidence } from './team-execution.js';
import { DevWorkspace } from './dev-workspace.js';
import { recordDeveloperChange } from './dev-changelog.js';
import { existsSync } from 'node:fs';
import { starterTeam } from './team.js';
import { LiveBrowser } from './browser-live.js';
import { SteeringInbox } from './steering.js';
// Local-only platform: the CopilotKit runtime runs in SSE mode and conversation
// history lives in the workspace SQLite database. No Intelligence cloud service.
export class Platform {
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly runner: SqliteAgentRunner;
  readonly models: ModelRegistry;
  readonly memory: MemoryIndex;
  readonly skills: SkillStore;
  readonly teamBoard: TeamBoardService;
  readonly dev: DevWorkspace;
  readonly browser: LiveBrowser;
  readonly steering = new SteeringInbox();
  readonly handler?: CopilotHonoApp;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    readonly databasePath = ':memory:',
  ) {
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.runner = new SqliteAgentRunner(databasePath);
    const ollama = config.baseUrl.replace(/\/v1\/?$/, '');
    this.models = new ModelRegistry(workspace, config.model, config.baseUrl);
    this.memory = new MemoryIndex(
      databasePath,
      ollama,
      process.env.EMBED_MODEL || 'nomic-embed-text',
    );
    this.browser = new LiveBrowser(undefined, undefined, config.mcp);
    config.browserTargets = () => this.browser.targetNames();
    config.siteMaps = () => this.browser.siteMaps();
    // Owner messages sent to a running task reach it after its current step.
    config.steering = this.steering;
    config.browserText = () => this.browser.pageText();
    config.tradingSession = () => this.browser.tradingSession();
    // The local tools halve the stake limit once the balance is below this.
    config.browserPage = async () => {
      const status = await this.browser.status();
      return status.running ? status : undefined;
    };
    config.models = this.models;
    this.skills = new SkillStore(databasePath, (texts) =>
      this.memory.embed(texts),
    );
    this.dev = new DevWorkspace(process.cwd(), databasePath);
    // Every Developer change, in the Developer section of the owner's vault.
    const vault =
      process.env.OPENDOTS_VAULT ?? 'C:/Users/inter/Desktop/MainAINotes';
    if (databasePath !== ':memory:' && existsSync(vault))
      this.dev.onChange = (review, event) =>
        recordDeveloperChange(vault, review, event);
    config.dev = this.dev;
    config.memory = this.memory;
    config.skills = this.skills;
    config.delegate = (request) => this.delegate(request);
    workspace.seedTeam(starterTeam);
    this.teamBoard = new TeamBoardService(
      new TeamBoardStore(databasePath),
      async (board, dotId, prompt, signal) => {
        const threadId = board.threads[dotId];
        if (!workspace.conversations().some((thread) => thread.id === threadId))
          workspace.bindThread(
            threadId,
            dotId,
            `Team: ${board.objective.slice(0, 60)}`,
          );
        return runLocalTurn(
          this.runner,
          new DotAgent(
            store,
            workspace,
            board.mode === 'improvement' && dotId !== board.developerId
              ? { ...config, dev: undefined }
              : config,
            dotId,
            false,
            2,
            board.id,
          ),
          threadId,
          `OpenDots project root: ${this.dev.repo}. Use this path for requests about this app unless the owner names another project. This does not grant additional filesystem access.\nParticipants: ${workspace
            .dots()
            .filter((dot) => board.participants.includes(dot.id))
            .map(
              (dot) =>
                `${dot.name} (${dot.id}): ${dot.instructions.slice(0, 250)}`,
            )
            .join('\n')}\n\n${prompt}`,
          signal,
          { opendotsSource: 'team_board', boardId: board.id },
          (messages) => {
            const evidence = teamToolEvidence(messages);
            if (evidence) this.teamBoard.evidence(board.id, dotId, evidence);
          },
        );
      },
      (ids, developerId) => {
        this.requireReady();
        if (store.settings().paused) throw new Error('OpenDots is paused.');
        if (ids.some((id) => !workspace.dot(id)))
          throw new Error('A participant Dot no longer exists.');
        if (
          developerId &&
          !workspace.dot(developerId)?.toolGroups?.includes('developer')
        )
          throw new Error(
            'The assigned Developer needs the Code changes capability.',
          );
      },
      (threadId) =>
        this.dev
          .reviews()
          .filter(
            (review) =>
              review.sourceThreadId === threadId &&
              review.passed &&
              review.status !== 'rejected',
          ),
    );
    config.teamBoard = this.teamBoard;
    // Index finished turns into long-term memory in the background.
    this.runner.onPersist = (threadId, messages) => {
      // Shared board narratives are not independent evidence. Indexing them
      // makes a teammate's memory search echo the same unsupported claims.
      if (
        this.teamBoard.store
          .list()
          .some((board) => Object.values(board.threads).includes(threadId))
      )
        return;
      const thread = workspace.conversations().find((t) => t.id === threadId);
      if (thread)
        void this.memory
          .indexConversation(threadId, thread.title, messages)
          .catch((error) =>
            console.warn('Memory indexing skipped:', String(error)),
          );
    };
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async ({ threadId }) => ({
          messages: this.runner.getThreadMessages(threadId),
        }),
      };
    });
    const runtime = new CopilotRuntime({
      runner: this.runner,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'OpenDots owner',
      }),
      agents: async () =>
        Object.fromEntries(
          workspace
            .dots()
            .map((dot) => [
              dot.id,
              new DotAgent(store, workspace, config, dot.id),
            ]),
        ),
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(this.config);
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}. Point OPENAI_BASE_URL at a local model server such as Ollama.`,
      );
  }
  async start() {}
  async stop() {
    await this.teamBoard.shutdown();
    await this.browser.close();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    return this.workspace.bindThread(randomUUID(), dotId, title);
  }
  /** Threads with a reply in progress, so the chat list can show them. */
  async runningConversations(): Promise<string[]> {
    const ids = this.workspace.conversations().map((thread) => thread.id);
    const running = await Promise.all(
      ids.map((threadId) => this.runner.isRunning({ threadId })),
    );
    return ids.filter((_, index) => running[index]);
  }
  /** Stop a conversation's run if one is going, then remove it and its history. */
  async deleteConversation(threadId: string) {
    this.workspace.requireThread(threadId);
    if (await this.runner.isRunning({ threadId }))
      await this.runner.stop({ threadId });
    this.steering.drain(threadId);
    this.runner.forget(threadId);
    this.workspace.unbindThread(threadId);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    return this.runner
      .getThreadMessages(threadId)
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    if (!this.handler)
      return Response.json({ error: 'Runtime unavailable.' }, { status: 503 });
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  /** Runs a task on another Dot in a sub-conversation linked to the parent. */
  async delegate({
    fromDot,
    parentThreadId,
    specialist,
    task,
    depth,
    signal,
  }: Parameters<NonNullable<PlatformConfig['delegate']>>[0]): Promise<string> {
    const wanted = specialist.trim().toLowerCase();
    const dot = this.workspace
      .dots()
      .find((d) => d.id === specialist || d.name.toLowerCase() === wanted);
    if (!dot || dot.id === fromDot.id)
      throw new Error(
        `No specialist named "${specialist}". Available: ${this.workspace
          .dots()
          .filter((d) => d.id !== fromDot.id)
          .map((d) => d.name)
          .join(', ')}.`,
      );
    let threadId = this.workspace.delegationThread(parentThreadId, dot.id);
    if (!threadId || (await this.runner.isRunning({ threadId }))) {
      threadId = randomUUID();
      this.workspace.bindThread(
        threadId,
        dot.id,
        `${fromDot.name} → ${dot.name}: ${task.slice(0, 60)}`,
      );
      this.workspace.bindDelegation(parentThreadId, dot.id, threadId);
    }
    return runLocalTurn(
      this.runner,
      new DotAgent(
        this.store,
        this.workspace,
        this.config,
        dot.id,
        false,
        depth,
      ),
      threadId,
      `Task from ${fromDot.name}:
${task}`,
      signal,
    );
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    return runLocalTurn(
      this.runner,
      new DotAgent(this.store, this.workspace, this.config, thread.dotId),
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
