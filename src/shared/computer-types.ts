import { z } from 'zod';
export const computerPermissionsSchema = z
  .object({
    enabled: z.boolean(),
    browser: z.boolean(),
    files: z.boolean(),
    shell: z.boolean(),
  })
  .strict();
export type ComputerPermissions = z.infer<typeof computerPermissionsSchema>;
export interface ComputerAudit {
  id: string;
  action: string;
  actor: 'owner' | 'agent';
  outcome: 'pending' | 'succeeded' | 'failed';
  createdAt: number;
}
export interface ComputerControl {
  holder: 'bot' | 'human';
  requested: boolean;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  request?: { id: string; status: string };
}
export interface ComputerStatus {
  configured: boolean;
  state: 'not_configured' | 'stopped' | 'running' | 'unavailable';
  permissions: ComputerPermissions;
  audit: ComputerAudit[];
  control?: ComputerControl;
  // Set when the computer is a machine ploop reaches over SSH, e.g. `ploop@host over SSH`.
  link?: string;
  error?: string;
}
const path = z
  .string()
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      !p.split('/').some((s) => s === '..'),
    'Use a relative workspace path without traversal.',
  );
const empty = z.object({}).strict();
const ref = {
  ref: z.string().min(1).max(100),
  snapshotId: z.number().int().nonnegative(),
};
export const computerInputs = {
  navigate: z
    .object({
      url: z
        .string()
        .url()
        .max(2048)
        .refine(
          (s) =>
            ['http:', 'https:'].includes(new URL(s).protocol) &&
            !new URL(s).username &&
            !new URL(s).password,
        ),
    })
    .strict(),
  read: empty,
  snapshot: empty,
  screenshot: empty,
  click: z.object(ref).strict(),
  type: z
    .object({
      ...ref,
      text: z.string().max(16000),
      submit: z.boolean().optional(),
    })
    .strict(),
  key: z.object({ key: z.string().min(1).max(100) }).strict(),
  scroll: z
    .object({ deltaY: z.number().finite().min(-10000).max(10000) })
    .strict(),
  files_list: z.object({ path: path.default('') }).strict(),
  files_read: z.object({ path: path.refine((p) => p.length > 0) }).strict(),
  files_write: z
    .object({
      path: path.refine((p) => p.length > 0),
      contents: z.string().max(100000),
      append: z.boolean().optional(),
    })
    .strict(),
  exec: z
    .object({
      command: z.string().trim().min(1).max(8000),
      timeoutMs: z.number().int().min(1000).max(60000).default(30000),
    })
    .strict(),
  human_click: z
    .object({
      x: z.number().finite().min(0).max(16000),
      y: z.number().finite().min(0).max(16000),
    })
    .strict(),
  human_type: z.object({ text: z.string().max(16000) }).strict(),
  human_key: z.object({ key: z.string().min(1).max(100) }).strict(),
  human_scroll: z
    .object({ deltaY: z.number().finite().min(-10000).max(10000) })
    .strict(),
};
export type ComputerAction = keyof typeof computerInputs;
