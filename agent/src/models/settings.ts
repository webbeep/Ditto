// User-facing agent settings. Persisted by the browser (Ditto prefs) and
// edited in the side panel's model page.

import {recommendForMemory} from './catalog.js';

// off:          no model is ever loaded; the runtime process is not started.
// decider-only: the decider navigates; answers are the passages it rates as
//               relevant (no generated text).
// llm-only:     the LLM plans, navigates and answers (slower, more RAM).
// hybrid:       the decider navigates, the LLM plans and writes the answer,
//               and steps the decider is unsure about go to the LLM.
export type AgentMode = 'off'|'decider-only'|'llm-only'|'hybrid';

export interface AgentSettings {
  mode: AgentMode;
  llmId: string;
  deciderId: string;
  // Base URL of a strands-decider sidecar (`strands-decider serve`), used when
  // the chosen decider's runtime is 'strands'.
  strandsEndpoint: string;
  maxSteps: number;
  // Decider confidence below which hybrid mode asks the LLM instead.
  escalateBelow: number;
  // P(yes) at which the decider considers the goal reached.
  doneAbove: number;
  modelBudgetMB: number;
}

export function defaultSettings(totalMemoryMB: number): AgentSettings {
  const rec = recommendForMemory(totalMemoryMB);
  return {
    mode: 'hybrid',
    llmId: rec.llm,
    deciderId: rec.decider,
    strandsEndpoint: 'http://127.0.0.1:8737',
    maxSteps: 20,
    escalateBelow: 0.35,
    doneAbove: 0.7,
    modelBudgetMB: rec.modelBudgetMB,
  };
}

export function usesLlm(mode: AgentMode): boolean {
  return mode === 'llm-only' || mode === 'hybrid';
}

export function usesDecider(mode: AgentMode): boolean {
  return mode === 'decider-only' || mode === 'hybrid';
}
