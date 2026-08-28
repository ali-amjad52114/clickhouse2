import type { WordEvidenceRow } from '../../shared/analyticsTypes';

/**
 * The raw per-word rows behind a claim. Every column is a stored count or a
 * ratio of stored counts - nothing here is smoothed, defaulted or estimated.
 * A null from SQL renders as an em dash, never as 0.
 */

interface Props {
  rows: WordEvidenceRow[];
  /** Rows on this pattern are highlighted as the evidence for the headline. */
  highlightPattern?: string | null;
  /** Shown instead of the table when there are no rows. Must say why. */
  emptyMessage: string;
  /** Cap the rendered rows. The caller has already ordered them. */
  limit?: number;
  /** Drop the pattern column when every row shares one pattern. */
  showPattern?: boolean;
  /** Hide slower-moving columns in the compact hero layout. */
  compact?: boolean;
}

function tone(accuracy: number | null): string {
  if (accuracy === null) return '';
  if (accuracy < 0.7) return 'tone-bad';
  if (accuracy < 0.85) return 'tone-warn';
  return 'tone-good';
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function millis(v: number | null): string {
  if (v === null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

function clock(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

export function EvidenceTable({
  rows,
  highlightPattern = null,
  emptyMessage,
  limit,
  showPattern = true,
  compact = false,
}: Props) {
  if (rows.length === 0) return <p className="tv-empty">{emptyMessage}</p>;

  const shown = typeof limit === 'number' ? rows.slice(0, limit) : rows;

  return (
    <div className="tv-tablewrap">
      <table className="tv-table">
        <thead>
          <tr>
            <th>Word</th>
            {showPattern && <th>Pattern</th>}
            <th>Attempts</th>
            <th>Correct</th>
            <th>Failed</th>
            <th>Accuracy</th>
            {!compact && <th>Avg response</th>}
            {!compact && <th>Hint rate</th>}
            {!compact && <th>Last seen</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const focused = highlightPattern !== null && r.pattern === highlightPattern;
            return (
              <tr key={`${r.word}:${r.pattern}`} className={focused ? 'is-focus' : undefined}>
                <td className="word">{r.word.toUpperCase()}</td>
                {showPattern && (
                  <td>
                    <span className="tv-tag">{r.pattern || '—'}</span>
                  </td>
                )}
                <td className="num">{r.attempts}</td>
                <td className="num">{r.successes}</td>
                <td className="num">{r.failures}</td>
                <td className="num">
                  <span className="tv-meter">
                    <span className="tv-meter-track">
                      <span
                        className={`tv-meter-fill ${tone(r.accuracy)}`}
                        style={{ width: `${Math.round((r.accuracy ?? 0) * 100)}%` }}
                      />
                    </span>
                    <span>{pct(r.accuracy)}</span>
                  </span>
                </td>
                {!compact && <td className="num muted">{millis(r.avgResponseMs)}</td>}
                {!compact && <td className="num muted">{pct(r.hintRate)}</td>}
                {!compact && <td className="muted">{clock(r.lastSeen)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {typeof limit === 'number' && rows.length > limit && (
        <p className="tv-empty" style={{ marginTop: 10 }}>
          {rows.length - limit} further word row(s) not shown here.
        </p>
      )}
    </div>
  );
}
