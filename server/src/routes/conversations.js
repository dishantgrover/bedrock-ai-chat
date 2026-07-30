/**
 * Conversation CRUD. Every handler resolves the conversation through
 * `getConversation`, which enforces ownership.
 */
import { Router } from 'express';

import { defaultModel, findModel } from '../models.js';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
} from '../store.js';

export const conversationsRouter = Router();

conversationsRouter.get('/', async (req, res) => {
  const conversations = await listConversations(req.user.id);
  res.json({ conversations });
});

conversationsRouter.post('/', async (req, res) => {
  const requestedModelId = req.body?.modelId;
  const model = requestedModelId ? findModel(requestedModelId) : defaultModel();

  if (!model) {
    res.status(400).json({ error: 'Unknown model' });
    return;
  }

  const conversation = await createConversation({
    userId: req.user.id,
    modelId: model.id,
    title: 'New chat',
  });

  res.status(201).json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      modelId: conversation.modelId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
  });
});

conversationsRouter.get('/:conversationId', async (req, res) => {
  const conversation = await getConversation(req.user.id, req.params.conversationId);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const messages = await listMessages(conversation.id);

  res.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      modelId: conversation.modelId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    messages,
  });
});

conversationsRouter.patch('/:conversationId', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  const conversation = await getConversation(req.user.id, req.params.conversationId);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  await renameConversation({ userId: req.user.id, conversation, title: title.slice(0, 120) });
  res.json({ conversation: { id: conversation.id, title: conversation.title } });
});

conversationsRouter.delete('/:conversationId', async (req, res) => {
  const conversation = await getConversation(req.user.id, req.params.conversationId);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  await deleteConversation({ userId: req.user.id, conversation });
  res.status(204).end();
});
