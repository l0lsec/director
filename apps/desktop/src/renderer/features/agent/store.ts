import { create } from 'zustand';
import type { ApprovalRequest } from '@director/agent';
import type { McpStatus } from '../../../main/mcp/server';

export interface Activity {
  id: string;
  client: string;
  tool: string;
  kind: 'read' | 'edit' | 'act';
  status: 'running' | 'waiting' | 'applied' | 'done' | 'rejected' | 'error';
  summary: string;
  at: number;
  ms?: number;
  error?: string;
}

export interface PendingApproval extends ApprovalRequest { id: string; client: string; at: number; resolve: (r: { ok: boolean; reason?: string }) => void }

interface AgentState {
  status: McpStatus | null;
  activity: Activity[];
  queue: PendingApproval[];
}

export const useAgent = create<AgentState>(() => ({ status: null, activity: [], queue: [] }));

export function logActivity(a: Activity): void {
  useAgent.setState((s) => ({ activity: [a, ...s.activity.filter((x) => x.id !== a.id)].slice(0, 300) }));
}
export function updateActivity(id: string, patch: Partial<Activity>): void {
  useAgent.setState((s) => ({ activity: s.activity.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}
export const agentMode = (): 'ask' | 'auto' => useAgent.getState().status?.mode ?? 'ask';
