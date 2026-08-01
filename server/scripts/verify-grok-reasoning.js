/**
 * Verifies the Responses-API Grok adapter, including reasoning continuity.
 *
 * Runs three turns and feeds each reply back as history, exactly as the chat
 * route does. Asserts that the reasoning item is returned and replayed, and that
 * the model resolves a reference that only works if history reached it.
 *
 * Usage: node scripts/verify-grok-reasoning.js
 *   MANTLE_REGION must point at a Region where Grok is healthy.
 */
import { findModel } from '../src/models.js';
import { streamGrokReasoning } from '../src/providers/grokReasoning.js';

const model = findModel('grok-4-3-reasoning');
if (!model) {
  console.log('FAIL model grok-4-3-reasoning is not registered');
  process.exit(1);
}

/**
 * Runs one turn against the provider.
 *
 * @param {Array<Object>} messages History including the new user message.
 * @returns {Promise<{text: string, reasoningItem: Object|undefined, usage: Object|null}>} Turn result.
 */
async function turn(messages) {
  let text = '';
  let reasoningItem;
  let usage = null;

  for await (const event of streamGrokReasoning({
    model,
    messages,
    systemPrompt: 'You are terse.',
  })) {
    if (event.type === 'text') text += event.value;
    else if (event.type === 'reasoningItem') reasoningItem = event.value;
    else if (event.type === 'usage') usage = event;
  }

  return { text, reasoningItem, usage };
}

const history = [];
let failures = 0;

// Turn 1: establish a fact the later turns must recall.
history.push({ role: 'user', content: 'Remember the number 42. Reply with just: noted' });
const first = await turn(history);
console.log(`turn1 text=${JSON.stringify(first.text.trim().slice(0, 40))}`);
console.log(
  `turn1 reasoningItem=${first.reasoningItem ? 'present' : 'MISSING'} ` +
    `encrypted=${first.reasoningItem?.encrypted_content?.length ?? 0} chars ` +
    `usage=${first.usage?.inputTokens}/${first.usage?.outputTokens}`,
);
if (!first.reasoningItem) failures += 1;

history.push({
  role: 'assistant',
  content: first.text,
  reasoningItem: first.reasoningItem,
});

// Turn 2: only answerable from replayed history.
history.push({ role: 'user', content: 'What number did I ask you to remember?' });
const second = await turn(history);
console.log(`turn2 text=${JSON.stringify(second.text.trim().slice(0, 40))}`);
console.log(
  `turn2 reasoningItem=${second.reasoningItem ? 'present' : 'MISSING'} ` +
    `usage=${second.usage?.inputTokens}/${second.usage?.outputTokens}`,
);
if (!second.text.includes('42')) {
  console.log('FAIL turn2 did not recall the number, so history did not reach the model');
  failures += 1;
}

history.push({
  role: 'assistant',
  content: second.text,
  reasoningItem: second.reasoningItem,
});

// Turn 3: confirms replaying two accumulated reasoning items is still accepted.
history.push({ role: 'user', content: 'Double it and reply with just the number.' });
const third = await turn(history);
console.log(`turn3 text=${JSON.stringify(third.text.trim().slice(0, 40))}`);
console.log(`turn3 usage=${third.usage?.inputTokens}/${third.usage?.outputTokens}`);
if (!third.text.includes('84')) {
  console.log('FAIL turn3 did not resolve the reference across two replayed turns');
  failures += 1;
}

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
