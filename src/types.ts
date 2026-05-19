/** Status lifecycle — derived from pipeline graph node state via projectStatusFromGraph() */
export type TaskStatus =
  | 'active'
  | 'implementing'
  | 'verifying'
  | 'reviewing'
  | 'evaluating'
  | 'closing'
  | 'pr-opened'
  | 'merged';

export type AgentName = 'orchestrator' | 'implementer' | 'verifier' | 'reviewer' | 'closer' | 'scout';

export interface AgentPhase {
  started: string | null;
  completed: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface TaskJson {
  id: string;
  status: TaskStatus;
  created: string;
  repo: string;
  issue?: string;
  issueType?: 'github' | 'linear' | 'freeform';
  contractPath?: string | null;
  branch?: string;
  mode?: PipelineMode;
  /** Pipeline profile — determines which phases run (default: 'standard') */
  profile?: PipelineProfile;
  agents: Partial<Record<AgentName, AgentPhase>>;
  tested: boolean;
  manualTested: boolean;
  prUrl: string | null;
  prNumber: number | null;
  fastTestCommand?: string | null;
  checkCommand?: string | null;
  checkBaseline?: number | null;
  checkTarget?: number | null;
  /** Persisted revision request — ensures crash/restart resumes at implement with evaluator context */
  pendingRevision?: RevisionRequest | null;
}

/** Matches SKILL.md Subagent Output Contract */
export interface AgentResult {
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
  artifacts: {
    commit: string | null;
    filesChanged: string[];
    testsPassed: boolean | null;
    screenshotUrls: string[];
    evidenceMarkers: string[];
    prUrl: string | null;
    prNumber: number | null;
  };
  findings?: ReviewFindings;
  /** Structured rubric from evaluator agents (verifier/reviewer) */
  rubric?: Rubric;
  error: string | null;
}

export interface ReviewFindings {
  critical: number;
  warnings: number;
  info: number;
  details: Array<{
    severity: string;
    principle: string;
    message: string;
    file: string;
    line: number | null;
  }>;
}

export type RubricVerdict = 'pass' | 'fail' | 'na';

export interface RubricCategory {
  /** Category name (e.g., "reproduced-scenario") */
  category: string;
  /** Binary verdict */
  verdict: RubricVerdict;
  /** Finding text when verdict is fail; brief note when pass/na */
  detail: string;
}

/**
 * Verifier rubric — behavioral truth.
 * Categories: reproduced-scenario, exercised-changed-path, evidence-proves-change, edge-case-checked
 */
export interface VerifierRubric {
  role: 'verifier';
  categories: RubricCategory[];
}

/**
 * Reviewer rubric — architectural truth.
 * Categories: principle-compliance, test-sufficiency, scope-discipline, pattern-fit
 */
export interface ReviewerRubric {
  role: 'reviewer';
  categories: RubricCategory[];
}

export type Rubric = VerifierRubric | ReviewerRubric;

/** Reviewer rubric categories classified by gate severity. */
export const REVIEWER_HARD_CATEGORIES = ['principle-compliance', 'scope-discipline'] as const;
export const REVIEWER_SOFT_CATEGORIES = ['test-sufficiency', 'pattern-fit'] as const;

export type PipelineMode = 'attended' | 'unattended';

export type PipelineProfile = 'tiny' | 'standard';

/** Which phases run for each profile. Order matters — pipeline executes in this order. */
export const PROFILE_PHASES: Record<PipelineProfile, PipelinePhase[]> = {
  tiny: ['implement', 'review', 'close', 'retrospective'],
  standard: ['scout', 'implement', 'verify', 'review', 'close', 'retrospective'],
};

export type PipelinePhase =
  | 'setup'
  | 'scout'
  | 'implement'
  | 'verify'
  | 'review'
  | 'close'
  | 'retrospective'
  | 'complete'
  | 'abort';

/** Canonical phase execution order (excludes terminal phases). Used for profile-based skip logic. */
export const PHASE_ORDER: PipelinePhase[] = ['scout', 'implement', 'verify', 'review', 'close', 'retrospective'];

export interface PipelineConfig {
  mode: PipelineMode;
  taskJsonPath: string;
  taskMdPath: string;
  repoPath: string;
  repoName: string;
  /** Project metadata from projects.json, when the config was built from the manifest. */
  project?: ProjectEntry;
  /** Disk checkout for package asset overrides, or embedded://case in portable binaries. */
  packageRoot: string;
  /** Target repo root; mutable runtime state lives under `<dataDir>/.case/`. */
  dataDir: string;
  maxRetries: number;
  dryRun: boolean;
  /** Max evaluator→implementer revision cycles (default: 2) */
  maxRevisionCycles?: number;
  /** Called periodically with elapsed ms while an agent is running. */
  onAgentHeartbeat?: (elapsedMs: number) => void;
  /** Called on every tool start/end during agent execution. Used to drive live terminal feedback. */
  onToolActivity?: (event: import('./render/types.js').ToolActivityEvent) => void;
  /** Optional pre-built notifier override (tests / custom renderers). Defaults to StructuredLogRenderer. */
  notifier?: import('./notify.js').Notifier;
  /** Per-run trace writer for tool-level observability (deprecated — use eventAppender). */
  traceWriter?: { write(event: any): void; flush(): Promise<void>; path: string };
  /** Event appender for unified event logging. */
  eventAppender?: import('./events/appender.js').EventAppender;
  /** Agent runtime for spawning agents. */
  runtime?: import('./agent/runtime.js').CaseAgentRuntime;
  /**
   * Renderer selector: `'structured'` (default) is the line-based stdout
   * renderer; `'tui'` launches a full-screen pi-tui session. Ignored when a
   * pre-built `notifier` is supplied.
   */
  renderer?: 'structured' | 'tui';
}

export type EvidenceStrategy = 'ui-screenshot' | 'scenario-script' | 'test-output';

export const DEFAULT_CREDENTIALS_PATH = '~/.config/case/credentials';

export interface ProjectEntry {
  name: string;
  evidenceStrategy: EvidenceStrategy;
  path: string;
  remote: string;
  description?: string;
  language: string;
  packageManager: string;
  commands: Record<string, string>;
  credentials?: string;
  verificationNotes?: string;
}

export function resolveEvidenceStrategy(project?: ProjectEntry): EvidenceStrategy {
  return project?.evidenceStrategy ?? 'test-output';
}

export interface FailureAnalysis {
  failureClass: string;
  failedAgent: string;
  errorSummary: string;
  filesInvolved: string[];
  whatWasTried: string[];
  suggestedFocus: string;
  retryViable: boolean;
}

/** Structured revision request from evaluator (verifier/reviewer) when fixable issues are found */
export interface RevisionRequest {
  /** Which evaluator triggered the revision */
  source: 'verifier' | 'reviewer';
  /** Which rubric categories failed */
  failedCategories: RubricCategory[];
  /** Human-readable summary of what needs fixing */
  summary: string;
  /** Specific files or areas to focus on */
  suggestedFocus: string[];
  /** Which revision cycle this is (1-indexed) */
  cycle: number;
  /**
   * Optional failure fingerprint — truncated SHA-256 of
   * `failedCategories.sort().join(':') + '|' + errorSummary` (see
   * `src/dag/fingerprint.ts`). Populated by the executor after the evaluator
   * pair completes so the next cycle can detect identical failures.
   */
  fingerprint?: string;
}

/**
 * Failure fingerprint used to detect identical failures across revision cycles.
 * See `src/dag/fingerprint.ts` for the hashing rules.
 */
export interface FailureFingerprint {
  /** Truncated SHA-256 (16 hex chars). */
  value: string;
  /** Cycle that produced this fingerprint (0-indexed). */
  cycle: number;
}

export interface PhaseOutput {
  result: AgentResult;
  nextPhase: PipelinePhase;
  /** Structured revision request when evaluator found fixable issues */
  revision?: RevisionRequest;
  /**
   * Typed phase outcome. Populated by phase implementations so the executor
   * can consult the unified failure matrix (`src/dag/outcome-table.ts`)
   * instead of inferring from `nextPhase` / `revision`. The legacy fields
   * remain populated for backwards compatibility.
   */
  outcome?: PhaseOutcome;
}

/** Phase names that participate in the unified outcome matrix. */
export type PhaseName = 'scout' | 'implement' | 'verify' | 'review' | 'close' | 'retrospective';

/**
 * Closed enumeration of outcomes that any phase may surface. The matrix
 * (`src/dag/outcome-table.ts`) maps every applicable (phase, outcome) pair
 * to a concrete next-action. No catch-all `'unknown'` variant — new failure
 * modes must be added here and to the matrix together.
 */
export type OutcomeKind =
  | 'success'
  | 'fail-test'
  | 'fail-type-error'
  | 'fail-lint'
  | 'fail-build'
  | 'fail-timeout'
  | 'fail-agent-protocol'
  | 'fail-no-code-changes'
  | 'fail-critical-findings'
  | 'fail-soft-findings'
  | 'fail-github-unreachable'
  | 'fail-evidence-missing'
  | 'abort-user'
  | 'budget-exhausted';

/**
 * Discriminated next-action surfaced by `resolveOutcome`. The executor
 * pattern-matches on `action` to determine routing without casting.
 */
export type OutcomeAction =
  | { action: 'advance'; to: PhaseName | 'complete' }
  | { action: 'retry'; maxAttempts: number }
  | { action: 'revision'; cycle: 'next' }
  | { action: 'abort'; reason: string }
  | { action: 'skip-to'; to: PhaseName | 'complete'; withWarning: string }
  | { action: 'surface'; message: string };

/**
 * A typed outcome surfaced by a phase, paired with optional human-readable
 * detail. The matrix key is `${phase}:${outcome}`.
 */
export interface PhaseOutcome {
  phase: PhaseName;
  outcome: OutcomeKind;
  details?: string;
}

/** Composite key shape for the outcome matrix. */
export type PhaseOutcomeKey = `${PhaseName}:${OutcomeKind}`;

export interface AgentModelConfig {
  provider: string;
  model: string;
}

export interface SpawnAgentOptions {
  prompt: string;
  cwd: string;
  agentName: AgentName | 'retrospective';
  /** Disk checkout for package asset overrides, or embedded://case in portable binaries. */
  packageRoot: string;
  /** Target repo root; mutable runtime state lives under `<dataDir>/.case/`. */
  dataDir: string;
  timeout?: number;
  /** Model provider (default: "anthropic") */
  provider?: string;
  /** Model ID (default: "claude-sonnet-4-20250514") */
  model?: string;
  /** Called periodically with elapsed ms while the agent is running. */
  onHeartbeat?: (elapsedMs: number) => void;
  /** Called on every tool start/end so renderers can show live activity. */
  onToolActivity?: (event: import('./render/types.js').ToolActivityEvent) => void;
  /** Trace writer for per-run observability (deprecated — use eventAppender). */
  traceWriter?: { write(event: any): void; flush(): Promise<void>; path: string };
  /** Event appender for unified event logging. */
  eventAppender?: import('./events/appender.js').EventAppender;
  /** Current pipeline phase (used for trace events). */
  phase?: PipelinePhase;
}

export interface SpawnAgentResult {
  raw: string;
  result: AgentResult;
  durationMs: number;
}

// --- Standalone CLI ---

/** Normalized issue context from GitHub, Linear, or freeform text. */
export interface IssueContext {
  title: string;
  body: string;
  labels: string[];
  issueType: 'github' | 'linear' | 'freeform';
  issueNumber: string;
}

// --- Wave 5: Metrics ---

export interface PhaseMetrics {
  phase: PipelinePhase;
  agent: AgentName | 'retrospective';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'skipped';
  retried: boolean;
}

export interface RunMetrics {
  runId: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  outcome: 'completed' | 'failed';
  failedAgent?: AgentName;
  phases: PhaseMetrics[];
  ciFirstPush: boolean | null;
  reviewFindings: ReviewFindings | null;
  promptVersions: Record<string, string>;
  /** Number of revision cycles executed (verify→re-implement or review→re-implement) */
  revisionCycles: number;

  /** Pipeline profile used for this run */
  profile: PipelineProfile;

  /** Number of times a human overrode an evaluator decision (attended mode) */
  humanOverrides: number;

  /** Evaluator effectiveness signals */
  evaluatorEffectiveness: EvaluatorEffectiveness;
}

export interface EvaluatorEffectiveness {
  /** Verifier rubric results (if verifier ran) */
  verifierRubric: RubricCategory[] | null;

  /** Reviewer rubric results (if reviewer ran) */
  reviewerRubric: RubricCategory[] | null;

  /** Did a revision cycle fix the evaluator's findings? (null if no revision) */
  revisionFixedIssues: boolean | null;

  /** Phases that were skipped due to profile */
  skippedPhases: PipelinePhase[];
}

// --- Wave 5: Entry points ---

export type TriggerSource = { type: 'cli'; user: string } | { type: 'manual'; description: string };

export interface TaskCreateRequest {
  repo: string;
  title: string;
  description: string;
  issueType?: 'github' | 'linear' | 'freeform';
  issue?: string;
  mode?: PipelineMode;
  profile?: PipelineProfile;
  trigger: TriggerSource;
  checkCommand?: string;
  checkBaseline?: number;
  checkTarget?: number;

  /** Verification scenarios the verifier will test (done contract) */
  verificationScenarios?: string;
  /** What is explicitly NOT in scope (done contract) */
  nonGoals?: string;
  /** Edge cases to consider (done contract) */
  edgeCases?: string;
  /** What evidence proves the fix works — required for all tasks (done contract) */
  evidenceExpectations: string;
}

// --- Working Memory (Phase 3: Agent Working Memory Protocol) ---

/**
 * Structured, schema-validated working memory persisted between phases.
 *
 * Lives at `<repoPath>/.case/<task-slug>/working-memory.json`. Written by
 * agents via `ca update-memory`, read by the orchestrator to inject prior
 * context into each phase's prompt. Versioned for forward-compat.
 */
export interface WorkingMemory {
  /** Schema version — bump on breaking changes. */
  version: 1;
  /** ISO-8601 datetime of the last write. */
  updatedAt: string;
  /** Short description of what the agent is currently doing or last completed. */
  currentState: string;
  /** Current implementation strategy. */
  approach: string;
  /** Files modified in this session. Appended on update. */
  filesChanged: string[];
  /** Errors encountered and their resolution status. Appended on update. */
  errorsSeen: WorkingMemoryError[];
  /** Approaches tried and their outcomes. Appended on update. */
  approachesTried: WorkingMemoryApproach[];
  /** Current blocking issues. Appended on update. */
  blockers: string[];
}

export interface WorkingMemoryError {
  error: string;
  file?: string;
  resolution: 'fixed' | 'workaround' | 'unresolved';
}

export interface WorkingMemoryApproach {
  approach: string;
  outcome: 'success' | 'partial' | 'failed';
  reason?: string;
}

/** Partial update payload — every field is optional. Arrays append, scalars replace. */
export type WorkingMemoryUpdate = Partial<Omit<WorkingMemory, 'version' | 'updatedAt'>>;

// --- Phase 4: Scout findings ---

/**
 * Structured findings returned by the scout agent. Synthesized into a markdown
 * section and injected into the implementer's prompt so it starts with concrete
 * file paths, patterns to follow, and known constraints instead of having to
 * rediscover the layout from scratch.
 *
 * Optional fields (`testBaseline`, `suggestedApproach`) may be absent on
 * partial findings; the synthesis function tolerates either case.
 */
export interface ScoutFindings {
  relevantFiles: Array<{ path: string; reason: string }>;
  patterns: Array<{ name: string; file: string; description: string }>;
  testBaseline?: {
    command: string;
    passing: number;
    failing: number;
    relevant: string[];
  };
  constraints: string[];
  suggestedApproach?: string;
}

// --- Interview findings (ca onboard --interview) ---

/**
 * Repo classification used to validate evidence strategy and drive
 * conventions/seed content. The interviewer asks targeted questions to pin
 * this down; the synthesizer uses it as the input to `validateEvidenceStrategy`.
 */
export type RepoType = 'sdk' | 'app' | 'library' | 'cli' | 'monorepo';

/**
 * Structured output emitted by the interviewer agent inside an `AGENT_RESULT`
 * block. Captures everything `ca onboard --interview` needs to:
 *
 *   1. Override the evidence-strategy heuristic with a human-confirmed choice.
 *   2. Populate `verificationNotes` / `credentials` in the projects.json entry.
 *   3. Seed `<repo>/.case/learnings.md` with initial topic/content pairs.
 *   4. Seed `<repo>/CLAUDE.local.md` with repo-specific conventions.
 *
 * Optional fields default to a no-op during synthesis. The schema mirrors
 * `ScoutFindings` — hand-rolled validator, additive top-level keys, graceful
 * degradation when the agent returns a partially-formed payload.
 */
export interface InterviewFindings {
  /** Evidence strategy chosen by the human via the interview (overrides heuristic). */
  evidenceStrategy: EvidenceStrategy;
  /** Why this strategy fits this repo — captured for debugging wrong choices. */
  evidenceRationale: string;
  /** Verification context the verifier needs (env vars, auth flows, gotchas). */
  verificationNotes: string;
  /** Optional path to a credentials file the verifier should reference. */
  credentials?: string;
  /** Short human-curated description of the repo (overrides package.json description). */
  description: string;

  /**
   * Per-command overrides that win over auto-detected values from probeRepo().
   * Only present keys override; absent keys keep the detected command.
   */
  commandOverrides: Record<string, string>;

  /** Seed entries for `<repo>/.case/learnings.md`. */
  learnings: Array<{ topic: string; content: string }>;

  /** Convention rules for `<repo>/CLAUDE.local.md`. */
  conventions: Array<{ rule: string; reason: string }>;

  /** Repo classification — drives evidence-strategy validation. */
  repoType: RepoType;
  /** Whether the repo ships with an example app the verifier could exercise. */
  hasExampleApp: boolean;
  /** Detected test framework (e.g., 'vitest', 'jest', 'bun:test'). */
  testFramework: string;
  /** Detected CI provider (e.g., 'github-actions', 'circleci', 'none'). */
  ciProvider: string;
}

// Event system re-exports
export type { PipelineEvent } from './events/schema.js';
export type { PipelineState } from './events/types.js';
export type { PlanArtifact } from './events/plan.js';
