import { z } from 'zod';
export const pageReviewSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    content: z.string().min(1).max(20000),
    spaceId: z.string().min(1),
    pageId: z.string().min(1).nullish(),
    expectedRevision: z.number().int().positive().nullish(),
  })
  .strict();
export type PageReviewDraft = z.infer<typeof pageReviewSchema>;
export const pageReviewTool = {
  name: 'review_space_page',
  description:
    'Present a Markdown draft for human review before saving it into an authorized Space. To revise an existing page instead of creating a new one, pass its pageId and the expectedRevision from read_space_page; approving then updates that page in place. The user can approve and save, or decline. Do not create the page yourself after this tool: its approved result includes the saved page URL. Call once, then wait for the review result.',
  parameters: z.toJSONSchema(pageReviewSchema),
};
