import { requestUrl } from 'obsidian';

import type { Backend, CompletionRequest, CompletionResult } from '../types';

/**
 * Anthropic's own Messages API, using an `x-api-key`.
 *
 * This works from a plugin because Obsidian's `requestUrl` issues the call
 * outside the renderer's origin, so Anthropic's browser CORS restrictions do not
 * apply. A plain `fetch` from the renderer would be blocked.
 */
export class AnthropicBackend implements Backend {
  readonly label: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
  ) {
    this.label = `Anthropic · ${modelId}`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = JSON.stringify({
      model: this.modelId,
      max_tokens: request.maxTokens,
      // Like Converse, the system prompt is a top-level field here.
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    const response = await requestUrl({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        // Required; the API rejects requests without a pinned version.
        'anthropic-version': '2023-06-01',
      },
      body,
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(describeAnthropicError(response.status, response.text));
    }

    const payload = response.json;
    const content: string = (payload?.content ?? [])
      .filter((block: { type?: string }) => block.type === 'text')
      .map((block: { text?: string }) => block.text ?? '')
      .join('');

    return {
      content,
      inputTokens: payload?.usage?.input_tokens ?? 0,
      outputTokens: payload?.usage?.output_tokens ?? 0,
    };
  }
}

/** Maps the common Anthropic failures onto actionable wording. */
function describeAnthropicError(status: number, text: string): string {
  let message = text;
  try {
    message = JSON.parse(text)?.error?.message ?? text;
  } catch {
    // Leave the raw body in place.
  }

  if (status === 401) {
    return `Anthropic rejected the API key. (${message})`;
  }
  if (status === 404) {
    return `Unknown model. Check the model ID against Anthropic's docs. (${message})`;
  }
  if (status === 429) {
    return `Rate limited or out of credit. (${message})`;
  }
  return `Anthropic returned ${status}: ${message}`;
}
