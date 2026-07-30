/**
 * Claude streaming via the `bedrock-runtime` ConverseStream API.
 */
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';

import { REGION } from '../config.js';

const client = new BedrockRuntimeClient({ region: REGION });

/**
 * Streams a Claude completion.
 *
 * Yields events in the shape shared by all providers so the route layer does not
 * branch on transport:
 *   `{ type: 'text', value }`
 *   `{ type: 'reasoning', value }`
 *   `{ type: 'usage', inputTokens, outputTokens }`
 *
 * @param {Object} params
 * @param {import('../models.js').ModelDefinition} params.model Model definition.
 * @param {Array<{role: 'user'|'assistant', content: string}>} params.messages Conversation history.
 * @param {string} [params.systemPrompt] Optional system instruction.
 * @param {AbortSignal} [params.signal] Abort signal for client disconnects.
 * @returns {AsyncGenerator<Object>} Normalised stream events.
 */
export async function* streamClaude({ model, messages, systemPrompt, signal }) {
  const command = new ConverseStreamCommand({
    modelId: model.modelId,
    messages: messages.map((message) => ({
      role: message.role,
      content: [{ text: message.content }],
    })),
    ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
    inferenceConfig: {
      maxTokens: model.maxOutputTokens,
      temperature: 1,
    },
  });

  const response = await client.send(command, { abortSignal: signal });

  for await (const event of response.stream ?? []) {
    // Converse streams reasoning and text as separate delta shapes. Claude does
    // not emit reasoning with this config, but handle it so enabling extended
    // thinking later does not silently drop content.
    const delta = event.contentBlockDelta?.delta;
    if (delta?.text) {
      yield { type: 'text', value: delta.text };
    }
    if (delta?.reasoningContent?.text) {
      yield { type: 'reasoning', value: delta.reasoningContent.text };
    }

    if (event.metadata?.usage) {
      yield {
        type: 'usage',
        inputTokens: event.metadata.usage.inputTokens ?? 0,
        outputTokens: event.metadata.usage.outputTokens ?? 0,
      };
    }
  }
}
