/**
 * Model selector shown on the empty-state screen before a conversation starts.
 *
 * The model is fixed once the first message is sent, so this is deliberately not
 * available mid-conversation: switching models part-way through produces replies
 * that disagree with the history above them.
 *
 * @param {Object} props
 * @param {Array<Object>} props.models Available models.
 * @param {string} props.selectedId Currently selected model key.
 * @param {(id: string) => void} props.onSelect Selection handler.
 */
export default function ModelPicker({ models, selectedId, onSelect }) {
  return (
    <div className="w-full max-w-md">
      <h2 className="mb-3 text-center text-sm text-zinc-400">Choose a model to start</h2>
      <div className="space-y-2">
        {models.map((model) => {
          const selected = model.id === selectedId;
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => onSelect(model.id)}
              aria-pressed={selected}
              className={[
                'w-full rounded-xl border px-4 py-3 text-left transition',
                selected
                  ? 'border-zinc-400 bg-zinc-800'
                  : 'border-surface-border bg-surface-raised hover:border-zinc-600',
              ].join(' ')}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{model.label}</span>
                <span className="shrink-0 text-xs text-zinc-500">{model.vendor}</span>
              </div>
              <p className="mt-1 text-xs text-zinc-400">{model.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
