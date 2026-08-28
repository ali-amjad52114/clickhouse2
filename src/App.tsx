import { useEffect, useState } from 'react';
import foxStory from './stories/fox-and-lost-star.json';
import grapesStory from './stories/fox-and-the-grapes.json';
import { GameCanvas } from './components/ChildShell/GameCanvas';

/** Same engine, different books. #grapes loads the converted Aesop text. */
const STORIES: Record<string, unknown> = {
  '': foxStory,
  '#grapes': grapesStory,
};

export default function App() {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const story = STORIES[hash] ?? foxStory;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0d1b2a' }}>
      <GameCanvas key={hash} story={story} childId="maya" />
    </div>
  );
}
