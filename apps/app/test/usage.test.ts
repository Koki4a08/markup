import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@markup/doc';
import { count, createUsageStore, createUsageSync, dayKey, deviceId, KEEP_DAYS, watchActivity, watchEdits, type UsageRow } from '../src/cloud/usage';
import { memoryWorkspace } from './memoryWorkspace';

const YOU: Actor = { id: 'local-user', kind: 'human', name: 'You' };
const AGENT: Actor = { id: 'agent:1', kind: 'agent', name: 'Claude Code' };

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

afterEach(() => vi.useRealTimers());

describe('usage store', () => {
  it('counts per local day and keeps the counts across runs', () => {
    const storage = memoryStorage();
    let clock = new Date(2026, 10, 25, 10).getTime();
    const store = createUsageStore({ storage, now: () => clock });
    count.edit(store, 'f1', 'human');
    count.edit(store, 'f1', 'agent');
    count.edit(store, 'f2', 'agent');
    count.toolCall(store, 'Claude Code', 'write_html');
    count.exported(store, 'PNG');
    count.fileCreated(store);
    count.activeMinute(store);
    expect(store.today()).toEqual({
      edits: { you: 1, agents: 2 },
      files_edited: 2,
      agent_calls: { 'Claude Code': 1 },
      tool_calls: { write_html: 1 },
      exports: { png: 1 },
      files_created: 1,
      active_minutes: 1,
    });
    store.save();
    clock += 86_400_000;
    const next = createUsageStore({ storage, now: () => clock });
    expect(next.today()).toEqual({});
    expect(next.pending().map((p) => p.day)).toEqual([dayKey(clock - 86_400_000)]);
  });

  it('never uploads file ids, only how many files changed', () => {
    const store = createUsageStore({ storage: null });
    count.edit(store, 'secret-file-id', 'human');
    expect(JSON.stringify(store.pending())).not.toContain('secret-file-id');
  });

  it('bounds names: odd characters dropped, at most 40 per day, the rest under "other"', () => {
    const store = createUsageStore({ storage: null });
    for (let i = 0; i < 45; i++) count.toolCall(store, `agent-${i}`, 'get_jsx');
    count.toolCall(store, '<script>x</script>', 'get_jsx');
    const m = store.today();
    expect(Object.keys(m.agent_calls!)).toHaveLength(41);
    expect(m.agent_calls!.other).toBe(6);
    expect(m.tool_calls).toEqual({ get_jsx: 46 });
  });

  it('only reports days changed since their last upload', () => {
    const store = createUsageStore({ storage: null });
    count.edit(store, 'f', 'human');
    const [first] = store.pending();
    store.markSynced(first!.day, first!.rev);
    expect(store.pending()).toEqual([]);
    count.edit(store, 'f', 'human');
    expect(store.pending()[0]!.metrics.edits).toEqual({ you: 2 });
  });

  it(`forgets days older than ${KEEP_DAYS} days`, () => {
    const storage = memoryStorage();
    let clock = new Date(2026, 0, 1, 12).getTime();
    const store = createUsageStore({ storage, now: () => clock });
    count.edit(store, 'f', 'human');
    clock += (KEEP_DAYS + 2) * 86_400_000;
    count.edit(store, 'f', 'human');
    store.save();
    expect(createUsageStore({ storage, now: () => clock }).pending()).toHaveLength(1);
  });

  it('survives garbage in storage', () => {
    const storage = memoryStorage();
    storage.setItem('markup:usage', '{not json');
    expect(createUsageStore({ storage }).pending()).toEqual([]);
    storage.setItem('markup:usage', JSON.stringify({ days: { nope: {}, '2026-01-01': { rev: 'x' } } }));
    expect(createUsageStore({ storage }).pending()).toEqual([]);
  });
});

describe('usage sync', () => {
  const setup = (opts: { signedIn?: boolean; fail?: boolean } = {}) => {
    const store = createUsageStore({ storage: null });
    const sent: UsageRow[][] = [];
    let signedIn = opts.signedIn ?? true;
    const upload = vi.fn(async (rows: UsageRow[]) => {
      if (opts.fail) throw new Error('offline');
      sent.push(rows);
    });
    const sync = createUsageSync({ store, deviceId: 'dev_abcdef12', client: 'desktop', upload, canUpload: () => signedIn, intervalMs: 1000 });
    return { store, sync, sent, upload, signIn: (v: boolean) => (signedIn = v) };
  };

  it('uploads whole days for this device, then only what changed', async () => {
    const s = setup();
    count.edit(s.store, 'f', 'agent');
    await s.sync.flush();
    expect(s.sent[0]).toEqual([{ day: dayKey(Date.now()), device_id: 'dev_abcdef12', client: 'desktop', metrics: { edits: { agents: 1 }, files_edited: 1 } }]);
    await s.sync.flush();
    expect(s.upload).toHaveBeenCalledTimes(1);
    count.edit(s.store, 'f', 'agent');
    await s.sync.flush();
    expect(s.sent[1]![0]!.metrics.edits).toEqual({ agents: 2 });
    s.sync.dispose();
  });

  it('keeps counts local while signed out or switched off', async () => {
    const s = setup({ signedIn: false });
    count.edit(s.store, 'f', 'human');
    await s.sync.flush();
    expect(s.upload).not.toHaveBeenCalled();
    s.signIn(true);
    await s.sync.flush();
    expect(s.upload).toHaveBeenCalledTimes(1);
    s.sync.dispose();
  });

  it('keeps a failed day pending for the next try', async () => {
    const s = setup({ fail: true });
    count.edit(s.store, 'f', 'human');
    await s.sync.flush();
    expect(s.store.pending()).toHaveLength(1);
    s.sync.dispose();
  });

  it('tries again on its own every interval', async () => {
    vi.useFakeTimers();
    const s = setup();
    count.edit(s.store, 'f', 'human');
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.upload).toHaveBeenCalledTimes(1);
    s.sync.dispose();
  });
});

describe('what counts as an edit', () => {
  it('counts your and agents’ content changes in open files, nothing else', async () => {
    const { workspace } = memoryWorkspace();
    const created = await workspace.createFile({});
    const doc = await workspace.open(created.id);
    const edits: string[] = [];
    const stop = watchEdits(workspace, (fileId, kind) => edits.push(`${fileId}:${kind}`));
    const tokens = doc.ydoc.getArray('tokens');
    doc.ydoc.transact(() => tokens.push(['a']), YOU);
    doc.ydoc.transact(() => tokens.push(['b']), AGENT);
    // Not content: a non-history map, and changes with no actor (storage, sync).
    doc.ydoc.transact(() => doc.ydoc.getMap('scratch').set('x', 1), YOU);
    doc.ydoc.transact(() => tokens.push(['c']), 'cloud');
    tokens.push(['d']);
    expect(edits).toEqual([`${created.id}:human`, `${created.id}:agent`]);
    workspace.close(created.id);
    doc.ydoc.transact(() => tokens.push(['e']), YOU);
    expect(edits).toHaveLength(2);
    stop();
  });

  it('reports new files', async () => {
    const { workspace } = memoryWorkspace();
    const created = vi.fn();
    workspace.on('created', created);
    const file = await workspace.createFile({ name: 'Landing' });
    await workspace.createFile({ cloneFileId: file.id });
    expect(created).toHaveBeenCalledTimes(2);
  });
});

describe('active minutes', () => {
  it('counts a minute only with focus and input in it', () => {
    vi.useFakeTimers();
    let clock = 0;
    const listeners = new Map<string, () => void>();
    let focused = true;
    const win = {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: vi.fn(),
      document: { visibilityState: 'visible', hasFocus: () => focused },
    } as unknown as Window;
    const onMinute = vi.fn();
    const stop = watchActivity(win, onMinute, { now: () => clock, intervalMs: 60_000 });
    clock = 30_000;
    listeners.get('keydown')!();
    clock = 60_000;
    vi.advanceTimersByTime(60_000);
    expect(onMinute).toHaveBeenCalledTimes(1);
    clock = 120_000;
    vi.advanceTimersByTime(60_000);
    expect(onMinute).toHaveBeenCalledTimes(1);
    listeners.get('pointermove')!();
    focused = false;
    clock = 180_000;
    vi.advanceTimersByTime(60_000);
    expect(onMinute).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('deviceId', () => {
  it('is made once per install and kept', () => {
    const storage = memoryStorage();
    const id = deviceId(storage);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(deviceId(storage)).toBe(id);
  });
});
