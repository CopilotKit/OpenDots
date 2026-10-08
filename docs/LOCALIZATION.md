# Interface localization

The interface currently ships in Brazilian Portuguese (`pt-BR`). Keep user-facing strings in `src/client/i18n/pt-BR.ts` and access them through the typed `t()` helper instead of adding translated copy directly to components.

Translation keys are grouped by interface area (`nav`, `pages`, `tasks`, `chat`, and `dialogs`). Prefer short, descriptive keys and preserve product names, environment variable names, and technical identifiers. Format dates with the `pt-BR` locale.

When adding another locale in the future, keep the same key structure so components can switch dictionaries without changing their copy. Update this document and the document language metadata when the default locale changes.
