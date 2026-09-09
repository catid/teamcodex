import { getConfigPath } from '@teamcodex/proxy/config';

export function showHelp(): void {
  console.log(`TeamCodex - Multi-account Codex proxy

Usage: teamcodex [command] [options]

Commands:
  serve               Start the proxy server (default)
  import              Import credentials from Codex CLI (~/.codex/auth.json)
  login               ChatGPT OAuth login (browser; auto device-code if headless)
  login --device-auth Device-code login (headless servers, no local browser)
  login --browser     Force the browser/localhost-callback flow
  login --api         Add an OpenAI API key account
  env                 Print a shell command for Codex (includes the proxy key)
  run [args...]       Run Codex through the proxy; args pass through to codex
                      (e.g. "teamcodex run resume", "teamcodex run <prompt>")
  smoke [--rotate]    Test a live hello; --rotate injects 429 in an isolated proxy
  status [--compact]  Show account health, token totals, and usage charts
  status --json       Print the complete status snapshot for scripts
  init                Create config and import existing Codex login if empty
  reset               Reset settings and proxy key; back up config, keep accounts
  accounts            List configured accounts
  remove <name>       Remove an account
  api <path>          Call an API endpoint with account credentials
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Credentials path (import, default: ~/.codex/auth.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"tokens":{"access_token":"...","refresh_token":"..."}}'
  --safe              Don't pass --dangerously-bypass-approvals-and-sandbox (run)
  --log-to DIR        Log full requests/responses to DIR (serve, one file per request)

Config: ${getConfigPath()}
`);
}
