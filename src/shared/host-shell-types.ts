import { z } from 'zod';

export const hostShellExecSchema = z
  .object({
    command: z.string().trim().min(1).max(8000),
    cwd: z.string().trim().min(1).max(2048).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  })
  .strict();

export interface HostShellActionResult {
  isError: boolean;
  text: string;
}

export interface PendingHostShellApproval {
  id: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  expiresAt: number;
}

export const HOST_SHELL_APPROVAL_TTL_MS = 60 * 60_000;

export const hostShellActionSchema = z
  .object({
    approvalId: z.string().min(1).max(64),
    summary: z.string().trim().min(1).max(500),
  })
  .strict();

export const hostShellActionTool = {
  name: 'request_host_shell_action',
  description:
    'Ask the owner to approve an unsafe host shell command. Use only after unsafe_host_shell_exec returns approval_required. Pass its approvalId and a one-sentence summary of the command effect. Call once, then wait; never retry another way unless the owner declines and explicitly asks you to revise.',
  parameters: z.toJSONSchema(hostShellActionSchema),
};
