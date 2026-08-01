import { useMemo } from 'react';

import { APP_NAME } from '../branding.js';
import Logo from './Logo.jsx';

/**
 * Conversation list. Renders as a fixed rail on desktop and as an off-canvas
 * drawer on small screens.
 *
 * @param {Object} props
 * @param {Array<Object>} props.conversations Conversation summaries.
 * @param {string|null} props.activeId Currently open conversation.
 * @param {boolean} props.open Whether the mobile drawer is showing.
 * @param {string} props.username Signed-in username.
 * @param {{outputTokensToday: number, dailyTokenBudget: number}|null} props.usage Token usage.
 * @param {() => void} props.onClose Close the mobile drawer.
 * @param {() => void} props.onNewChat Start a new conversation.
 * @param {(id: string) => void} props.onSelect Open a conversation.
 * @param {(id: string) => void} props.onDelete Delete a conversation.
 * @param {() => void} props.onSignOut Sign out.
 */
export default function Sidebar({
  conversations,
  activeId,
  open,
  collapsed,
  username,
  usage,
  onClose,
  onToggleCollapse,
  onNewChat,
  onSelect,
  onDelete,
  onSignOut,
}) {
  const groups = useMemo(() => groupByRecency(conversations), [conversations]);

  return (
    <>
      {/* Scrim: only present on mobile while the drawer is open. */}
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-surface-border bg-surface-raised transition-transform duration-200',
          // On desktop the panel is in the layout flow and collapses by width
          // rather than sliding, so the chat column reclaims the space.
          'md:static md:z-auto md:translate-x-0 md:overflow-hidden md:transition-[width,border] md:duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'md:w-0 md:border-r-0' : 'md:w-72',
        ].join(' ')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Fixed-width inner column so content keeps its shape while the parent
            clips it, instead of reflowing as the width animates.

            When collapsed, visibility:hidden rather than just clipping: a
            zero-width overflow-hidden panel still leaves its buttons in the tab
            order, so keyboard users would tab into invisible controls. */}
        <div
          aria-hidden={collapsed}
          className={[
            'flex h-full w-72 flex-col',
            collapsed ? 'md:invisible' : '',
          ].join(' ')}
        >
        {/* Desktop: the wordmark is the collapse control. */}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label="Collapse sidebar"
          title="Collapse sidebar (Cmd/Ctrl+B)"
          className="mx-2 mt-3 hidden items-center gap-2 rounded-lg px-2 py-1.5 text-zinc-100 transition hover:bg-zinc-800 md:flex"
        >
          <Logo size={20} />
          <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
        </button>

        {/* Mobile: the drawer already has a close button, so this stays static. */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-1 text-zinc-100 md:hidden">
          <Logo size={20} />
          <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
        </div>

        <div className="flex items-center gap-2 p-3">
          <button
            type="button"
            onClick={onNewChat}
            className="flex-1 rounded-lg border border-surface-border px-3 py-2.5 text-left text-sm font-medium transition hover:bg-zinc-800"
          >
            + New chat
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-lg p-2.5 text-zinc-400 transition hover:bg-zinc-800 md:hidden"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="chat-scroll flex-1 overflow-y-auto px-2 pb-2">
          {conversations.length === 0 && (
            <p className="px-2 py-4 text-sm text-zinc-500">No conversations yet.</p>
          )}

          {groups.map((group) => (
            <div key={group.label} className="mb-4">
              <h2 className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                {group.label}
              </h2>
              <ul className="space-y-0.5">
                {group.items.map((conversation) => (
                  <li key={conversation.id}>
                    <div
                      className={[
                        'group flex items-center gap-1 rounded-lg px-2',
                        conversation.id === activeId ? 'bg-zinc-800' : 'hover:bg-zinc-800/60',
                      ].join(' ')}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(conversation.id)}
                        className="min-w-0 flex-1 py-2 text-left"
                      >
                        <span className="block truncate text-sm">{conversation.title}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${conversation.title}`}
                        onClick={() => onDelete(conversation.id)}
                        // Always reachable on touch devices, where hover does
                        // not exist.
                        className="rounded p-1.5 text-zinc-500 opacity-100 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-surface-border p-3">
          {usage && (
            <div className="mb-2">
              <div className="mb-1 flex justify-between text-xs text-zinc-500">
                <span>Today</span>
                <span>
                  {usage.outputTokensToday.toLocaleString()} /{' '}
                  {usage.dailyTokenBudget.toLocaleString()}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-zinc-500"
                  style={{
                    width: `${Math.min(
                      100,
                      (usage.outputTokensToday / usage.dailyTokenBudget) * 100,
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="truncate text-sm text-zinc-400">{username}</span>
            <button
              type="button"
              onClick={onSignOut}
              className="text-xs text-zinc-500 transition hover:text-zinc-300"
            >
              Sign out
            </button>
          </div>
        </div>
        </div>
      </aside>
    </>
  );
}

/**
 * Buckets conversations into the recency headings used by mainstream chat UIs.
 *
 * @param {Array<Object>} conversations Summaries sorted newest first.
 * @returns {Array<{label: string, items: Array<Object>}>} Non-empty groups.
 */
function groupByRecency(conversations) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const buckets = [
    { label: 'Today', items: [], test: (age) => age < day },
    { label: 'Yesterday', items: [], test: (age) => age < 2 * day },
    { label: 'Previous 7 days', items: [], test: (age) => age < 7 * day },
    { label: 'Older', items: [], test: () => true },
  ];

  for (const conversation of conversations) {
    const age = now - new Date(conversation.updatedAt).getTime();
    buckets.find((bucket) => bucket.test(age)).items.push(conversation);
  }

  return buckets.filter((bucket) => bucket.items.length > 0);
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}
