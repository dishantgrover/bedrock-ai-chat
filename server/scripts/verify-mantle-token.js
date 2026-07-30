/**
 * Verifies the Node bearer-token implementation against the live
 * `bedrock-mantle` endpoint by streaming a short Grok completion.
 *
 * Usage: node scripts/verify-mantle-token.js [region]
 */
import OpenAI from 'openai';
import { getMantleToken } from '../src/mantleToken.js';

const region = process.argv[2] || 'us-east-1';

const token = await getMantleToken(region);
console.log(`token prefix: ${token.slice(0, 20)}... length=${token.length}`);

const client = new OpenAI({
  apiKey: token,
  baseURL: `https://bedrock-mantle.${region}.api.aws/openai/v1`,
  maxRetries: 0,
  timeout: 60_000,
});

const stream = await client.chat.completions.create({
  model: 'xai.grok-4.3',
  messages: [{ role: 'user', content: 'Count from 1 to 5, comma separated.' }],
  max_completion_tokens: 400,
  stream: true,
});

let text = '';
for await (const chunk of stream) {
  text += chunk.choices?.[0]?.delta?.content ?? '';
}

console.log(`STREAMED: ${text.trim()}`);
console.log(text.trim() ? 'RESULT: PASS' : 'RESULT: FAIL (empty stream)');
