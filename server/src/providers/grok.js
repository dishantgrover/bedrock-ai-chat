/**
 * Grok streaming via the OpenAI-compatible `bedrock-mantle` endpoint.
 *
 * Two details differ from a plain OpenAI deployment:
 *
 *  1. Authentication uses a short-lived bearer token derived from IAM
 *     credentials rather than a static API key, so the client is rebuilt when
 *     the cached token rotates.
 *  2. Grok is a reasoning model and reasoning tokens are drawn from the same
 *     output budget as the answer. Too small a `max_completion_tokens` returns
 *     an empty message, so the cap is kept generous.
 */
import OpenAI from 'openai';

import { MANTLE_REGION } from '../config.js';
import { getMantleToken, invalidateMantleToken } from '../mantleToken.js';

const BASE_URL = `https://bedrock-mantle.${MANTLE_REGION}.api.aws/openai/v1`;

/** @type {{ token: string, client: OpenAI }|null} */
let cachedClient = null;

/**
 * Returns an OpenAI client bound to the current bearer token, rebuilding it when
 * the token has rotated.
 *
 * @returns {Promise<OpenAI>} Configured client.
 */
async function getClient() {
  // The bearer token is signed for the same Region as the endpoint it is sent
  // to; a token signed for another Region is rejected.
  const token = await getMantleToken(MANTLE_REGION);
  if (!cachedClient || cachedClient.token !== token) {
    cachedClient = {
      token,
      client: new OpenAI({
        apiKey: token,
        baseURL: BASE_URL,
        maxRetries: 1,
        timeout: 300_000,
      }),
    };
  }
  return cachedClient.client;
}

/**
 * Streams a Grok completion.
 *
 * @param {Object} params
 * @param {import('../models.js').ModelDefinition} params.model Model definition.
 * @param {Array<{role: 'user'|'assistant', content: string}>} params.messages Conversation history.
 * @param {string} [params.systemPrompt] Optional system instruction.
 * @param {AbortSignal} [params.signal] Abort signal for client disconnects.
 * @returns {AsyncGenerator<Object>} Normalised stream events.
 */
export async function* streamGrok({ model, messages, systemPrompt, signal }) {
  const body = {
    model: model.modelId,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    max_completion_tokens: model.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  /**
   * Opens the stream, retrying once on an authentication failure.
   *
   * The bearer token is a presigned URL bounded by the signing credentials, so a
   * credential rotation can invalidate it earlier than the cached expiry
   * predicts. Discarding the cached token and re-signing recovers immediately;
   * without this the failure would persist for the life of the cache entry.
   */
  const openStream = async () => {
    try {
      const client = await getClient();
      return await client.chat.completions.create(body, { signal });
    } catch (error) {
      if (error?.status !== 401) {
        throw error;
      }
      invalidateMantleToken(MANTLE_REGION);
      cachedClient = null;
      const client = await getClient();
      return client.chat.completions.create(body, { signal });
    }
  };

  const stream = await openStream();

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    if (delta?.content) {
      yield { type: 'text', value: delta.content };
    }

    // Mantle surfaces the reasoning trace on a non-standard field. Read it
    // defensively so a shape change degrades to "no reasoning shown" rather
    // than throwing.
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      yield { type: 'reasoning', value: reasoning };
    }

    if (chunk.usage) {
      yield {
        type: 'usage',
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }
  }
}
