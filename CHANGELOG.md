# Changelog

## [Unreleased]

### Added
- Weighted and adaptive account pools, bounded admission, and routing/reset mock tests.
- Shared terminal panels and offline browser/device OAuth coverage.

### Changed
- Moved proxy policy, HTTP streaming, authentication, usage tracking and terminal UI into TypeScript workspaces.
- Pinned Bun 1.4.2 with isolated installs and compiler checks.

### Fixed
- Transient retries prefer untried pool members.
- Usage reset responses and retries validate current account identity.
