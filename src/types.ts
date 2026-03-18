/** Status lifecycle — mirrors task-status.sh TRANSITIONS map */
export type TaskStatus = 'active' | 'implementing' | 'verifying' | 'reviewing' | 'closing' | 'pr-opened' | 'merged';

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
  agents: Partial<Record<AgentName, AgentPhase>>;
  tested: boolean;
  manualTested: boolean;
  prUrl: string | null;
  prNumber: number | null;
  fastTestCommand?: string | null;
  checkCommand?: string | null;
  checkBaseline?: number | null;
  checkTarget?: number | null;
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

export type PipelineMode = 'attended' | 'unattended';

export type PipelinePhase = 'implement' | 'verify' | 'review' | 'close' | 'retrospective' | 'complete' | 'abort';

export interface PipelineConfig {
  mode: PipelineMode;
  taskJsonPath: string;
  taskMdPath: string;
  repoPath: string;
  repoName: string;
  caseRoot: string;
  maxRetries: number;
  dryRun: boolean;
  /** Called periodically with elapsed ms while an agent is running. */
  onAgentHeartbeat?: (elapsedMs: number) => void;
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

export interface PhaseOutput {
  result: AgentResult;
  nextPhase: PipelinePhase;
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
  issueType?: 'github' | 'linear' | 'freeform';
  issue?: string;
  mode?: PipelineMode;
  trigger: TriggerSource;
  autoStart?: boolean;
  checkCommand?: string;
  checkBaseline?: number;
  checkTarget?: number;
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
