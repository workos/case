import { createReadTool, createWriteTool, createEditTool, createBashTool } from '@mariozechner/pi-coding-agent';
import type { AgentTool } from '@mariozechner/pi-agent-core';

export function getToolsForAgent(agentName: string, cwd: string): AgentTool<any>[] {
  switch (agentName) {
    case 'implementer':
    case 'retrospective':
      return [createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd)];
    case 'verifier':
    case 'reviewer':
    case 'closer':
    default:
      return [createReadTool(cwd), createBashTool(cwd)];
  }
}
