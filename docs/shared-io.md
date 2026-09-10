# Shared I/O

`@teamcodex/shared` owns provider-independent HTTP and filesystem mechanisms.
It depends on the runtime, not core, proxy or CLI. Proxy and CLI declare it as a
workspace dependency; tooling uses the root dependency. Core remains pure and
currently needs no I/O dependency. Add reusable pure contracts to shared when
multiple packages actually need them, without creating a dependency cycle.

## API client

`ApiClient<TRequest, TResponse, TContext, TError>` accepts an adapter and an
optional transport. The adapter encodes the input/context into an HTTP request,
decodes and validates the response, and maps an unknown failure to its error
contract. The transport defaults to the current `globalThis.fetch`, allowing
preloads and mocks to intercept requests without captured stale references.
TypeScript does not have typed Promise rejections: `TError` constrains the mapper,
while callers still narrow caught values from `unknown`.

The OAuth code exchange is a concrete typed adapter:
`ApiClient<CodeExchange, Credentials, { redirectUri: string }, unknown>`.
It validates PKCE input before sending and validates token fields before returning
credentials. Existing vendor contracts remain those recorded in
[authentication.md](authentication.md).

`httpClient` and `createHttpClient(transport)` specialize the same client for raw
HTTP requests/responses. Forwarding, refresh, device polling, usage/reset requests,
CLI diagnostics and local service calls use this path. Raw responses retain
status, headers and unconsumed bodies, including non-2xx responses. Callers own
body consumption/cancellation, redirect policy, deadlines, retries and provider
identity checks. The shared client never retries a redemption or replays a stream.

## Filesystem

Import filesystem primitives through `@teamcodex/shared/filesystem`. Shared also
owns the mechanisms previously repeated by configuration, history and host auth:

- `atomicWrite`: exclusive temporary file, restrictive default mode, same-directory
  rename and cleanup, with optional directory creation and a precommit predicate.
- `replaceFileIfMatching`: checks expected file content and current live identity
  before replacing host auth. This remains an optimistic check; an uncooperative
  external writer can race between the check and rename.
- `withFileLock`: exclusive directory lock around cooperating local transactions,
  preserving the 10-second deadline and 25ms retry interval.
- `readTextFile`: reads a regular file within a caller-selected byte limit.

Config schemas, account matching, cooldown decisions and history aggregation stay
in their owning domain modules. Config calls shared locking around the complete
read/modify/write operation; moving the lock does not shorten that transaction.
Application errors still come from core and are supplied to generic helpers by
callers. No provider-specific errors or credentials are embedded in shared.

All TypeScript application/tooling filesystem access uses this boundary. Standalone
mock executables and Docker permission probes deliberately use native filesystem
calls to validate the operating system independently. Bash/Python host scripts
retain their native filesystem APIs; they do not import TypeScript workspaces.

## Verification

Shared tests cover adapter encoding/validation, failure mapping, response ownership,
atomic replacement, permissions, cleanup, stale-login protection, lock exclusion
and bounded reads. Existing proxy and CLI tests cover persistence races, reset
idempotency and stream/retry behavior through the client. `bun run check` includes
shared; both Dockerfiles copy its manifest/source, and the Ubuntu image runs its
tests. ESLint enforces shared independence and the filesystem import boundary.
