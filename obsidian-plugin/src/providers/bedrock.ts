import { requestUrl } from 'obsidian';

import type { Backend, CompletionRequest, CompletionResult } from '../types';
import { signPost } from './sigv4';
import type { AwsCredentials } from './sigv4';

/**
 * Amazon Bedrock via the Converse API, signed locally with SigV4.
 *
 * Converse is used rather than each vendor's native payload because it gives one
 * request and response shape across every Bedrock model, so switching model IDs
 * needs no code change.
 *
 * Note that Claude 4.x models have no on-demand throughput and must be addressed
 * through an inference profile: a `global.` or `us.` prefixed model ID. A bare
 * model ID fails with a ValidationException, which is why the default carries the
 * prefix.
 */
export class BedrockBackend implements Backend {
  readonly label: string;

  constructor(
    private readonly region: string,
    private readonly modelId: string,
    private readonly credentials: AwsCredentials,
  ) {
    this.label = `Bedrock · ${modelId}`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const url =
      `https://bedrock-runtime.${this.region}.amazonaws.com/model/` +
      `${encodeURIComponent(this.modelId)}/converse`;

    const body = JSON.stringify({
      messages: request.messages.map((message) => ({
        role: message.role,
        content: [{ text: message.content }],
      })),
      // Converse expects the system prompt as its own field, not a message.
      ...(request.systemPrompt ? { system: [{ text: request.systemPrompt }] } : {}),
      inferenceConfig: { maxTokens: request.maxTokens },
    });

    const headers = await signPost({
      url,
      body,
      region: this.region,
      service: 'bedrock',
      credentials: this.credentials,
    });

    const response = await requestUrl({
      url,
      method: 'POST',
      headers,
      body,
      // Errors are handled below so the API's own message can be surfaced.
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(describeBedrockError(response.status, response.text));
    }

    const payload = response.json;
    const content: string = (payload?.output?.message?.content ?? [])
      .map((block: { text?: string }) => block.text ?? '')
      .join('');

    return {
      content,
      inputTokens: payload?.usage?.inputTokens ?? 0,
      outputTokens: payload?.usage?.outputTokens ?? 0,
    };
  }
}

/**
 * Turns a Bedrock failure into something a user can act on. The raw messages are
 * unhelpful on their own, and the two most common causes here are a model that
 * needs an inference profile and a key without Bedrock access.
 */
function describeBedrockError(status: number, text: string): string {
  let message = text;
  try {
    message = JSON.parse(text)?.message ?? text;
  } catch {
    // Not JSON; the raw body is the best available detail.
  }

  if (status === 403) {
    return `Bedrock denied the request. Check the key has bedrock:InvokeModel and that the model is enabled in this region. (${message})`;
  }
  if (status === 400 && /on-demand throughput|inference profile/i.test(message)) {
    return `This model needs an inference profile. Prefix the model ID with "global." or "us.". (${message})`;
  }
  if (status === 404) {
    return `Model not found in ${'this region'}. Check the model ID and region. (${message})`;
  }
  return `Bedrock returned ${status}: ${message}`;
}
