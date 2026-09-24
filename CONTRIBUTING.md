# Contributing to BunjiBox

Thanks for helping. BunjiBox is an alpha, so small, focused fixes are easiest
to review. Open an issue to discuss a large feature before building it.

## Set up

Use a supported macOS host and Node.js 22.18 or newer. Install dependencies
with `npm ci`.
Run `npm run api` and `npm run dev` in separate terminals for the web app, or
`npm run bunji` for the CLI. Sign in with `codex login` or `claude auth login`
to try a provider. See the [README](README.md) for the native app and other
providers. No provider login is needed for most unit tests.

## Make a change

1. Check existing issues and keep the pull request focused on one change.
2. Add or update tests when behavior changes. Run `npm test`, `npm run lint`,
   `npm run typecheck`, and `npm run build` before opening a pull request.
3. Explain the problem, your fix, and how you checked it. Include screenshots
   for UI changes and note any setup needed to reproduce them. Use the
   [screenshot guide](docs/screenshots.md) when updating the README or site images.

The npm workspace layout is in the README. Apps live in `apps/`; reusable code
lives in `packages/`. Keep provider code and stored data in the shared runtime
instead of making another copy in a client. [docs/architecture.md](docs/architecture.md)
explains how the pieces fit together.

## TypeScript

Everything outside `experiments/` and the Swift app is TypeScript. Node runs
`.ts` files directly with its built-in type stripping, so there is no build
step for the server, CLI, or packages; `npm run typecheck` runs `tsc` without
emitting anything. That imposes a few rules:

- Only erasable syntax: no `enum`, `namespace`, or constructor parameter
  properties. `tsconfig.base.json` enforces this.
- Relative imports in Node code include the `.ts` extension. Vite apps may
  keep extensionless imports.
- Import types with `import type`.
- Shapes that cross the HTTP boundary belong in `packages/shared/src/types.ts`.

Do not commit API keys, workspace databases, logs, or personal chat history.
Use a throwaway `BUNJI_DATA_DIR` when testing data migrations. Report security
issues through the process in [SECURITY.md](SECURITY.md), not a public issue.

Please be respectful in issues and reviews. Assume good intent, discuss the
work, and give contributors room to disagree.
