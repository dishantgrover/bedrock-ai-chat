/**
 * Streaming chat endpoint.
 *
 * Accepts a user message, replays the stored conversation to the selected model,
 * relays the response to the browser as Server-Sent Events, and persists the
 * result. The model is fixed per conversation, so the client cannot switch models
 * mid-thread and produce inconsistent history.
 */
import { Router } from 'express';

import {
  DAILY_TOKEN_BUDGET,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  SSE_HEARTBEAT_MS,
  SYSTEM_PROMPT,
} from '../config.js';
import { findModel } from '../models.js';
import { streamClaude } from '../providers/claude.js';
import { streamGrok } from '../providers/grok.js';
import { streamGrokReasoning } from '../providers/grokReasoning.js';
import {
  addUsage,
  appendMessage,
  getConversation,
  getUsageToday,
  listMessages,
  renameConversation,
} from '../store.js';

export const chatRouter = Router();

/** Maps a transport to its streaming implementation. */
const STREAMERS = {
  bedrock: streamClaude,
  mantle: streamGrok,
  'mantle-responses': streamGrokReasoning,
};

/**
 * Derives a conversation title from the first user message.
 *
 * @param {string} text First message.
 * @returns {string} Trimmed title.
 */
function deriveTitle(text) {
  const firstLine = text.trim().split('\n')[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || 'New chat';
}

/**
 * Writes one SSE frame.
 *
 * @param {import('express').Response} res Response.
 * @param {string} event Event name.
 * @param {Object} data Payload, JSON-encoded.
 */
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Writes an SSE comment. Comments are valid frames that carry no event, so
 * clients ignore them, which makes them ideal keep-alive traffic.
 *
 * @param {import('express').Response} res Response.
 * @param {string} note Comment text.
 */
function sendComment(res, note) {
  res.write(`: ${note}\n\n`);
}

chatRouter.post('/:conversationId/messages', async (req, res) => {
  const { conversationId } = req.params;
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

  if (!content) {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    res.status(413).json({ error: `Message exceeds ${MAX_MESSAGE_CHARS} characters` });
    return;
  }

  const conversation = await getConversation(req.user.id, conversationId);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const model = findModel(conversation.modelId);
  if (!model) {
    res.status(409).json({ error: 'Conversation uses a model that is no longer available' });
    return;
  }

  const usedToday = await getUsageToday(req.user.id);
  if (usedToday >= DAILY_TOKEN_BUDGET) {
    res.status(429).json({ error: 'Daily token budget reached. Try again tomorrow.' });
    return;
  }

  const history = await listMessages(conversationId);
  const isFirstExchange = history.length === 0;

  // Trim to the most recent turns so cost does not grow without bound.
  //
  // `reasoningItem` is carried through for transports that can replay it. The
  // others map role and content explicitly, so the extra field is ignored rather
  // than leaking into their request bodies.
  const replay = [...history, { role: 'user', content }]
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content: text, reasoningItem }) => ({ role, content: text, reasoningItem }));

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Put a byte on the wire immediately. CloudFront starts its origin read
  // timeout as soon as the request is forwarded, and a reasoning model can stay
  // silent past that window before producing its first token.
  sendComment(res, 'open');

  // Abort the upstream Bedrock call if the browser goes away, so a closed tab
  // does not keep burning tokens.
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());

  // Keep the connection warm during model silence. Reset on every real chunk so
  // heartbeats only appear in genuine gaps.
  let heartbeat = null;
  const scheduleHeartbeat = () => {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      if (!res.writableEnded) {
        sendComment(res, 'ping');
        scheduleHeartbeat();
      }
    }, SSE_HEARTBEAT_MS);
  };
  const stopHeartbeat = () => clearTimeout(heartbeat);
  scheduleHeartbeat();

  let answer = '';
  let reasoning = '';
  let reasoningItem;
  let inputTokens = 0;
  let outputTokens = 0;
  let persisted = false;

  /**
   * Writes the turn to storage: the user's message, then the reply.
   *
   * Deferred until the model has produced something, so a failed turn leaves no
   * trace. Persisting the question up front meant every retry stored another
   * copy of it with no answer, and those copies were then replayed to the model
   * on later turns.
   *
   * Guarded by a flag because both the success and abort paths call it.
   */
  const persistTurn = async () => {
    if (persisted) {
      return;
    }
    persisted = true;

    await appendMessage({ userId: req.user.id, conversation, role: 'user', content });
    await appendMessage({
      userId: req.user.id,
      conversation,
      role: 'assistant',
      content: answer,
      reasoning: reasoning || undefined,
      reasoningItem,
      inputTokens,
      outputTokens,
    });

    // Titled from the question, so this has to wait for the question to exist.
    if (isFirstExchange) {
      await renameConversation({
        userId: req.user.id,
        conversation,
        title: deriveTitle(content),
      });
    }
  };

  try {
    const streamer = STREAMERS[model.transport];
    const stream = streamer({
      model,
      messages: replay,
      systemPrompt: SYSTEM_PROMPT,
      signal: abortController.signal,
    });

    for await (const event of stream) {
      scheduleHeartbeat();

      if (event.type === 'text') {
        answer += event.value;
        sendEvent(res, 'delta', { text: event.value });
      } else if (event.type === 'reasoning') {
        reasoning += event.value;
        sendEvent(res, 'reasoning', { text: event.value });
      } else if (event.type === 'reasoningItem') {
        // Kept server-side only. It is an opaque encrypted blob with no display
        // value, and sending it to the browser would just inflate the stream.
        reasoningItem = event.value;
      } else if (event.type === 'usage') {
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
      }
    }

    if (answer.length > 0 || reasoning.length > 0) {
      await persistTurn();
    }

    if (outputTokens > 0) {
      await addUsage(req.user.id, outputTokens);
    }

    sendEvent(res, 'done', {
      conversationId,
      title: conversation.title,
      inputTokens,
      outputTokens,
      // Tells the client whether the turn survived, so it can drop an
      // optimistically rendered message that was never stored.
      persisted,
    });
    res.end();
  } catch (error) {
    if (abortController.signal.aborted) {
      // Stop button or a closed tab. Keep a partial reply, since the user saw it
      // and the tokens are already paid for.
      if (answer.length > 0) {
        await persistTurn();
        if (outputTokens > 0) {
          await addUsage(req.user.id, outputTokens);
        }
      }
      res.end();
      return;
    }

    console.error('chat stream failed', {
      conversationId,
      modelId: model.id,
      persisted,
      message: error?.message,
    });

    // A partial reply is worth keeping; a failure with nothing produced leaves
    // the conversation exactly as it was.
    if (answer.length > 0) {
      await persistTurn();
      if (outputTokens > 0) {
        await addUsage(req.user.id, outputTokens);
      }
    }

    // Headers are already sent, so the error has to travel as an SSE event.
    sendEvent(res, 'error', {
      message: 'The model request failed. Please try again.',
      persisted,
    });
    res.end();
  } finally {
    // Without this a completed request would leave a timer holding the process
    // awake and writing to a closed socket.
    stopHeartbeat();
  }
});
