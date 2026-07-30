/**
 * Compares `us.` geo inference profiles against `global.` profiles.
 *
 * Geo profiles appear to bill about 10% above list price while global profiles
 * bill at list, so global is cheaper. The question is whether routing worldwide
 * costs latency. For a chat UI the number that matters is time to first token,
 * not total duration, so both are reported.
 *
 * Usage: node scripts/compare-profile-latency.js [runsPerProfile]
 */
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';

const runs = Number(process.argv[2] || 5);
const region = process.env.AWS_REGION || 'us-east-1';
const client = new BedrockRuntimeClient({ region });

const pairs = [
  {
    label: 'Sonnet 4.5',
    us: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    global: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  {
    label: 'Opus 4.5',
    us: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
    global: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  },
];

// Long enough that the stream lasts a while, so time to first token and total
// duration are clearly distinguishable.
const PROMPT = 'List the first 20 prime numbers, comma separated, nothing else.';

/**
 * Streams one completion and times it.
 *
 * @param {string} modelId Inference profile ID.
 * @returns {Promise<{ttft: number, total: number, chars: number}>} Timings in ms.
 */
async function timeOne(modelId) {
  const started = Date.now();
  let firstTokenAt = null;
  let chars = 0;

  const response = await client.send(
    new ConverseStreamCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: PROMPT }] }],
      inferenceConfig: { maxTokens: 300, temperature: 1 },
    }),
  );

  for await (const event of response.stream ?? []) {
    const text = event.contentBlockDelta?.delta?.text;
    if (text) {
      firstTokenAt ??= Date.now();
      chars += text.length;
    }
  }

  return {
    ttft: (firstTokenAt ?? Date.now()) - started,
    total: Date.now() - started,
    chars,
  };
}

/** Returns the median of a numeric array. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

console.log(`region=${region} runs=${runs} per profile\n`);

for (const pair of pairs) {
  const results = {};

  for (const kind of ['us', 'global']) {
    const ttfts = [];
    const totals = [];

    for (let i = 0; i < runs; i += 1) {
      try {
        const r = await timeOne(pair[kind]);
        ttfts.push(r.ttft);
        totals.push(r.total);
      } catch (error) {
        console.log(`  ${pair.label} ${kind} run ${i + 1} failed: ${error?.name}: ${String(error?.message).slice(0, 80)}`);
      }
    }

    results[kind] = { ttfts, totals };
    if (ttfts.length) {
      console.log(
        `${pair.label} ${kind.padEnd(6)} ttft median=${median(ttfts).toFixed(0)}ms ` +
          `min=${Math.min(...ttfts)}ms max=${Math.max(...ttfts)}ms | ` +
          `total median=${median(totals).toFixed(0)}ms`,
      );
    }
  }

  if (results.us.ttfts.length && results.global.ttfts.length) {
    const usTtft = median(results.us.ttfts);
    const globalTtft = median(results.global.ttfts);
    const delta = globalTtft - usTtft;
    const pct = ((delta / usTtft) * 100).toFixed(1);
    console.log(
      `${pair.label} -> global is ${delta >= 0 ? 'slower' : 'faster'} by ` +
        `${Math.abs(delta).toFixed(0)}ms (${pct}%) at the median\n`,
    );
  }
}
