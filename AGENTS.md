# Working in TeamCodex

TeamCodex is a multi-account Codex HTTP proxy. It uses plain JavaScript ES modules
and Node.js 22.13+ (or 24+), with no runtime dependencies or build step. Keep changes consistent
with the existing `node:` APIs, two-space indentation, single quotes, and semicolons.

Read [README.md](README.md) for commands, configuration, and installation. Read
[docs/development.md](docs/development.md) before changing account lifecycle,
proxy streaming/retries, persistence, or launchers; it maps the code and invariants.

Upstream implementation references are recorded in [docs/authentication.md](docs/authentication.md).

## Engineering rules

- Use conventional, descriptive names from the language, domain, or codebase.
  Avoid invented terminology and unnecessary verbosity; clarity takes priority over brevity.
- Register application errors in `src/errors.js` and run `npm run errors:generate`.
  Keep existing codes/opcodes stable; see [docs/errors.md](docs/errors.md).
- Always prefer full type coverage. Use JSDoc for parameters, return values, and
  data contracts where inference is insufficient. Avoid `any` and suppressions that
  hide errors; validate external data at boundaries. Keep typing changes scoped.
- Design for testability: make relevant I/O, time, and state controllable in tests
  without adding abstractions solely for mocking. Test observable behavior.
- Keep files and functions cohesive and easy to navigate. Split mixed responsibilities
  or code that is difficult to test or understand, not merely long. No fixed line
  limits: avoid arbitrary fragmentation and keep refactoring scoped to the task.
- Use TDD for behavior changes and bug fixes: failing test, smallest correct change,
  then refactor. Documentation and formatting changes need no new tests; pure
  refactors should preserve behavior under existing coverage.
- When repeated attempts fail without new evidence, investigate before another fix.
  Search the web or GitHub for relevant documentation, issues, and fixes; verify
  applicability to the version and failure. Do not share secrets in searches.
- For API integration work, verify the relevant contract against official docs or
  the target schema, and always inspect relevant vendor source when published.
  Match the deployed version where possible; reuse verified findings while they
  remain applicable. Report unavailable evidence or unresolved discrepancies rather
  than inventing behavior, and verify uncertain assumptions with focused tests.

## Checks

Install development tools with `npm ci`. Run `npm run check` for code changes and the Bash syntax
check for launcher/install-script changes. Documentation-only edits need link,
command, and diff review rather than a test-suite rerun.

```sh
npm run check
bash -n teamcodex.sh install.sh install-team-repos.sh run-team-servers.sh
```

For focused iteration, use `node --test test/server.test.js` (or the relevant test
file). Use fake credentials, local upstreams, and temporary config/auth directories,
following `test/`. Run the full suite before handing off code changes.

Keep Bash launchers compatible with macOS Bash 3.2 and Ubuntu. For container changes,
run the Docker checks in [docs/development.md](docs/development.md#verification).
Update README/help/config examples when changing their documented behavior.

Keep real credentials, auth files, and request logs out of patches and test fixtures.
`smoke` sends live upstream requests; it is separate from the local test suite.
