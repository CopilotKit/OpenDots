import type { WebConfig } from './parallel.js';
import type { SteeringInbox } from './steering.js';
import type { McpTools } from './mcp-tools.js';
import type { ModelRegistry } from './models.js';
import type { MemoryIndex } from './memory-index.js';
import type { SkillStore } from './skills.js';
import type { TeamBoardService } from './team-board.js';
import type { DevWorkspace } from './dev-workspace.js';
import type { Dot } from '../shared/types.js';
export type Delegate = (request: {
  fromDot: Dot;
  parentThreadId: string;
  specialist: string;
  task: string;
  depth: number;
  signal: AbortSignal;
}) => Promise<string>;
import type { SetupStatus } from '../shared/types.js';
export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
  mcp?: McpTools;
  models?: ModelRegistry;
  memory?: MemoryIndex;
  skills?: SkillStore;
  teamBoard?: TeamBoardService;
  dev?: DevWorkspace;
  delegate?: Delegate;
  /** Owner messages for running unattended tasks, by conversation. */
  steering?: SteeringInbox;
  /** Names of the owner-taught buttons on the shared browser's current page. */
  browserTargets?: () => Promise<string[]>;
  /** The owner's mapped sites (Obsidian site maps), as one line for a Dot. */
  siteMaps?: () => Promise<string>;
  /** Visible text of the shared browser's current page. */
  browserText?: () => Promise<string | undefined>;
  /** The trading session's start, peak and locked (trailing-stop) balance. */
  tradingSession?: () => {
    time?: number;
    start?: number;
    peak?: number;
    locked?: number | null;
  };
  /** Current page of the shared browser, if it is running. */
  browserPage?: () => Promise<{ url: string; title: string } | undefined>;
  runTimeoutMs?: number;
  /** Maximum model/tool cycles in one turn; exhaustion is an explicit error. */
  maxAgentIterations?: number;
  maxOutputTokens?: number;
  /** Model context size (OLLAMA_CONTEXT_LENGTH) and tokens kept free for instructions, tools and the answer. */
  contextTokens?: number;
  reservedTokens?: number;
}
// Local-only: a model identifier is the only requirement. Local servers such
// as Ollama accept any API key, so a placeholder is used when none is set.
// Slack channels require the CopilotKit cloud and are disabled here.
export function setupStatus(config: PlatformConfig): SetupStatus {
  const missing = [!config.model && 'OPENAI_MODEL'].filter(
    (item): item is string => !!item,
  );
  const slack = 'not_configured';
  return {
    intelligence: false,
    model: !!config.model,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack,
    missing,
  };
}
