/**
 * Probes Grok on the bedrock-mantle endpoint across Regions.
 *
 * Useful when Grok requests start failing: it separates an upstream problem in
 * one Region from a problem with this deployment. Grok is in-region only, so a
 * healthy alternative Region is a viable temporary move.
 *
 * Usage: node scripts/check-grok-regions.js [timeoutSeconds]
 */
import OpenAI from 'openai';

import { generateMantleToken } from '../src/mantleToken.js';

const timeoutMs = Number(process.argv[2] || 45) * 1000;
const regions = ['us-east-1', 'us-east-2', 'us-west-2'];

for (const region of regions) {
  const started = Date.now();
  try {
    const client = new OpenAI({
      apiKey: await generateMantleToken(region),
      baseURL: `https://bedrock-mantle.${region}.api.aws/openai/v1`,
      maxRetries: 0,
      timeout: timeoutMs,
    });

    const response = await client.chat.completions.create({
      model: 'xai.grok-4.3',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_completion_tokens: 300,
    });

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const text = response.choices?.[0]?.message?.content ?? '';
    console.log(`PASS ${region} (${elapsed}s) ${JSON.stringify(String(text).trim().slice(0, 30))}`);
  } catch (error) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`FAIL ${region} (${elapsed}s) ${error?.name}: ${String(error?.message).slice(0, 100)}`);
  }
}
