/**
 * Integration check for the two streaming providers against live Bedrock.
 *
 * Exercises the same code path the chat route uses, so a shape change in either
 * SDK surfaces here rather than in the browser.
 *
 * Usage: node scripts/verify-providers.js
 */
import { findModel } from '../src/models.js';
import { streamClaude } from '../src/providers/claude.js';
import { streamGrok } from '../src/providers/grok.js';

const STREAMERS = { bedrock: streamClaude, mantle: streamGrok };

const cases = ['claude-sonnet-4-5', 'claude-opus-4-5', 'grok-4-3'];
let failures = 0;

for (const id of cases) {
  const model = findModel(id);
  const started = Date.now();
  let text = '';
  let reasoning = '';
  let usage = null;

  try {
    const stream = STREAMERS[model.transport]({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: STREAM_OK' }],
      systemPrompt: 'You are terse.',
    });

    for await (const event of stream) {
      if (event.type === 'text') text += event.value;
      else if (event.type === 'reasoning') reasoning += event.value;
      else if (event.type === 'usage') usage = event;
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const ok = text.includes('STREAM_OK');
    if (!ok) failures += 1;

    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${id} (${elapsed}s) text=${JSON.stringify(text.trim().slice(0, 40))} ` +
        `reasoningChars=${reasoning.length} usage=${usage ? `${usage.inputTokens}/${usage.outputTokens}` : 'none'}`,
    );
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${id} threw ${error?.name}: ${String(error?.message).slice(0, 160)}`);
  }
}

console.log(failures === 0 ? 'ALL PROVIDERS PASS' : `${failures} PROVIDER FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
