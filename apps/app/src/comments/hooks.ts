import type { CommentThread } from '@markup/doc';
import { useDoc } from '../store/DocProvider';
import { useDeep } from '../store/hooks';

export function useThreads(): CommentThread[] {
  const { doc } = useDoc();
  return useDeep(doc.ydoc.getArray('comments'), () => doc.threads(), [doc]);
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
