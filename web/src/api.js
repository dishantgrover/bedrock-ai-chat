/**
 * API client. Every authenticated call attaches a fresh Cognito access token.
 */
import { getAccessToken } from './auth.js';

/**
 * Performs an authenticated JSON request.
 *
 * @param {string} path API path, e.g. `/api/conversations`.
 * @param {RequestInit} [options] Fetch options.
 * @returns {Promise<any>} Parsed JSON, or null for 204 responses.
 */
async function request(path, options = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new AuthExpiredError();
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    throw new AuthExpiredError();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

/** Raised when the session is gone and the user must sign in again. */
export class AuthExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'AuthExpiredError';
  }
}

/**
 * Fetches public app configuration. Unauthenticated.
 *
 * @returns {Promise<Object>} Region, pool IDs and the model list.
 */
export async function fetchConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) {
    throw new Error('Could not load app configuration');
  }
  return response.json();
}

/** @returns {Promise<Object>} Current user and today's token usage. */
export function fetchMe() {
  return request('/api/me');
}

/** @returns {Promise<Array<Object>>} The user's conversations, newest first. */
export async function listConversations() {
  const { conversations } = await request('/api/conversations');
  return conversations;
}

/**
 * Creates a conversation pinned to a model.
 *
 * @param {string} modelId Model registry key.
 * @returns {Promise<Object>} The new conversation.
 */
export async function createConversation(modelId) {
  const { conversation } = await request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
  });
  return conversation;
}

/**
 * Loads a conversation and its messages.
 *
 * @param {string} id Conversation UUID.
 * @returns {Promise<{conversation: Object, messages: Array<Object>}>} Thread.
 */
export function getConversation(id) {
  return request(`/api/conversations/${id}`);
}

/**
 * Renames a conversation.
 *
 * @param {string} id Conversation UUID.
 * @param {string} title New title.
 * @returns {Promise<Object>} Updated conversation.
 */
export function renameConversation(id, title) {
  return request(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

/**
 * Deletes a conversation and its messages.
 *
 * @param {string} id Conversation UUID.
 * @returns {Promise<null>} Resolves when deleted.
 */
export function deleteConversation(id) {
  return request(`/api/conversations/${id}`, { method: 'DELETE' });
}

/**
 * Sends a message and consumes the streamed reply.
 *
 * Uses fetch with a ReadableStream rather than EventSource, because EventSource
 * cannot send an Authorization header or use POST.
 *
 * @param {Object} params
 * @param {string} params.conversationId Conversation UUID.
 * @param {string} params.content User message.
 * @param {AbortSignal} params.signal Signal for the stop button.
 * @param {(text: string) => void} params.onDelta Called with each text chunk.
 * @param {(payload: Object) => void} [params.onDone] Called when the turn ends.
 * @param {(message: string) => void} [params.onError] Called on a server-side error.
 * @returns {Promise<void>} Resolves when the stream closes.
 */
export async function streamMessage({
  conversationId,
  content,
  signal,
  onDelta,
  onDone,
  onError,
}) {
  const token = await getAccessToken();
  if (!token) {
    throw new AuthExpiredError();
  }

  const response = await fetch(`/api/chat/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content }),
    signal,
  });

  if (response.status === 401) {
    throw new AuthExpiredError();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Keep the trailing partial frame
    // in the buffer until its terminator arrives.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const eventMatch = frame.match(/^event: (.+)$/m);
      const dataMatch = frame.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;

      let payload;
      try {
        payload = JSON.parse(dataMatch[1]);
      } catch {
        continue;
      }

      switch (eventMatch[1]) {
        case 'delta':
          onDelta(payload.text);
          break;
        case 'done':
          onDone?.(payload);
          break;
        case 'error':
          onError?.(payload.message);
          break;
        default:
          break;
      }
    }
  }
}
