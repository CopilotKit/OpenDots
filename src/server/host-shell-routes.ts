import { Hono } from 'hono';
import { z } from 'zod';
import {
  HOST_SHELL_APPROVAL_TTL_MS,
  hostShellActionSchema,
  type PendingHostShellApproval,
} from '../shared/host-shell-types.js';
import type { WorkspaceStore } from './workspace.js';
import type { HostShellService } from './host-shell.js';

export function hostShellRoutes(
  workspace: WorkspaceStore,
  hostShell: HostShellService,
) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'Invalid host shell request.')
            : error.message,
      },
      400,
    ),
  );

  const approvalFor = (threadId: string, approvalId: string) => {
    const approval = workspace.hostShell.approval(approvalId);
    if (!approval || approval.threadId !== threadId)
      throw new Error('Host shell approval request not found.');
    if (Date.now() - approval.createdAt > HOST_SHELL_APPROVAL_TTL_MS)
      throw new Error(
        'This host shell approval request expired. Ask the Dot to try again.',
      );
    hostShell.assertAvailable(approval.dotId);
    return approval;
  };

  app.get('/conversations/:id/host-shell-approvals/:approvalId', (c) => {
    const thread = workspace.requireThread(c.req.param('id'));
    const approval = approvalFor(thread.id, c.req.param('approvalId'));
    return c.json({
      id: approval.id,
      command: approval.command,
      cwd: approval.cwd,
      timeoutMs: approval.timeoutMs,
      expiresAt: approval.createdAt + HOST_SHELL_APPROVAL_TTL_MS,
    } satisfies PendingHostShellApproval);
  });

  app.get('/conversations/:id/host-shell-actions/:toolCallId', (c) => {
    const thread = workspace.requireThread(c.req.param('id'));
    return c.json(
      workspace.hostShell.action(thread.id, c.req.param('toolCallId')) ?? null,
    );
  });

  app.post('/conversations/:id/host-shell-actions', async (c) => {
    const body = hostShellActionSchema
      .omit({ summary: true })
      .extend({ toolCallId: z.string().min(1).max(200) })
      .parse(await c.req.json());
    const thread = workspace.requireThread(c.req.param('id'));
    const recovered = () => {
      const previous = workspace.hostShell.action(thread.id, body.toolCallId);
      if (!previous) return undefined;
      if (previous.approvalId !== body.approvalId)
        return c.json(
          { error: 'This action belongs to a different host shell approval request.' },
          409,
        );
      return previous.result
        ? c.json(previous.result)
        : c.json({ error: 'This host shell action is already running.' }, 409);
    };
    const earlier = recovered();
    if (earlier) return earlier;
    const approval = approvalFor(thread.id, body.approvalId);
    const claimed = workspace.hostShell.actionForApproval(approval.id);
    if (claimed && claimed.toolCallId !== body.toolCallId)
      return c.json(
        { error: 'This host shell approval request already ran its stored action.' },
        409,
      );
    if (!workspace.hostShell.claimAction(thread.id, body.toolCallId, approval.id))
      return recovered()!;
    const result = await hostShell.execute({
      command: approval.command,
      cwd: approval.cwd,
      timeoutMs: approval.timeoutMs,
    });
    workspace.hostShell.finishAction(thread.id, body.toolCallId, result);
    return c.json(result);
  });

  return app;
}
