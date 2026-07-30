import { useState } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/**
 * A single chat turn. User messages render as a right-aligned bubble; assistant
 * messages render as full-width Markdown, matching the convention used by most
 * chat UIs (it gives long answers, tables and code the full column width).
 *
 * @param {Object} props
 * @param {'user'|'assistant'} props.role Author.
 * @param {string} props.content Message text, Markdown for assistant turns.
 * @param {boolean} [props.streaming] Whether to show the blinking caret.
 */
export default function Message({ role, content, streaming = false }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-zinc-800 px-4 py-2.5 text-[15px] leading-relaxed">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className={`prose-chat ${streaming ? 'streaming-caret' : ''}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ pre: CodeBlock }}
      >
        {content}
      </Markdown>
    </div>
  );
}

/**
 * Fenced code block with a copy button.
 *
 * @param {{children: React.ReactNode}} props Rendered `pre` content.
 */
function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);

  async function copy(event) {
    // The rendered markup is the reliable source of the code text; reaching into
    // the React children tree is brittle across plugin versions.
    const code = event.currentTarget.parentElement?.querySelector('code')?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; silently leave the button unchanged.
    }
  }

  return (
    <div className="group relative">
      <pre>{children}</pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 rounded border border-surface-border bg-zinc-800/90 px-2 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
