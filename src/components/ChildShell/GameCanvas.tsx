import { useEffect, useRef, useState } from 'react';
import { createGame, destroyGame } from '../../game/createGame';
import type { ValidationIssue } from '../../shared/storySchema';

interface Props {
  story: unknown;
  childId: string;
}

/**
 * Mounts the Phaser game into a div and tears it down on unmount so hot
 * reload does not leak game instances.
 */
export function GameCanvas({ story, childId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const result = createGame({ parent: host, story, childId });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues(null);
    const { game } = result;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__game = game;

    // Phaser measures the parent once at boot, which can happen before the
    // flex layout has settled. Without this the canvas renders at its design
    // size and overflows instead of letterboxing.
    // Let the ScaleManager re-measure the parent itself. Passing explicit
    // dimensions here desyncs the renderer viewport from the canvas CSS size.
    const refresh = () => game.scale.refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(host);
    requestAnimationFrame(refresh);

    return () => {
      observer.disconnect();
      destroyGame(game);
    };
  }, [story, childId]);

  if (issues) {
    return (
      <div style={{ padding: 24, fontFamily: 'monospace', color: '#ff9d9d' }}>
        <h2>This story could not be played</h2>
        <ul>{issues.map((i, n) => <li key={n}>{i.path}: {i.message}</li>)}</ul>
      </div>
    );
  }

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
