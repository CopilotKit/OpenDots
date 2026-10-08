import type { Page } from '../server/pages';
import { t } from './i18n/pt-BR';
export type PageContext = Pick<Page, 'id' | 'spaceId' | 'title'>;
export function contextualMessage(
  text: string,
  context: PageContext | null | undefined,
) {
  if (context === undefined) throw new Error(t('notices.contextNotLoaded'));
  return context
    ? `From [${context.title.replace(/[[\]\\\r\n]/g, '')}](/#/spaces/${context.spaceId}/pages/${context.id}):\n\n${text}`
    : text;
}
