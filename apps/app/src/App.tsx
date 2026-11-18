import { useEffect, useState } from 'react';
import type { Actor, MarkupDoc } from '@markup/doc';
import { Editor } from './Editor';
import { DocProvider } from './store/DocProvider';
import { openLocalDoc } from './store/persistence';

const LOCAL_USER: Actor = { id: 'local-user', kind: 'human', name: 'You' };

export function App() {
  const [doc, setDoc] = useState<MarkupDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openLocalDoc()
      .then(({ doc }) => {
        if (cancelled) return;
        setDoc(doc);
        if (import.meta.env.DEV) Object.assign(window, { __markup: { doc, actor: LOCAL_USER } });
      })
      .catch((e: Error) => setError(`Could not open the local file store: ${e.message}. Reload to try again.`));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="boot-message" role="alert">{error}</div>;
  if (!doc) return <div className="boot-message">Opening file…</div>;
  return (
    <DocProvider doc={doc} actor={LOCAL_USER}>
      <Editor />
    </DocProvider>
  );
}
