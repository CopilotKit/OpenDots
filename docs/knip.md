# Unused code and dependencies

Run Knip after installing dependencies, without needing a build or application credentials:

```sh
npm run knip
npm run knip:production
```

The default run includes application code, tests and development tooling. Production mode checks runtime sources without treating development-only consumers as production usage. CI initially uses `--no-exit-code` while existing findings are triaged in [issue #147](https://github.com/CopilotKit/OpenDots/issues/147). Configuration and execution failures still fail CI.

## Discovery and entrypoints

`knip.json` marks production entries and project patterns with a trailing `!`. The server, independent browser process and supervisor patch executed by Docker have explicit production entries. Vite discovers the client entry and theme script through `index.html` in both modes; avoid duplicating those entries.

Vite, Vitest, TypeScript, ESLint and Prettier integrations discover tooling and tests automatically. Playwright is a runtime dependency of the browser service, not an `@playwright/test` suite. Do not add every source or fixture as an entrypoint: this would hide unused files. Respect `.gitignore`; do not analyze generated builds, local databases, environment files or externally downloaded Docker sources.

When adding a runtime entrypoint, update discovery and verify both modes:

```sh
npm run knip -- --debug
npm run knip:production -- --debug
```

## Triage

1. Correct missing entrypoints, plugin configuration and resolution before deleting code or adding exceptions.
2. Review unused files, then dependencies, then exports/types. Use `--files`, `--dependencies` or `--exports` to focus the report; rerun the complete analysis after each batch.
3. Check HTML, Docker, scripts, lazy imports, filesystem access and test subprocesses for consumers the static graph may not capture.
4. Before removing packages, check required peers, global types, configuration, CLI usage and runtime installs. Packages such as `@tiptap/pm`, `@types/*`, PostCSS and Playwright can be necessary without a direct application import.
5. For an export used only within its own file, remove the export modifier, not the implementation. Preserve callbacks and framework/SDK entry conventions.
6. A production-only finding does not establish that code is unused in tests/tooling. Preserve legitimate development usage and justify any mode-specific treatment.

Do not use broad autofix, global exports/types exclusions, blanket directory ignores or issue-count budgets to hide real findings. Any exception must identify its precise file/category/dependency, explain its legitimate use here, and state when it can be removed. Keep sanitized findings and the cleanup decisions in issue #147, not generated reports in commits.

After each cleanup, run both Knip modes and the existing formatter, lint, typecheck, tests and build. Reviewers should verify the evidence for removals rather than accepting the report alone.
