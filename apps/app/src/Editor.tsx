import { useState } from 'react';
import { Canvas } from './canvas/Canvas';
import type { Viewport } from './canvas/viewport';
import { useDoc } from './store/DocProvider';
import { usePages } from './store/hooks';

export function Editor() {
  const { doc } = useDoc();
  const pages = usePages();
  const [activePageId] = useState(() => pages.find((p) => p.type === 'page')!.id);
  const page = pages.find((p) => p.type === 'page' && p.id === activePageId);
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, zoom: 0.5 });
  if (!page || page.type !== 'page') return null;

  return (
    <div className="editor">
      <header className="topbar">
        <span className="file-name">{doc.name}</span>
        <span className="page-name">{page.name}</span>
        <span className="zoom">{Math.round(viewport.zoom * 100)}%</span>
      </header>
      <main className="workspace">
        <Canvas rootId={page.rootId} viewport={viewport} onViewport={setViewport} />
      </main>
    </div>
  );
}
