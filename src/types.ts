/** Status lifecycle — mirrors task-status.sh TRANSITIONS map */
export type TaskStatus = 'active' | 'implementing' | 'verifying' | 'reviewing' | 'approving' | 'closing' | 'pr-opened' | 'merged';

export type AgentName = 'orchestrator' | 'implementer' | 'verifier' | 'reviewer' | 'closer';

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
  issueType?: 'github' | 'linear' | 'freeform' | 'ideation';
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

export type PipelineProfile = 'tiny' | 'standard' | 'complex';

/** Which phases run for each profile. Order matters — pipeline executes in this order. */
export const PROFILE_PHASES: Record<PipelineProfile, PipelinePhase[]> = {
  tiny: ['implement', 'review', 'close', 'retrospective'],
  standard: ['implement', 'verify', 'review', 'close', 'retrospective'],
  complex: ['implement', 'verify', 'review', 'close', 'retrospective'],
};

export type PipelinePhase = 'implement' | 'verify' | 'review' | 'approve' | 'close' | 'retrospective' | 'complete' | 'abort';

/** Canonical phase execution order (excludes terminal phases). Used for profile-based skip logic. */
export const PHASE_ORDER: PipelinePhase[] = ['implement', 'verify', 'review', 'approve', 'close', 'retrospective'];

export interface PipelineConfig {
  mode: PipelineMode;
  taskJsonPath: string;
  taskMdPath: string;
  repoPath: string;
  repoName: string;
  caseRoot: string;
  maxRetries: number;
  dryRun: boolean;
  /** Enable human approval gate between review and close */
  approve?: boolean;
  /** Max evaluator→implementer revision cycles (default: 2) */
  maxRevisionCycles?: number;
  /** Called periodically with elapsed ms while an agent is running. */
  onAgentHeartbeat?: (elapsedMs: number) => void;
  /** Per-run trace writer for tool-level observability. */
  traceWriter?: import('./tracing/writer.js').TraceWriter;
}

export interface ProjectEntry {
  name: string;
  path: string;
  remote: string;
  description?: string;
  language: string;
  packageManager: string;
  commands: Record<string, string>;
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

/** Evidence payload assembled for the approval gate web UI */
export interface ApprovalEvidence {
  task: {
    id: string;
    title: string;
    repo: string;
    branch: string;
    issue?: string;
  };
  diff: {
    summary: { additions: number; deletions: number; filesChanged: number };
    files: Array<{
      path: string;
      additions: number;
      deletions: number;
      status: 'added' | 'modified' | 'deleted' | 'renamed';
      hunks: Array<{ header: string; lines: string[] }>;
    }>;
  };
  tests: {
    passed: boolean | null;
    summary: string | null;
  };
  verifier: {
    ran: boolean;
    rubric: RubricCategory[] | null;
    summary: string | null;
  };
  reviewer: {
    ran: boolean;
    rubric: RubricCategory[] | null;
    findings: ReviewFindings | null;
    summary: string | null;
  };
  screenshots: string[];
  commit: string | null;
}

/** Decision returned by the approval gate web UI */
export interface ApprovalDecision {
  decision: 'approve' | 'revise' | 'reject';
  feedback?: string;
  manualEdit?: boolean;
}

/** Structured revision request from evaluator (verifier/reviewer) when fixable issues are found */
export interface RevisionRequest {
  /** Which evaluator triggered the revision */
  source: 'verifier' | 'reviewer' | 'human';
  /** Which rubric categories failed */
  failedCategories: RubricCategory[];
  /** Human-readable summary of what needs fixing */
  summary: string;
  /** Specific files or areas to focus on */
  suggestedFocus: string[];
  /** Which revision cycle this is (1-indexed) */
  cycle: number;
}

export interface PhaseOutput {
  result: AgentResult;
  nextPhase: PipelinePhase;
  /** Structured revision request when evaluator found fixable issues */
  revision?: RevisionRequest;
}

export interface AgentModelConfig {
  provider: string;
  model: string;
}

export interface SpawnAgentOptions {
  prompt: string;
  cwd: string;
  agentName: AgentName | 'retrospective';
  caseRoot: string;
  timeout?: number;
  /** Model provider (default: "anthropic") */
  provider?: string;
  /** Model ID (default: "claude-sonnet-4-20250514") */
  model?: string;
  /** Called periodically with elapsed ms while the agent is running. */
  onHeartbeat?: (elapsedMs: number) => void;
  /** Trace writer for per-run observability. */
  traceWriter?: import('./tracing/writer.js').TraceWriter;
  /** Current pipeline phase (used for trace events). */
  phase?: PipelinePhase;
}

export interface SpawnAgentResult {
  raw: string;
  result: AgentResult;
  durationMs: number;
}

// --- From-Ideation ---

export interface FromIdeationOptions {
  ideationFolder: string;
  caseRoot: string;
  repoName: string;
  repoPath: string;
  /** Specific phase to execute (default: all) */
  phase?: number;
  /** Called with progress updates during execution */
  onProgress?: (message: string) => void;
}

export interface PhaseResult {
  phase: number;
  specFile: string;
  status: 'completed' | 'failed' | 'skipped';
  commit: string | null;
  summary: string;
  error: string | null;
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

export type TriggerSource =
  | { type: 'cli'; user: string }
  | { type: 'webhook'; event: string; deliveryId: string }
  | { type: 'scanner'; scanner: string; runId: string }
  | { type: 'manual'; description: string };

export interface TaskCreateRequest {
  repo: string;
  title: string;
  description: string;
  issueType?: 'github' | 'linear' | 'freeform' | 'ideation';
  issue?: string;
  mode?: PipelineMode;
  profile?: PipelineProfile;
  trigger: TriggerSource;
  autoStart?: boolean;
  checkCommand?: string;
  checkBaseline?: number;
  checkTarget?: number;

  /** Verification scenarios the verifier will test (done contract) */
  verificationScenarios?: string;
  /** What is explicitly NOT in scope (done contract) */
  nonGoals?: string;
  /** Edge cases to consider (done contract) */
  edgeCases?: string;
  /** What evidence proves the fix works (done contract) */
  evidenceExpectations?: string;
}

// --- Wave 5: Scanners ---

export interface ScannerConfig {
  enabled: boolean;
  intervalMs: number;
  repos: string[];
  autoStart: boolean;
}

export interface ServerConfig {
  port: number;
  host: string;
  webhookSecret?: string;
  scanners: {
    ci: ScannerConfig;
    staleDocs: ScannerConfig;
    deps: ScannerConfig;
  };
}
