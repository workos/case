import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { BunSqliteSaver } from '../langgraph/checkpointer.js';

/**
 * SQL-layer correctness for the bun:sqlite checkpointer (Phase 1.2). Proves the
 * port of the upstream schema/serde contract roundtrips checkpoints, parent
 * links, pending writes, listing, deletion, and on-disk persistence — the
 * guarantees the engine's resume path leans on.
 */

const META: CheckpointMetadata = { source: 'input', step: 0, parents: {} };

function ckpt(id: string, channel_values: Record<string, unknown>): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values,
    channel_versions: Object.fromEntries(Object.keys(channel_values).map((k) => [k, 1])),
    versions_seen: {},
  };
}

const cfg = (extra: Record<string, string> = {}) => ({
  configurable: { thread_id: 'task-1', checkpoint_ns: '', ...extra },
});

describe('BunSqliteSaver', () => {
  it('roundtrips a checkpoint and restores channel values', async () => {
    const saver = new BunSqliteSaver(new Database(':memory:'));
    await saver.put(cfg(), ckpt('c1', { cycle: 2, pendingRevision: null }), META);

    const got = await saver.getTuple(cfg());
    expect(got?.checkpoint.id).toBe('c1');
    expect(got?.checkpoint.channel_values).toEqual({ cycle: 2, pendingRevision: null });
    expect(got?.parentConfig).toBeUndefined();
  });

  it('latest-wins ordering and parent linkage', async () => {
    const saver = new BunSqliteSaver(new Database(':memory:'));
    await saver.put(cfg(), ckpt('c1', { cycle: 0 }), META);
    await saver.put(cfg({ checkpoint_id: 'c1' }), ckpt('c2', { cycle: 1 }), META);

    // No checkpoint_id → newest (lexical/uuid6-ordered DESC).
    const latest = await saver.getTuple(cfg());
    expect(latest?.checkpoint.id).toBe('c2');
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe('c1');

    // Explicit id → that exact checkpoint.
    const first = await saver.getTuple(cfg({ checkpoint_id: 'c1' }));
    expect(first?.checkpoint.id).toBe('c1');
    expect(first?.parentConfig).toBeUndefined();
  });

  it('stores and returns pending writes', async () => {
    const saver = new BunSqliteSaver(new Database(':memory:'));
    await saver.put(cfg(), ckpt('c1', { cycle: 0 }), META);
    await saver.putWrites(cfg({ checkpoint_id: 'c1' }), [['decision', { next: 'implement' }]], 'node-a');

    const got = await saver.getTuple(cfg({ checkpoint_id: 'c1' }));
    expect(got?.pendingWrites).toEqual([['node-a', 'decision', { next: 'implement' }]]);
  });

  it('lists checkpoints newest-first and honors limit', async () => {
    const saver = new BunSqliteSaver(new Database(':memory:'));
    await saver.put(cfg(), ckpt('c1', { cycle: 0 }), META);
    await saver.put(cfg({ checkpoint_id: 'c1' }), ckpt('c2', { cycle: 1 }), META);
    await saver.put(cfg({ checkpoint_id: 'c2' }), ckpt('c3', { cycle: 2 }), META);

    const all: string[] = [];
    for await (const t of saver.list(cfg())) all.push(t.checkpoint.id);
    expect(all).toEqual(['c3', 'c2', 'c1']);

    const limited: string[] = [];
    for await (const t of saver.list(cfg(), { limit: 2 })) limited.push(t.checkpoint.id);
    expect(limited).toEqual(['c3', 'c2']);
  });

  it('deleteThread removes checkpoints and writes', async () => {
    const saver = new BunSqliteSaver(new Database(':memory:'));
    await saver.put(cfg(), ckpt('c1', { cycle: 0 }), META);
    await saver.putWrites(cfg({ checkpoint_id: 'c1' }), [['ch', { v: 1 }]], 'node-a');

    await saver.deleteThread('task-1');

    expect(await saver.getTuple(cfg())).toBeUndefined();
    expect(await saver.getTuple(cfg({ checkpoint_id: 'c1' }))).toBeUndefined();
  });

  it('persists across reopen on the same file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'case-ckpt-'));
    const path = join(dir, 'cp.db');
    try {
      const writer = BunSqliteSaver.fromPath(path);
      await writer.put(cfg(), ckpt('c1', { cycle: 3, revisionCycles: 1 }), META);

      // Fresh saver instance, same file — simulates a new process resuming.
      const reader = BunSqliteSaver.fromPath(path);
      const got = await reader.getTuple(cfg());
      expect(got?.checkpoint.id).toBe('c1');
      expect(got?.checkpoint.channel_values).toEqual({ cycle: 3, revisionCycles: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
