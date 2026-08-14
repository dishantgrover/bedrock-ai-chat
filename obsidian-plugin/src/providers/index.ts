import type { Backend, Pricing } from '../types';
import type { ChorusSettings } from '../settings';
import { AnthropicBackend } from './anthropic';
import { BedrockBackend } from './bedrock';
import { ChorusBackend, type ConversationStore } from './chorus';

/**
 * Builds the configured backend.
 *
 * Throws with setup guidance rather than returning a half-configured client, so
 * a missing field is reported before a request is attempted.
 *
 * @param settings Current plugin settings.
 * @param conversations Conversation ID persistence, used only by the proxy.
 * @returns A ready backend.
 */
export function createBackend(
  settings: ChorusSettings,
  conversations: ConversationStore,
): Backend {
  switch (settings.backend) {
    case 'anthropic': {
      if (!settings.anthropicApiKey) {
        throw new Error('Add an Anthropic API key in the Chorus settings.');
      }
      return new AnthropicBackend(settings.anthropicApiKey, settings.anthropicModelId);
    }

    case 'bedrock': {
      if (!settings.awsAccessKeyId || !settings.awsSecretAccessKey) {
        throw new Error('Add an AWS access key and secret in the Chorus settings.');
      }
      return new BedrockBackend(settings.awsRegion, settings.bedrockModelId, {
        accessKeyId: settings.awsAccessKeyId,
        secretAccessKey: settings.awsSecretAccessKey,
        sessionToken: settings.awsSessionToken || undefined,
      });
    }

    case 'chorus': {
      if (!settings.chorusBaseUrl || !settings.chorusClientId || !settings.chorusUsername) {
        throw new Error('Fill in the Chorus base URL, app client ID and username in settings.');
      }
      return new ChorusBackend(
        {
          baseUrl: settings.chorusBaseUrl,
          region: settings.chorusRegion,
          clientId: settings.chorusClientId,
          username: settings.chorusUsername,
          password: settings.chorusPassword,
          modelId: settings.chorusModelId,
        },
        conversations,
      );
    }

    default:
      throw new Error(`Unknown backend: ${settings.backend}`);
  }
}

/**
 * Published on-demand rates in USD per million tokens, used only for the
 * indicative per-turn cost.
 *
 * Matching is by substring because the same model appears under different IDs
 * across Bedrock, Anthropic and a Chorus registry. Rates drift and the table
 * excludes prompt caching, which is why the UI marks the figure as an estimate.
 * An unmatched model simply shows no cost.
 */
const RATES: Array<{ match: RegExp; pricing: Pricing }> = [
  { match: /opus/i, pricing: { inputPerMillion: 5, outputPerMillion: 25 } },
  { match: /sonnet/i, pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { match: /haiku/i, pricing: { inputPerMillion: 0.8, outputPerMillion: 4 } },
  { match: /grok/i, pricing: { inputPerMillion: 1.25, outputPerMillion: 2.5 } },
];

/**
 * Best-effort rates for whichever model the active backend uses.
 *
 * @param settings Current settings.
 * @returns Rates, or null when the model is not recognised.
 */
export function pricingFor(settings: ChorusSettings): Pricing | null {
  const modelId =
    settings.backend === 'anthropic'
      ? settings.anthropicModelId
      : settings.backend === 'bedrock'
        ? settings.bedrockModelId
        : settings.chorusModelId;

  return RATES.find((entry) => entry.match.test(modelId))?.pricing ?? null;
}
