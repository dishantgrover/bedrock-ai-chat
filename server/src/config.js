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

/** Port the HTTP server listens on. */
export const PORT = Number(process.env.PORT || 8080);

/** DynamoDB table holding conversations and messages. */
export const TABLE_NAME = required('TABLE_NAME');

/** Cognito user pool ID used to verify access tokens. */
export const COGNITO_USER_POOL_ID = required('COGNITO_USER_POOL_ID');

/** Cognito app client ID that tokens must be issued for. */
export const COGNITO_CLIENT_ID = required('COGNITO_CLIENT_ID');

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

/** System prompt applied to every conversation. */
export const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a helpful assistant. Use Markdown for formatting and fenced code blocks with a language tag for code.';
