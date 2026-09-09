# Working in TeamCodex

TeamCodex is a multi-account Codex HTTP proxy using strict TypeScript and Bun 1.4.2
with isolated workspaces. Follow [docs/typescript-migration.md](docs/typescript-migration.md)
for package boundaries and [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md)
for verified migration work.

Read [README.md](README.md) for commands, configuration, and installation. Read
[docs/development.md](docs/development.md) before changing account lifecycle,
proxy streaming/retries, persistence, or launchers; it maps the code and invariants.

Upstream implementation references are recorded in [docs/authentication.md](docs/authentication.md).

## Engineering rules

- Use conventional, descriptive names from the language, domain, or codebase.
  Avoid invented terminology and unnecessary verbosity; clarity takes priority over brevity.
- Register application errors in `packages/core/src/errors.ts` and run `bun run errors:generate`.
  Keep existing codes/opcodes stable; see [docs/errors.md](docs/errors.md).
- Use strict TypeScript with complete boundary contracts and inferred local types.
  Validate external data as `unknown`; avoid `any`, unsafe casts and suppressions.
- Keep dependency direction CLI → proxy → core, with explicit package exports and
  declared workspace dependencies. Use Bun's isolated linker and pinned runtime.
- Apply SOLID and KISS through cohesive responsibilities, simple functions and
  explicit I/O seams. Avoid speculative abstractions and cross-layer imports.
- Normalize configuration, account identity, quota and telemetry at boundaries;
  share typed contracts instead of duplicating loosely shaped objects.
- Keep IMPLEMENTATION_CHECKLIST.md current with verified completion and maintain
  a concise CHANGELOG.md under Unreleased (Added/Changed/Fixed as appropriate).
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

Install development tools with `bun install --frozen-lockfile`. Run `bun run check` for code changes and the Bash syntax
check for launcher/install-script changes. Documentation-only edits need link,
command, and diff review rather than a test-suite rerun.

```sh
bun run check
bash -n teamcodex.sh install.sh install-team-repos.sh run-team-servers.sh
```

For focused iteration, use `bun test packages/proxy/test/server.test.ts` (or the relevant test
file). Use fake credentials, local upstreams, and temporary config/auth directories,
following the workspace tests. Run the full suite before handing off code changes.

Keep Bash launchers compatible with macOS Bash 3.2 and Ubuntu. For container changes,
run the Docker checks in [docs/development.md](docs/development.md#verification).
Update README/help/config examples when changing their documented behavior.

Keep real credentials, auth files, and request logs out of patches and test fixtures.
`smoke` sends live upstream requests; it is separate from the local test suite.
