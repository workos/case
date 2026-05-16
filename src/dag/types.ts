import type { AgentName, PipelinePhase } from '../types.js';
import type { AgentResult } from '../types.js';

export type NodeId = string;

export type NodeState = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

export interface DagNode {
  id: NodeId;
  phase: PipelinePhase;
  agent: AgentName | 'retrospective';
  cycle: number;
  state: NodeState;
  result?: AgentResult;
  startedAt?: string;
  completedAt?: string;
}

export type EdgePredicate = (graph: PipelineGraph) => boolean;

export interface DagEdge {
  from: NodeId;
  to: NodeId;
  predicate?: EdgePredicate;
}

export interface PipelineGraph {
  nodes: Map<NodeId, DagNode>;
  edges: DagEdge[];
}
