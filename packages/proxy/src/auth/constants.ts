// OAuth config (matches the Codex CLI's registered client)
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OAUTH_ISSUER = 'https://auth.openai.com';
export const OAUTH_AUTHORIZE = `${OAUTH_ISSUER}/oauth/authorize`;
export const OAUTH_TOKEN = `${OAUTH_ISSUER}/oauth/token`;
// Matches the Codex CLI's authorize request exactly
export const OAUTH_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
// The Codex client only allows localhost:1455 as a redirect URI
export const OAUTH_CALLBACK_PORT = 1455;

