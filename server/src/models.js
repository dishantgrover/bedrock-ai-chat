/**
 * Registry of the models exposed to the web app.
 *
 * Bedrock splits inference across two endpoints and the correct identifier form
 * is not guessable from the model name, so every model is declared explicitly:
 *
 *  - `bedrock`: the `bedrock-runtime` endpoint via the Converse API. Claude 4.x
 *    models have no on-demand throughput, so they must be addressed through a
 *    cross-region inference profile. Using the bare model ID fails with a
 *    ValidationException.
 *
 *    The `global.` prefix is used rather than `us.`: geo profiles bill roughly
 *    10% above list price while global profiles bill at list, and measured time
 *    to first token was the same or better for global. The tradeoff is that
 *    global routes to wherever AWS has capacity, so switch back to `us.` if US
 *    data residency is ever required.
 *  - `mantle`: the OpenAI-compatible `bedrock-mantle` endpoint, Chat Completions.
 *    Grok is in-region only, so no prefix applies.
 *  - `mantle-responses`: the same endpoint via the Responses API, which can carry
 *    reasoning between turns. Chat Completions cannot, so a model reached that way
 *    re-derives its thinking from its own conclusions each turn.
 *
 * Model IDs are taken from the AWS model cards rather than inferred.
 */

/**
 * @typedef {Object} ModelDefinition
 * @property {string} id Stable key used by the client and stored on conversations.
 * @property {string} label Display name in the model picker.
 * @property {string} vendor Provider shown in the UI.
 * @property {'bedrock'|'mantle'|'mantle-responses'} transport Which endpoint and API to use.
 * @property {'none'|'low'|'medium'|'high'} [reasoningEffort] Effort for reasoning transports.
 * @property {string} modelId Identifier sent to Bedrock.
 * @property {string} description One-line guidance shown in the picker.
 * @property {number} maxOutputTokens Output cap enforced server-side.
 * @property {boolean} emitsReasoning Whether the model can return a reasoning trace.
 * @property {boolean} [default] Marks the default selection.
 */

/**
 * Order here is the order shown in the picker, and the entry flagged `default`
 * is preselected for a new conversation.
 *
 * @type {ModelDefinition[]}
 */
export const MODELS = [
  {
    id: 'grok-4-3',
    label: 'Grok 4.3',
    vendor: 'xAI',
    transport: 'mantle',
    modelId: 'xai.grok-4.3',
    description: 'Default. Long context, strong at tool use and long documents.',
    maxOutputTokens: 8192,
    // Grok reasons internally and those tokens are billed, but the Chat
    // Completions API does not return the trace -- only the Responses API does.
    // Verified against the live endpoint: 406 output tokens billed, zero
    // reasoning deltas. Left false so the UI does not promise a panel that never
    // fills.
    emitsReasoning: false,
    default: true,
  },
  {
    id: 'grok-4-3-reasoning',
    label: 'Grok 4.3 (reasoning)',
    vendor: 'xAI',
    transport: 'mantle-responses',
    modelId: 'xai.grok-4.3',
    description: 'Same model, but keeps its own reasoning across turns. Better for long arguments.',
    maxOutputTokens: 8192,
    reasoningEffort: 'low',
    // The reasoning is returned encrypted with no readable summary, verified
    // against the live endpoint, so there is still nothing to display.
    emitsReasoning: false,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    vendor: 'Anthropic',
    transport: 'bedrock',
    modelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    description: 'Balanced and quick for everyday chat.',
    maxOutputTokens: 4096,
    emitsReasoning: false,
  },
  {
    id: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    vendor: 'Anthropic',
    transport: 'bedrock',
    modelId: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
    description: 'Most capable Claude. Use for complex reasoning and analysis.',
    maxOutputTokens: 8192,
    emitsReasoning: false,
  },
];

const MODELS_BY_ID = new Map(MODELS.map((model) => [model.id, model]));

/** @returns {ModelDefinition} The model marked as default. */
export function defaultModel() {
  return MODELS.find((model) => model.default) ?? MODELS[0];
}

/**
 * Looks up a model by its registry key.
 *
 * @param {string} id Registry key such as `claude-sonnet-4-5`.
 * @returns {ModelDefinition|undefined} The model, or undefined if unknown.
 */
export function findModel(id) {
  return MODELS_BY_ID.get(id);
}

/**
 * Public model list for the client. Deliberately omits `modelId` and
 * `transport` so the browser never learns the underlying Bedrock identifiers.
 *
 * @returns {Array<{id: string, label: string, vendor: string, description: string, default: boolean}>}
 */
export function publicModels() {
  return MODELS.map(({ id, label, vendor, description, default: isDefault }) => ({
    id,
    label,
    vendor,
    description,
    default: Boolean(isDefault),
  }));
}
