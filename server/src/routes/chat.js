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
  SYSTEM_PROMPT,
} from '../config.js';
import { findModel } from '../models.js';
import { streamClaude } from '../providers/claude.js';
import { streamGrok } from '../providers/grok.js';
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

  await appendMessage({
    userId: req.user.id,
    conversation,
    role: 'user',
    content,
  });

  if (history.length === 0) {
    await renameConversation({
      userId: req.user.id,
      conversation,
      title: deriveTitle(content),
    });
  }

  // Trim to the most recent turns so cost does not grow without bound.
  const replay = [...history, { role: 'user', content }]
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content: text }) => ({ role, content: text }));

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Abort the upstream Bedrock call if the browser goes away, so a closed tab
  // does not keep burning tokens.
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());

  let answer = '';
  let reasoning = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const streamer = STREAMERS[model.transport];
    const stream = streamer({
      model,
      messages: replay,
      systemPrompt: SYSTEM_PROMPT,
      signal: abortController.signal,
    });

    for await (const event of stream) {
      if (event.type === 'text') {
        answer += event.value;
        sendEvent(res, 'delta', { text: event.value });
      } else if (event.type === 'reasoning') {
        reasoning += event.value;
        sendEvent(res, 'reasoning', { text: event.value });
      } else if (event.type === 'usage') {
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
      }
    }

    if (answer.length > 0 || reasoning.length > 0) {
      await appendMessage({
        userId: req.user.id,
        conversation,
        role: 'assistant',
        content: answer,
        reasoning: reasoning || undefined,
        inputTokens,
        outputTokens,
      });
    }

    if (outputTokens > 0) {
      await addUsage(req.user.id, outputTokens);
    }

    sendEvent(res, 'done', {
      conversationId,
      title: conversation.title,
      inputTokens,
      outputTokens,
    });
    res.end();
  } catch (error) {
    if (abortController.signal.aborted) {
      // Client disconnected; persist whatever was produced before giving up.
      if (answer.length > 0) {
        await appendMessage({
          userId: req.user.id,
          conversation,
          role: 'assistant',
          content: answer,
          reasoning: reasoning || undefined,
          inputTokens,
          outputTokens,
        });
      }
      res.end();
      return;
    }

    console.error('chat stream failed', {
      conversationId,
      modelId: model.id,
      message: error?.message,
    });

    // Headers are already sent, so the error has to travel as an SSE event.
    sendEvent(res, 'error', { message: 'The model request failed. Please try again.' });
    res.end();
  }
});
