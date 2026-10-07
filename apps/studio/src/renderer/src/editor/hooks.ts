import type { Element, ValidationIssue } from '@autoflow/flow-types';
import { stepPath } from '@autoflow/flow-types';
import { useCallback, useMemo } from 'react';
import { collectVariables, knownColumns, variablesInScope, type VariableInfo } from '../lib/scope';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useRun } from '../store/run';

/** Every variable the flow defines or sets. */
export function useFlowVariables(): VariableInfo[] {
  const flow = useEditor((s) => s.flow);
  const index = useApp((s) => s.index);
  return useMemo(() => (flow ? collectVariables(flow, index) : []), [flow, index]);
}

/** Variables usable by a given step (loop items only inside their loop). */
export function useScopeVariables(stepId: string | null): VariableInfo[] {
  const flow = useEditor((s) => s.flow);
  const all = useFlowVariables();
  return useMemo(() => {
    if (!flow || !stepId) return all.filter((v) => !v.loopStepId);
    return variablesInScope(all, stepPath(flow, stepId));
  }, [flow, all, stepId]);
}

/** Columns known for a variable (from the last test run). */
export function useColumns(): (name: string) => string[] {
  const all = useFlowVariables();
  const values = useRun((s) => s.values);
  return useCallback((name: string) => knownColumns(name, all, values), [all, values]);
}

export function useElements(): Map<string, Element> {
  const elements = useEditor((s) => s.flow?.elements);
  return useMemo(() => new Map((elements ?? []).map((e) => [e.id, e])), [elements]);
}

export function useStepIssues(stepId: string): ValidationIssue[] {
  const issues = useEditor((s) => s.issues);
  return useMemo(() => issues.filter((i) => i.step_id === stepId), [issues, stepId]);
}
