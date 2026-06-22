import type { AgentName, AgentResult, PipelineConfig, RevisionRequest, ScoutFindings } from './types.js';
import { TaskStore } from './state/task-store.js';
import { formatDuration } from './notify.js';
import { createStructuredLogRenderer } from './render/structured-log.js';
import { createTuiRenderer, type TuiRenderer } from './render/tui-renderer.js';
import type { Notifier } from './notify.js';
import { writeRunMetrics } from './metrics/writer.js';
import { getCurrentPromptVersions, findPriorRunId } from './versioning/prompt-tracker.js';
import { RunState } from './state/run-state.js';
import { generatePlan } from './events/plan.js';
import { projectMetrics } from './events/projections.js';
import { PiRuntimeAdapter } from './agent/adapters/pi-adapter.js';
import { createLogger } from './util/logger.js';
import { dispatchNode, type DispatchNodeRef } from './pipeline-dispatch.js';
import { executeLangGraph } from './langgraph/engine.js';
import { createSqliteCheckpointer } from './langgraph/checkpointer.js';
import { createLangfuseTracer } from './tracing/langfuse.js';

const log = createLogger();

export async function runPipeline(config: PipelineConfig): Promise<void> {
  // Task state is backed by the repo's `td` store (see td-client.ts).
  const store = new TaskStore(config.repoPath, config.tdId);
  // Renderer selection: TUI wins when explicitly requested (even over a
  // pre-built notifier from cli-orchestrator's setup phase). Otherwise an
  // explicit notifier takes priority, falling back to structured log.
  let tuiRenderer: TuiRenderer | null = null;
  let notifier: Notifier;
  if (config.renderer === 'tui') {
    tuiRenderer = createTuiRenderer({ mode: config.mode });
    notifier = tuiRenderer;
  } else if (config.notifier) {
    notifier = config.notifier;
  } else {
    notifier = createStructuredLogRenderer({ mode: config.mode });
  }
  const previousResults = new Map<AgentName, AgentResult>();

  // Bridge tool activity from adapters into the renderer.
  config.onToolActivity = (event) => {
    if (event.type === 'start') {
      notifier.toolStart(event.tool, event.args ?? '');
    } else {
      notifier.toolEnd(event.tool, event.durationMs ?? 0, event.isError ?? false);
    }
  };
  // Keep legacy heartbeat as a safety net for adapters that don't fire onToolActivity.
  config.onAgentHeartbeat = (elapsedMs) => {
    notifier.send(`  ... still running (${formatDuration(elapsedMs)})`);
  };

  // Ctrl+C: abort the active agent and clean up.
  const sigintHandler = () => {
    config.runtime?.abort();
    if (tuiRenderer) tuiRenderer.destroy();
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  try {
    await runPipelineBody(config, store, notifier, previousResults);
  } finally {
    process.off('SIGINT', sigintHandler);
    tuiRenderer?.destroy();
  }
}

async function runPipelineBody(
  config: PipelineConfig,
  store: TaskStore,
  notifier: Notifier,
  previousResults: Map<AgentName, AgentResult>,
): Promise<void> {
  let humanOverrides = 0;

  const task = await store.read();
  const profile = task.profile ?? 'standard';
  const maxRevisionCycles = config.maxRevisionCycles ?? 2;

  const runId = crypto.randomUUID();
  config.runtime ??= new PiRuntimeAdapter();

  // Langfuse dispatch (Phase 2.1+) — fire-and-forget per-run trace, now the sole
  // observability sink (the granular JSONL log was deleted in 2.2). Null when keys
  // are unset → no trace; the run is unaffected. Never blocks the control path.
  const langfuse = createLangfuseTracer(runId, { id: task.id });
  config.langfuse = langfuse;

  const plan = generatePlan(task, config, runId);

  // In-memory run-state (Phase 2.2) — replaces the EventAppender. Drives the
  // node-direct td/marker projection, run metrics, and the retrospective snapshot.
  const runState = new RunState({ runId, taskId: task.id, profile, plan });
  config.runState = runState;

  const { mkdir: mkdirPlan, writeFile: writePlan } = await import('node:fs/promises');
  const { resolve: resolvePlan } = await import('node:path');
  // Plan + event log live under <repo>/.case/<taskId>/ — mutable runtime state.
  const planDir = resolvePlan(config.dataDir, '.case', task.id);
  await mkdirPlan(planDir, { recursive: true });
  await writePlan(resolvePlan(planDir, 'plan.json'), JSON.stringify(plan, null, 2));

  // Prompt versions are static package assets; run metrics are appended under the repo .case dir.
  const promptVersions = await getCurrentPromptVersions(config.packageRoot);
  let outcome: 'completed' | 'failed' = 'completed';
  let failedAgent: AgentName | undefined;

  log.info('pipeline started', { phase: 'init', mode: config.mode, task: task.id, runId });

  // Shared scout findings — populated by the scout dispatch, consumed by
  // the implementer dispatch. Closed-over so revision cycles also see the
  // same findings (scout runs once per pipeline).
  const scoutSlot: { current: ScoutFindings | null } = { current: null };

  // Engine-agnostic per-phase dispatcher. Both the legacy DAG executor and the
  // LangGraph engine call through this, so per-phase semantics (matrix consult,
  // abort prompts, scout hand-off, previousResults bookkeeping) stay identical.
  const dispatch = async (node: DispatchNodeRef, revision?: RevisionRequest): Promise<AgentResult> =>
    dispatchNode(node, config, store, previousResults, notifier, revision, {
      incrementHumanOverrides: () => {
        humanOverrides++;
      },
      outcome: () => outcome,
      setOutcome: (o) => {
        outcome = o;
      },
      setFailedAgent: (a) => {
        failedAgent = a;
      },
      getScoutFindings: () => scoutSlot.current,
      setScoutFindings: (f) => {
        scoutSlot.current = f;
      },
    });

  // LangGraph owns orchestration AND crash/abort resume via the SQLite
  // checkpointer (sibling DB in <repo>/.todos/, RFC §6). The thread is keyed by
  // task id, so an interrupted run of the same task resumes from its last
  // superstep; the engine drops the thread on normal completion. td seeds the
  // first run's pending revision (resume-at-implement); the checkpoint is
  // authoritative once a run has begun. Resume is checkpointer-only.

  // A td-persisted pending revision seeds the cumulative revision-cycle count so
  // metrics + the retrospective snapshot see the pre-crash cycles even though no
  // new revision is requested on this resumed run. The graph state is seeded
  // separately via `initialPendingRevision` (the engine routes to implement and
  // carries the revision into the cycle counters).
  if (task.pendingRevision) {
    runState.seedRevision(task.pendingRevision);
  }

  const checkpointer = createSqliteCheckpointer(config.repoPath);
  await executeLangGraph({
    profile,
    maxRevisionCycles,
    runState,
    langfuse,
    store,
    caseRoot: config.dataDir,
    notifier,
    dispatch,
    onPhaseFailed: (agent) => {
      outcome = 'failed';
      failedAgent = agent;
    },
    initialPendingRevision: task.pendingRevision ?? null,
    checkpointer,
    threadId: task.id,
  });

  const totalDurationMs = Date.now() - Date.parse(runState.getState().startedAt);

  runState.end(outcome, failedAgent, totalDurationMs);

  const runMetrics = projectMetrics(runState.getState());
  runMetrics.promptVersions = promptVersions;
  runMetrics.humanOverrides = humanOverrides;
  const priorRunId = await findPriorRunId(config.repoPath, task.id);
  await writeRunMetrics(config.dataDir, task.id, config.repoName, runMetrics, {
    priorRunId,
    parentTaskId: task.contractPath,
  });

  // Flush the Langfuse trace. Bounded so a hung/unreachable sink can't stall run
  // teardown; the retrospective already read local runs.jsonl, never Langfuse.
  await langfuse?.shutdownSafely();

  log.info('pipeline finished', {
    outcome,
    failedAgent,
    runId,
    totalDurationMs: runMetrics.totalDurationMs,
  });

  // `outcome` is mutated only via the dispatch/onPhaseFailed closures, which
  // TS control-flow analysis can't see — it narrows `outcome` to its initializer
  // here. Widen the read so the runtime 'failed' branch isn't compiled away.
  if ((outcome as string) === 'failed') {
    notifier.send(`Pipeline failed at ${failedAgent ?? 'unknown'} phase.`);
  } else {
    notifier.send('Pipeline completed successfully.');
  }
}

// Per-phase dispatch (scout/implement/verify/review/close/retrospective) lives
// in `pipeline-dispatch.ts` so the LangGraph engine and the per-phase logic
// share one seam. See `dispatchNode` / `PipelineCallbacks`.
