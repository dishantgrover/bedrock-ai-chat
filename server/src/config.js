/**
 * Runtime configuration, read once from the environment.
 *
 * Required values fail fast at boot rather than surfacing as confusing runtime
 * errors on the first request.
 */

/**
 * Reads a required environment variable.
 *
 * @param {string} name Variable name.
 * @returns {string} The value.
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** AWS region hosting Bedrock, DynamoDB and Cognito. */
export const REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * Region used for the `bedrock-mantle` endpoint, separate from the main Region.
 *
 * Grok is in-region only, with no geo or global inference profile, so a Region
 * having a bad day cannot be routed around automatically the way Claude's
 * profiles can. us-east-1 was observed timing out consistently while us-east-2
 * answered in about two seconds, so Mantle traffic is pinned separately and can
 * be moved without relocating the rest of the stack.
 */
export const MANTLE_REGION = process.env.MANTLE_REGION || REGION;

/** Port the HTTP server listens on. */
export const PORT = Number(process.env.PORT || 8080);

/** DynamoDB table holding conversations and messages. */
export const TABLE_NAME = required('TABLE_NAME');

/** Cognito user pool ID used to verify access tokens. */
export const COGNITO_USER_POOL_ID = required('COGNITO_USER_POOL_ID');

/** Cognito app client ID that tokens must be issued for. */
export const COGNITO_CLIENT_ID = required('COGNITO_CLIENT_ID');

/**
 * Second app client used by the Obsidian plugin. Optional, because the web app
 * works without it. Tokens are pinned to a client ID, so the plugin's client has
 * to be named here explicitly or its tokens are rejected.
 */
export const COGNITO_PLUGIN_CLIENT_ID = process.env.COGNITO_PLUGIN_CLIENT_ID || '';

/**
 * Origins permitted to call the API cross-origin.
 *
 * The Obsidian plugin needs this to stream. Obsidian's own HTTP helper bypasses
 * CORS but buffers the whole response, so streaming requires a real `fetch`,
 * which is subject to the browser's origin checks. These are the origins Obsidian
 * runs under: `app://obsidian.md` on desktop, and the two localhost forms used by
 * the mobile shells.
 *
 * Credentials are deliberately not allowed. Auth is a bearer token rather than a
 * cookie, so there is nothing for a hostile page to replay, and omitting
 * `Access-Control-Allow-Credentials` keeps it that way.
 */
export const CORS_ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ||
  'app://obsidian.md,capacitor://localhost,http://localhost'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Maximum number of prior messages replayed to the model. Caps the cost of a
 * long conversation, since every turn resends the history.
 */
export const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 40);

/** Maximum characters accepted in a single user message. */
export const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 32000);

/** Per-user rolling daily output-token budget. Bedrock itself has no spend cap. */
export const DAILY_TOKEN_BUDGET = Number(process.env.DAILY_TOKEN_BUDGET || 200000);

/** Directory of built frontend assets to serve, if present. */
export const STATIC_DIR = process.env.STATIC_DIR || '../web/dist';

/**
 * Shared secret that CloudFront attaches as a custom origin header.
 *
 * The security group restricts the origin to the CloudFront IP ranges, but that
 * managed prefix list covers *every* CloudFront distribution, including other
 * AWS customers'. Requiring a header only this distribution sends is what turns
 * that into a real restriction.
 *
 * Optional so local development works without it.
 */
export const ORIGIN_SECRET = process.env.ORIGIN_SECRET || '';

/** Header carrying the origin secret. */
export const ORIGIN_SECRET_HEADER = 'x-origin-secret';

/**
 * Interval between server-sent heartbeats while a model is thinking.
 *
 * CloudFront's origin read timeout is 30 seconds by default and 60 at most, and
 * a reasoning model can stay silent longer than that before its first token.
 * Without traffic on the connection CloudFront treats the origin as failed.
 * Heartbeats also stop mobile carrier proxies dropping an idle connection.
 */
export const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 10000);

/** System prompt applied to every conversation. */
export const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a helpful assistant. Use Markdown for formatting and fenced code blocks with a language tag for code.';
