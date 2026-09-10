# Changelog

## [Unreleased]

### Added
- Weighted and adaptive account pools, bounded admission, and routing/reset mock tests.
- Shared terminal panels and offline browser/device OAuth coverage.

### Changed
- Migrated application, tests and tooling to strict TypeScript workspaces with CLI → proxy → core boundaries.
- Pinned Bun 1.4.2 with isolated installs, native PTY screenshots, and Bun Docker/CI execution.

### Fixed
- Transient retries prefer untried pool members.
- Usage reset responses and retries validate current account identity.
- Accounts recover when additional quota windows regain capacity; reset outcomes preserve usage totals.
- Preserved upstream credential, routing, reset-disable and terminal hardening through the migration.
- Fixed clean-install compiler API resolution for ESLint declarations.
