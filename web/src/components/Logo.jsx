/**
 * Wordmark: three overlapping arcs suggesting several voices in one
 * conversation, sized to sit inline with text.
 *
 * @param {{size?: number, className?: string}} props Rendering options.
 */
export default function Logo({ size = 22, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role="img"
      aria-label="Chorus"
    >
      <circle cx="9" cy="12" r="6" stroke="currentColor" strokeWidth="1.6" opacity="0.45" />
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
      <circle cx="15" cy="12" r="6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
