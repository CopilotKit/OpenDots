import { z } from 'zod';
export const pageReviewSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    content: z.string().min(1).max(20000),
    spaceId: z.string().min(1),
  })
  .strict();
export const pageReviewTool = {
  name: 'review_space_page',
  description:
    'Present a Markdown draft for human review before saving it into an authorized Space. The user can approve and save, or decline. Do not create the page yourself after this tool: its approved result includes the saved page URL. Call once, then wait for the review result.',
  parameters: z.toJSONSchema(pageReviewSchema),
};
