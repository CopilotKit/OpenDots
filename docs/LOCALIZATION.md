# Interface localization

The interface ships in Brazilian Portuguese (`pt-BR`), English (`en`), Spanish (`es`), and French (`fr`). Keep user-facing strings in the matching locale files under `src/client/i18n/`, and access them through the typed `t()` helper in `src/client/i18n/index.ts`.

Translation keys are grouped by interface area. Keep all dictionaries aligned when adding keys, preserve product names and technical identifiers, and keep interpolation placeholders such as `{name}` identical. The selected language is saved in the browser.
