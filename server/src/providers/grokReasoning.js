/**
 * Grok via the OpenAI-compatible Responses API on `bedrock-mantle`.
 *
 * Kept separate from the Chat Completions adapter rather than replacing it. The
 * two differ in what they can carry between turns, and Mantle has proven flaky
 * enough that keeping the simpler path available is worth the duplication.
 *
 * Why this exists: Chat Completions has nowhere to put reasoning, so Grok
 * re-derives its thinking from its own conclusions on every turn. The Responses
 * API returns reasoning as a first-class item that can be replayed, giving the
 * model its own prior thinking back.
 *
 * What it does *not* do is show that reasoning. Verified against the live
 * endpoint: `summary` is accepted as `auto`, `detailed` and `concise` and returns
 * zero parts every time, `content` is empty, and retrieving a stored response
 * with `include: ['reasoning.content']` returns nothing either. Only
 * `encrypted_content` is populated. The trace is opaque by design, so there is
 * no reasoning to display and none is emitted.
 *
 * Runs stateless (`store: false`): the conversation stays in our own table rather
 * than being retained by the service, and continuity comes from replaying the
 * encrypted item.
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
 * Converts stored history into Responses API input items.
 *
 * An assistant turn is emitted as up to two items: its reasoning item first, then
 * the message, matching the order the API produces them. The reasoning item is
 * replayed verbatim because the service validates it; reconstructing it from
 * parts risks rejection if the shape changes.
 *
 * @param {Array<{role: string, content: string, reasoningItem?: Object}>} messages History.
 * @returns {Array<Object>} Input items.
 */
function toInputItems(messages) {
  const items = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.reasoningItem) {
        items.push(message.reasoningItem);
      }
      // An assistant turn with no text (a failed or empty reply) contributes
      // nothing beyond its reasoning.
      if (message.content) {
        items.push({ role: 'assistant', content: message.content });
      }
      continue;
    }

    items.push({ role: 'user', content: message.content });
  }

  return items;
}

/**
 * Streams a Grok completion with reasoning continuity.
 *
 * @param {Object} params
 * @param {import('../models.js').ModelDefinition} params.model Model definition.
 * @param {Array<Object>} params.messages Conversation history.
 * @param {string} [params.systemPrompt] Optional system instruction.
 * @param {AbortSignal} [params.signal] Abort signal for client disconnects.
 * @returns {AsyncGenerator<Object>} Normalised stream events.
 */
export async function* streamGrokReasoning({ model, messages, systemPrompt, signal }) {
  const body = {
    model: model.modelId,
    input: toInputItems(messages),
    // Kept at low deliberately. Reasoning tokens bill as output and dominate the
    // total -- a trivial prompt measured 213 reasoning tokens out of 235 output
    // -- so higher effort is the most expensive knob available.
    reasoning: { effort: model.reasoningEffort ?? 'low' },
    include: ['reasoning.encrypted_content'],
    store: false,
    max_output_tokens: model.maxOutputTokens,
    stream: true,
  };

  if (systemPrompt) {
    body.instructions = systemPrompt;
  }

  /**
   * Opens the stream, retrying once on an authentication failure.
   *
   * The bearer token is a presigned URL bounded by its signing credentials, so a
   * rotation can invalidate it earlier than the cached expiry predicts.
   */
  const openStream = async () => {
    try {
      const client = await getClient();
      return await client.responses.create(body, { signal });
    } catch (error) {
      if (error?.status !== 401) {
        throw error;
      }
      invalidateMantleToken(MANTLE_REGION);
      cachedClient = null;
      const client = await getClient();
      return client.responses.create(body, { signal });
    }
  };

  const stream = await openStream();

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      if (event.delta) {
        yield { type: 'text', value: event.delta };
      }
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const response = event.response ?? {};

      // Captured so the next turn can hand the model its own prior thinking
      // back. Emitted verbatim rather than reassembled.
      const reasoningItem = response.output?.find((item) => item.type === 'reasoning');
      if (reasoningItem?.encrypted_content) {
        yield { type: 'reasoningItem', value: reasoningItem };
      }

      if (response.usage) {
        yield {
          type: 'usage',
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
        };
      }
      continue;
    }

    // A failed response arrives as an event rather than a thrown error, so it
    // has to be surfaced explicitly or the turn would look empty but successful.
    if (event.type === 'response.failed') {
      const message = event.response?.error?.message || 'Grok reported a failed response';
      throw new Error(message);
    }
  }
}
