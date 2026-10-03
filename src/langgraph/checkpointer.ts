import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';

/**
 * SQLite checkpointer for the LangGraph engine, backed by `bun:sqlite`.
 *
 * The official `@langchain/langgraph-checkpoint-sqlite` saver is unusable here:
 * it depends on `better-sqlite3`, whose native binding fails to load under Bun
 * (`ERR_DLOPEN_FAILED`, oven-sh/bun#4290). This is a faithful port of that
 * saver's schema + serde contract onto Bun's built-in SQLite driver.
 *
 * Scope: current checkpoint format only (v4). The legacy `pending_sends`
 * subquery + `migratePendingSends` path that the upstream saver carries for
 * v<4 checkpoints is intentionally omitted — this engine only ever persists
 * the version the installed `@langchain/langgraph` writes. `metadata` filtering
 * in `list()` is likewise omitted (the engine never lists by filter).
 */
export class BunSqliteSaver extends BaseCheckpointSaver {
  private readonly db: Database;

  constructor(db: Database, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `);
  }

  /** Open (creating if needed) a checkpoint DB at the given filesystem path. */
  static fromPath(path: string, serde?: SerializerProtocol): BunSqliteSaver {
    return new BunSqliteSaver(new Database(path, { create: true }), serde);
  }

  /** Deserialize one checkpoints-table row into a CheckpointTuple. */
  private async rowToTuple(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any,
    checkpoint_ns: string,
  ): Promise<CheckpointTuple> {
    // pending_writes is json_group_array(...) → a JSON string (or '[]' when empty).
    const rawWrites = JSON.parse(row.pending_writes ?? '[]') as Array<{
      task_id: string;
      channel: string;
      type: string | null;
      value: string | null;
    }>;
    const pendingWrites: [string, string, unknown][] = await Promise.all(
      rawWrites.map(
        async (w) =>
          [w.task_id, w.channel, await this.serde.loadsTyped(w.type ?? 'json', w.value ?? '')] as [
            string,
            string,
            unknown,
          ],
      ),
    );

    const checkpoint = (await this.serde.loadsTyped(row.type ?? 'json', row.checkpoint)) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(row.type ?? 'json', row.metadata)) as CheckpointMetadata;

    return {
      config: {
        configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.checkpoint_id },
      },
      checkpoint,
      metadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  private static readonly SELECT = `
    SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
      (
        SELECT json_group_array(json_object(
          'task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type, 'value', CAST(pw.value AS TEXT)
        ))
        FROM writes AS pw
        WHERE pw.thread_id = checkpoints.thread_id
          AND pw.checkpoint_ns = checkpoints.checkpoint_ns
          AND pw.checkpoint_id = checkpoints.checkpoint_id
      ) AS pending_writes
    FROM checkpoints`;

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
    const checkpoint_id = config.configurable?.checkpoint_id;

    const sql = checkpoint_id
      ? `${BunSqliteSaver.SELECT} WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      : `${BunSqliteSaver.SELECT} WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`;

    const params: SQLQueryBindings[] = checkpoint_id
      ? [thread_id ?? '', checkpoint_ns, checkpoint_id]
      : [thread_id ?? '', checkpoint_ns];
    const row = this.db.query(sql).get(...params);
    if (row == null) return undefined;
    return this.rowToTuple(row, checkpoint_ns);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';

    let sql = `${BunSqliteSaver.SELECT} WHERE thread_id = ? AND checkpoint_ns = ?`;
    const params: SQLQueryBindings[] = [thread_id ?? '', checkpoint_ns];
    if (before?.configurable?.checkpoint_id) {
      sql += ' AND checkpoint_id < ?';
      params.push(before.configurable.checkpoint_id);
    }
    sql += ' ORDER BY checkpoint_id DESC';
    if (limit) sql += ` LIMIT ${parseInt(String(limit), 10)}`;

    const rows = this.db.query(sql).all(...params);
    for (const row of rows) {
      yield await this.rowToTuple(row, checkpoint_ns);
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
    const parent_checkpoint_id = config.configurable?.checkpoint_id;
    if (!thread_id) throw new Error('Missing "thread_id" field in config.configurable.');

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type1 !== type2) {
      throw new Error('Mismatched checkpoint/metadata serializer types.');
    }

    this.db
      .query(
        `INSERT OR REPLACE INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        parent_checkpoint_id ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata,
      );

    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
    const checkpoint_id = config.configurable?.checkpoint_id;
    if (!thread_id) throw new Error('Missing "thread_id" field in config.configurable.');
    if (!checkpoint_id) throw new Error('Missing "checkpoint_id" field in config.configurable.');

    // Special (reserved) channels overwrite by their fixed slot; regular writes
    // are positional and must not clobber an existing slot — mirrors upstream.
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const stmt = this.db.query(
      `INSERT OR ${allSpecial ? 'REPLACE' : 'IGNORE'} INTO writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const rows = await Promise.all(
      writes.map(async ([channel, value], i) => {
        const idx = WRITES_IDX_MAP[channel] ?? i;
        const [type, serialized] = await this.serde.dumpsTyped(value);
        return [thread_id, checkpoint_ns, checkpoint_id, taskId, idx, channel, type, serialized] as const;
      }),
    );

    this.db.transaction((batch: (typeof rows)[number][]) => {
      for (const row of batch) stmt.run(...row);
    })(rows);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.query('DELETE FROM checkpoints WHERE thread_id = ?').run(threadId);
      this.db.query('DELETE FROM writes WHERE thread_id = ?').run(threadId);
    })();
  }
}

/**
 * Construct the engine's checkpointer at the §6-decided location: a sibling DB
 * alongside td's SQLite, NOT inside td's own `issues.db`. td owns and migrates
 * `issues.db` (29 versioned migrations, no namespace isolation), so co-locating
 * checkpoint tables there risks a future td migration dropping them. A separate
 * file keeps the two schemas independently owned and recoverable.
 */
export function createSqliteCheckpointer(repoPath: string): BunSqliteSaver {
  const dir = join(repoPath, '.todos');
  mkdirSync(dir, { recursive: true });
  return BunSqliteSaver.fromPath(join(dir, 'case-checkpoints.db'));
}
