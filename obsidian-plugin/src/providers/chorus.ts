import { requestUrl } from 'obsidian';

import type { Backend, CompletionRequest, CompletionResult } from '../types';

/** Persists the vault's conversation ID so the same thread is reused. */
export interface ConversationStore {
  get(): string;
  set(conversationId: string): Promise<void>;
}

/**
 * A self-hosted Chorus deployment, authenticated with Cognito.
 *
 * This is the only backend that keeps no credentials in the vault beyond a
 * username and password: AWS keys stay on the Chorus server. It is also the only
 * backend where history lives server-side, so each turn sends just the new
 * message and the server replays the thread. One Chorus conversation is created
 * per vault and reused, which is exactly the one-chat-per-vault model.
 *
 * The reply arrives as Server-Sent Events. `requestUrl` cannot stream, so the
 * whole SSE body is buffered and parsed once complete.
 */
export class ChorusBackend implements Backend {
  readonly label: string;

  private accessToken = '';
  private tokenExpiresAt = 0;

  constructor(
    private readonly options: {
      baseUrl: string;
      region: string;
      clientId: string;
      username: string;
      password: string;
      modelId: string;
    },
    private readonly conversations: ConversationStore,
  ) {
    this.label = `Chorus · ${options.modelId}`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const token = await this.token();
    const conversationId = await this.conversationId(token);

    // Only the newest turn is sent; the server holds the rest of the thread.
    const latest = request.messages[request.messages.length - 1];
    if (!latest || latest.role !== 'user') {
      throw new Error('Expected the last message to be from the user.');
    }

    if (request.onDelta) {
      const streamed = await this.streamTurn(
        conversationId,
        token,
        latest.content,
        request.onDelta,
      );
      if (streamed) return streamed;
      // Null means streaming was refused before the request was accepted, so
      // nothing reached the model and falling back cannot duplicate the turn.
    }

    // Note the path: conversations are managed under /api/conversations, but
    // sending a turn is /api/chat/<id>/messages. Anything else under /api falls
    // through to a catch-all 404.
    const response = await requestUrl({
      url: `${this.base()}/api/chat/${conversationId}/messages`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content: latest.content }),
      throw: false,
    });

    if (response.status === 401) {
      // Force a fresh login next time rather than looping on a stale token.
      this.accessToken = '';
      throw new Error('Chorus rejected the session. Check the username and password.');
    }
    if (response.status === 404) {
      // Only discard the stored conversation when the server actually says the
      // conversation is missing. A 404 from a mistyped path would otherwise throw
      // away good state and silently create a fresh conversation on every send.
      const missingConversation = /conversation not found/i.test(response.text);
      if (missingConversation) {
        await this.conversations.set('');
        throw new Error(
          'That conversation no longer exists. Send the message again to start a new one.',
        );
      }
      throw new Error(
        `Chorus returned 404 for ${this.base()}/api/chat/... — check the base URL. (${response.text.slice(0, 160)})`,
      );
    }
    if (response.status !== 200) {
      throw new Error(`Chorus returned ${response.status}: ${response.text.slice(0, 300)}`);
    }

    return parseSse(response.text);
  }

  /**
   * Streams a turn with `fetch`, reporting text as it arrives.
   *
   * Obsidian's `requestUrl` cannot stream, so this uses the platform `fetch`,
   * which means the server must allow this origin via CORS. When it does not,
   * `fetch` rejects before any request is delivered and this returns null so the
   * caller can fall back to the buffered path.
   *
   * A failure *after* the response starts is rethrown rather than falling back.
   * The server persists a turn once the model has answered, so a retry would
   * duplicate it.
   *
   * @returns The completed reply, or null if streaming is unavailable.
   */
  private async streamTurn(
    conversationId: string,
    token: string,
    content: string,
    onDelta: (text: string) => void,
  ): Promise<CompletionResult | null> {
    const url = `${this.base()}/api/chat/${conversationId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({ content }),
      });
    } catch {
      // Almost always CORS or offline. Either way nothing was sent.
      return null;
    }

    if (!response.ok || !response.body) {
      // Let the buffered path produce the error, so status handling lives in one
      // place instead of being duplicated here.
      return null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffered = '';
    let content_ = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let failure = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffered += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. A frame can be split across reads,
      // so only whole ones are consumed and the remainder is carried forward.
      const frames = buffered.split('\n\n');
      buffered = frames.pop() ?? '';

      for (const frame of frames) {
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (!event || !data) continue;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }

        if (event === 'delta' && typeof payload.text === 'string') {
          content_ += payload.text;
          onDelta(payload.text);
        } else if (event === 'done') {
          inputTokens = Number(payload.inputTokens ?? 0);
          outputTokens = Number(payload.outputTokens ?? 0);
        } else if (event === 'error') {
          failure = String(payload.message ?? 'The model request failed.');
        }
      }
    }

    // A partial reply is worth keeping, so only fail when nothing arrived.
    if (failure && !content_) throw new Error(failure);

    return { content: content_, inputTokens, outputTokens };
  }

  /** Base URL without a trailing slash, so path joins stay predictable. */
  private base(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  /** Returns a valid access token, logging in again shortly before expiry. */
  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const response = await requestUrl({
      url: `https://cognito-idp.${this.options.region}.amazonaws.com/`,
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: this.options.clientId,
        AuthParameters: {
          USERNAME: this.options.username,
          PASSWORD: this.options.password,
        },
      }),
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(describeCognitoError(response.text));
    }

    const result = response.json?.AuthenticationResult;
    if (!result?.AccessToken) {
      // A NEW_PASSWORD_REQUIRED challenge lands here, among others.
      const challenge = response.json?.ChallengeName;
      throw new Error(
        challenge
          ? `Cognito needs the "${challenge}" challenge completed. Sign in through the Chorus web app once first.`
          : 'Cognito did not return an access token.',
      );
    }

    this.accessToken = result.AccessToken;
    this.tokenExpiresAt = Date.now() + (result.ExpiresIn ?? 3600) * 1000;
    return this.accessToken;
  }

  /** Reuses the vault's conversation, creating it on first use. */
  private async conversationId(token: string): Promise<string> {
    const existing = this.conversations.get();
    if (existing) return existing;

    const response = await requestUrl({
      url: `${this.base()}/api/conversations`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ modelId: this.options.modelId }),
      throw: false,
    });

    if (response.status !== 201 && response.status !== 200) {
      throw new Error(
        `Could not create a Chorus conversation (${response.status}): ${response.text.slice(0, 300)}`,
      );
    }

    const id = response.json?.id ?? response.json?.conversation?.id;
    if (!id) throw new Error('Chorus did not return a conversation ID.');

    await this.conversations.set(id);
    return id;
  }
}

/**
 * Reassembles a buffered SSE stream into one reply.
 *
 * Frames look like `event: delta\ndata: {"text":"..."}`. The terminating `done`
 * frame carries the token counts, and an `error` frame means the turn failed even
 * though the HTTP status was 200.
 *
 * @param raw Complete SSE body.
 * @returns The assembled reply and its usage.
 */
function parseSse(raw: string): CompletionResult {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let failure = '';

  for (const frame of raw.split('\n\n')) {
    const event = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    if (!event || !data) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    if (event === 'delta' && typeof payload.text === 'string') {
      content += payload.text;
    } else if (event === 'done') {
      inputTokens = Number(payload.inputTokens ?? 0);
      outputTokens = Number(payload.outputTokens ?? 0);
    } else if (event === 'error') {
      failure = String(payload.message ?? 'The model request failed.');
    }
  }

  // A partial reply is still worth keeping, so only fail when nothing arrived.
  if (failure && !content) throw new Error(failure);

  return { content, inputTokens, outputTokens };
}

/** Cognito reports failures as a JSON `__type`, which is not user-facing wording. */
function describeCognitoError(text: string): string {
  let type = '';
  let message = text;
  try {
    const parsed = JSON.parse(text);
    type = parsed?.__type ?? '';
    message = parsed?.message ?? text;
  } catch {
    // Fall through with the raw body.
  }

  if (type.includes('NotAuthorizedException')) {
    return 'Cognito rejected the username or password.';
  }
  if (type.includes('UserNotFoundException')) {
    return 'That Cognito user does not exist.';
  }
  if (type.includes('InvalidParameterException') && /USER_PASSWORD_AUTH/i.test(message)) {
    return 'This app client does not allow password auth. Use the client ID created for the plugin.';
  }
  return `Cognito error: ${message}`;
}
