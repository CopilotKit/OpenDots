export interface TeamMessage {
  id: string;
  dotId: string | null;
  text: string;
  createdAt: number;
  kind?: 'response' | 'evidence' | 'guidance';
}
export interface TeamBoard {
  id: string;
  objective: string;
  originThreadId?: string;
  participants: string[];
  leadId: string;
  rounds: number;
  mode?: 'discussion' | 'improvement' | 'workflow';
  steps?: TeamStep[];
  developerId?: string;
  reviewIds?: string[];
  guidance?: string;
  activeDotId?: string | null;
  turns: number;
  status:
    | 'running'
    | 'decided'
    | 'completed'
    | 'awaiting_review'
    | 'blocked'
    | 'stopped';
  decision: string | null;
  error: string | null;
  threads: Record<string, string>;
  messages: TeamMessage[];
  createdAt: number;
}

export interface TeamStep {
  id: string;
  assigneeId: string;
  task: string;
  acceptance: string;
  status: 'pending' | 'running' | 'review' | 'completed' | 'blocked';
  attempts: number;
  reportPending?: boolean;
  receiptStart?: number;
  continuationPending?: boolean;
  checkpoints?: Array<{
    completed: string;
    remaining: string;
    nextAction: string;
    receiptId: string;
  }>;
  result?: string;
  evidence?: string;
  feedback?: string;
}
