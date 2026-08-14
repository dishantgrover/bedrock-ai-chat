/**
 * DynamoDB persistence for conversations, messages and per-user usage.
 *
 * Single-table design:
 *
 *   pk                  sk                     entity
 *   USER#<sub>          CONV#<updatedAt>#<id>  conversation index entry
 *   CONV#<id>           META                   conversation record
 *   CONV#<id>           MSG#<seq>              message
 *   USER#<sub>          USAGE#<yyyy-mm-dd>     daily token counter
 *
 * The conversation index entry is keyed by `updatedAt` so a single query returns
 * a user's conversations already ordered by recency, without a secondary index.
 * Because the sort key embeds a mutable value, the old entry is deleted when the
 * timestamp changes.
 */
import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import { REGION, TABLE_NAME } from './config.js';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const userKey = (userId) => `USER#${userId}`;
const convKey = (conversationId) => `CONV#${conversationId}`;

/** Zero-pads a sequence number so message sort keys order lexicographically. */
const seqKey = (seq) => `MSG#${String(seq).padStart(6, '0')}`;

/** Sort key for a conversation's index entry. */
const indexKey = (updatedAt, conversationId) => `CONV#${updatedAt}#${conversationId}`;

/**
 * Creates a conversation and its index entry.
 *
 * @param {Object} params
 * @param {string} params.userId Cognito sub.
 * @param {string} params.modelId Model registry key, fixed for the conversation.
 * @param {string} params.title Initial title.
 * @returns {Promise<Object>} The created conversation.
 */
export async function createConversation({ userId, modelId, title }) {
  const now = new Date().toISOString();
  const conversation = {
    id: randomUUID(),
    userId,
    modelId,
    title,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: convKey(conversation.id), sk: 'META', ...conversation },
    }),
  );

  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: userKey(userId),
        sk: indexKey(now, conversation.id),
        conversationId: conversation.id,
        modelId,
        title,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return conversation;
}

/**
 * Lists a user's conversations, newest first.
 *
 * @param {string} userId Cognito sub.
 * @param {number} [limit] Maximum conversations to return.
 * @returns {Promise<Array<Object>>} Conversation summaries.
 */
export async function listConversations(userId, limit = 100) {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userKey(userId), ':prefix': 'CONV#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return (result.Items ?? []).map((item) => ({
    id: item.conversationId,
    title: item.title,
    modelId: item.modelId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

/**
 * Loads a conversation, returning null unless it belongs to the caller.
 *
 * Ownership is checked here rather than in the route so no caller can read
 * another user's conversation by guessing its UUID.
 *
 * @param {string} userId Cognito sub.
 * @param {string} conversationId Conversation UUID.
 * @returns {Promise<Object|null>} The conversation, or null.
 */
export async function getConversation(userId, conversationId) {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: convKey(conversationId), sk: 'META' },
    }),
  );

  const item = result.Item;
  if (!item || item.userId !== userId) {
    return null;
  }
  return item;
}

/**
 * Returns a conversation's messages in order.
 *
 * @param {string} conversationId Conversation UUID.
 * @returns {Promise<Array<Object>>} Messages.
 */
export async function listMessages(conversationId) {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': convKey(conversationId), ':prefix': 'MSG#' },
      ScanIndexForward: true,
    }),
  );

  return (result.Items ?? []).map((item) => ({
    seq: item.seq,
    role: item.role,
    content: item.content,
    reasoning: item.reasoning,
    reasoningItem: item.reasoningItem,
    // Returned so a reloaded thread shows the same per-turn usage the live
    // stream did; without these the footer would only ever appear once.
    inputTokens: item.inputTokens ?? 0,
    outputTokens: item.outputTokens ?? 0,
    createdAt: item.createdAt,
  }));
}

/**
 * Appends a message and advances the conversation's timestamp.
 *
 * @param {Object} params
 * @param {string} params.userId Cognito sub.
 * @param {Object} params.conversation Conversation record.
 * @param {'user'|'assistant'} params.role Message author.
 * @param {string} params.content Message text.
 * @param {string} [params.reasoning] Reasoning trace, when the model returned one.
 * @param {number} [params.inputTokens] Prompt tokens consumed.
 * @param {number} [params.outputTokens] Completion tokens consumed.
 * @returns {Promise<Object>} The stored message.
 */
export async function appendMessage({
  userId,
  conversation,
  role,
  content,
  reasoning,
  reasoningItem,
  inputTokens = 0,
  outputTokens = 0,
}) {
  const seq = (conversation.messageCount ?? 0) + 1;
  const now = new Date().toISOString();

  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: convKey(conversation.id),
        sk: seqKey(seq),
        seq,
        role,
        content,
        reasoning,
        // Opaque blob replayed to the model so it regains its own prior
        // reasoning. Stored verbatim because the service validates its shape.
        reasoningItem,
        inputTokens,
        outputTokens,
        createdAt: now,
      },
    }),
  );

  const previousUpdatedAt = conversation.updatedAt;

  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: convKey(conversation.id), sk: 'META' },
      UpdateExpression: 'SET messageCount = :seq, updatedAt = :now',
      ExpressionAttributeValues: { ':seq': seq, ':now': now },
    }),
  );

  // Move the index entry so the conversation list stays ordered by recency.
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: userKey(userId),
        sk: indexKey(now, conversation.id),
        conversationId: conversation.id,
        modelId: conversation.modelId,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: now,
      },
    }),
  );

  if (previousUpdatedAt && previousUpdatedAt !== now) {
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: userKey(userId), sk: indexKey(previousUpdatedAt, conversation.id) },
      }),
    );
  }

  conversation.messageCount = seq;
  conversation.updatedAt = now;

  return { seq, role, content, reasoning, createdAt: now };
}

/**
 * Renames a conversation, updating both the record and the index entry.
 *
 * @param {Object} params
 * @param {string} params.userId Cognito sub.
 * @param {Object} params.conversation Conversation record.
 * @param {string} params.title New title.
 * @returns {Promise<void>}
 */
export async function renameConversation({ userId, conversation, title }) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: convKey(conversation.id), sk: 'META' },
      UpdateExpression: 'SET title = :title',
      ExpressionAttributeValues: { ':title': title },
    }),
  );

  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: userKey(userId), sk: indexKey(conversation.updatedAt, conversation.id) },
      UpdateExpression: 'SET title = :title',
      ExpressionAttributeValues: { ':title': title },
    }),
  );

  conversation.title = title;
}

/**
 * Deletes a conversation, its messages and its index entry.
 *
 * @param {Object} params
 * @param {string} params.userId Cognito sub.
 * @param {Object} params.conversation Conversation record.
 * @returns {Promise<void>}
 */
export async function deleteConversation({ userId, conversation }) {
  const messages = await listMessages(conversation.id);

  for (const message of messages) {
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: convKey(conversation.id), sk: seqKey(message.seq) },
      }),
    );
  }

  await client.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: convKey(conversation.id), sk: 'META' },
    }),
  );

  await client.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: userKey(userId), sk: indexKey(conversation.updatedAt, conversation.id) },
    }),
  );
}

/**
 * Adds to a user's output-token counter for today and returns the new total.
 *
 * Bedrock enforces no spend ceiling, so this counter backs an application-level
 * daily budget.
 *
 * @param {string} userId Cognito sub.
 * @param {number} outputTokens Tokens to add.
 * @returns {Promise<number>} Total output tokens used today.
 */
export async function addUsage(userId, outputTokens) {
  const day = new Date().toISOString().slice(0, 10);

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: userKey(userId), sk: `USAGE#${day}` },
      UpdateExpression: 'ADD outputTokens :tokens',
      ExpressionAttributeValues: { ':tokens': outputTokens },
      ReturnValues: 'UPDATED_NEW',
    }),
  );

  return Number(result.Attributes?.outputTokens ?? 0);
}

/**
 * Reads a user's output-token usage for today.
 *
 * @param {string} userId Cognito sub.
 * @returns {Promise<number>} Tokens used today.
 */
export async function getUsageToday(userId) {
  const day = new Date().toISOString().slice(0, 10);

  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: userKey(userId), sk: `USAGE#${day}` },
    }),
  );

  return Number(result.Item?.outputTokens ?? 0);
}
