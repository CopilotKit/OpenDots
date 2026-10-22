import { toolDefinition } from '@tanstack/ai';
import {
  hostShellActionTool,
  hostShellExecSchema,
} from '../shared/host-shell-types.js';
import type { HostShellService } from './host-shell.js';

export function hostShellTools(
  service: HostShellService,
  dotId: string,
  threadId: string,
  check: () => void,
  approvals: boolean,
) {
  if (!service.available(dotId)) return [];
  return [
    toolDefinition({
      name: 'unsafe_host_shell_exec',
      description:
        'UNSAFE: request execution of a shell command on the OpenDots host server, not the isolated Dot computer. Disabled unless the server and this Dot both allow it. Every command requires owner approval before it runs. Use only for explicit development/operations tasks.',
      inputSchema: hostShellExecSchema,
    }).server((args) => {
      check();
      service.assertAvailable(dotId);
      const input = service.normalize(args);
      return approvals
        ? {
            status: 'approval_required',
            approvalId: service.store.createApproval({
              threadId,
              dotId,
              ...input,
            }),
            instruction: `Call ${hostShellActionTool.name} with this approvalId and a one-sentence summary. Then wait for the owner.`,
          }
        : {
            status: 'unavailable',
            message:
              'Unsafe host shell commands require owner approval in the OpenDots web app. Ask the owner to continue there.',
          };
    }),
  ];
}
