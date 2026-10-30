// Models Ditto knows how to run. Every entry is a llama.cpp router id
// (`<hf-repo>:<quant>`) except the strands deciders, which need the
// strands-decider sidecar (LoRA + readout head; not a GGUF llama.cpp reads).
//
// File sizes are the published GGUF sizes on Hugging Face (Oct 2026). RAM
// estimates add the KV cache / compute buffers for Ditto's default context and
// are what the memory governor budgets with; the router's own measurement
// (`GET /models` -> memory) replaces them once it has one.

export type ModelRole = 'llm'|'decider';
export type Runtime = 'llama'|'strands';
export type Modality = 'text'|'image'|'audio'|'video';

export interface CatalogModel {
  id: string;
  name: string;
  family: 'LFM3'|'LFM2.5'|'Qwen3.5'|'d1'|'strands-decider';
  role: ModelRole;
  runtime: Runtime;
  params: string;
  downloadMB: number;
  ramMB: number;
  inputs: Modality[];
  license: string;
  // Sidecar files the router downloads with the model (`POST /models`).
  sidecars?: string[];
  // Per-model llama-server arguments, written to the router's preset file.
  serverArgs?: Record<string, string|number|boolean>;
  // Extra fields merged into every /v1/chat/completions request.
  requestDefaults?: Record<string, unknown>;
  notes?: string;
}

export const CATALOG: readonly CatalogModel[] = [
  // ---- Responders (LLMs) -------------------------------------------------
  {
    id: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M',
    name: 'LFM3 1.7B',
    family: 'LFM3',
    role: 'llm',
    runtime: 'llama',
    params: '1.7B',
    downloadMB: 1100,
    ramMB: 1500,
    inputs: ['text'],
    license: 'LFM Open License v1.0',
    serverArgs: {'c': 16384, 'reasoning': 'off'},
    requestDefaults: {temperature: 0},
    notes: 'Smallest responder; default on 8 GB Macs.',
  },
  {
    id: 'LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    name: 'LFM3 Omni 2B',
    family: 'LFM3',
    role: 'llm',
    runtime: 'llama',
    params: '2B',
    downloadMB: 1100 + 292,
    ramMB: 1950,
    inputs: ['text', 'image', 'audio', 'video'],
    license: 'LFM Open License v1.0',
    sidecars: ['mmproj'],
    serverArgs: {'c': 16384, 'reasoning': 'off'},
    requestDefaults: {temperature: 0},
    notes: 'Sees screenshots and hears audio; non-reasoning, greedy decoding.',
  },
  {
    id: 'unsloth/Qwen3.5-2B-GGUF:Q4_K_M',
    name: 'Qwen3.5 2B',
    family: 'Qwen3.5',
    role: 'llm',
    runtime: 'llama',
    params: '2B',
    downloadMB: 1281 + 668,
    ramMB: 2300,
    inputs: ['text', 'image'],
    license: 'Apache-2.0',
    sidecars: ['mmproj'],
    serverArgs: {'c': 16384},
    requestDefaults: {chat_template_kwargs: {enable_thinking: false},
                      temperature: 0.7, top_p: 0.8},
  },
  {
    id: 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M',
    name: 'Qwen3.5 4B',
    family: 'Qwen3.5',
    role: 'llm',
    runtime: 'llama',
    params: '4B',
    downloadMB: 2741 + 672,
    ramMB: 4000,
    inputs: ['text', 'image'],
    license: 'Apache-2.0',
    sidecars: ['mmproj'],
    serverArgs: {'c': 16384},
    requestDefaults: {chat_template_kwargs: {enable_thinking: false},
                      temperature: 0.7, top_p: 0.8},
    notes: 'Default responder on 16 GB+ Macs.',
  },
  {
    id: 'unsloth/Qwen3.5-9B-GGUF:Q4_K_M',
    name: 'Qwen3.5 9B',
    family: 'Qwen3.5',
    role: 'llm',
    runtime: 'llama',
    params: '9B',
    downloadMB: 5681 + 918,
    ramMB: 7600,
    inputs: ['text', 'image'],
    license: 'Apache-2.0',
    sidecars: ['mmproj'],
    serverArgs: {'c': 16384},
    requestDefaults: {chat_template_kwargs: {enable_thinking: false},
                      temperature: 0.7, top_p: 0.8},
    notes: 'Optional download for 32 GB+ Macs.',
  },
  {
    id: 'LiquidAI/LFM2.5-8B-A1B-GGUF:Q4_K_M',
    name: 'LFM2.5 8B-A1B (MoE)',
    family: 'LFM2.5',
    role: 'llm',
    runtime: 'llama',
    params: '8B (1B active)',
    downloadMB: 5156,
    ramMB: 6000,
    inputs: ['text'],
    license: 'LFM Open License v1.0',
    serverArgs: {'c': 16384},
    requestDefaults: {temperature: 0},
    notes: 'Fast for its size: only 1B parameters run per token.',
  },

  // ---- Deciders (decision models, /v1/systemone) -------------------------
  {
    id: 'LiquidAI/d1-omni-600M-GGUF:Q8_0',
    name: 'd1 Omni 600M',
    family: 'd1',
    role: 'decider',
    runtime: 'llama',
    params: '600M',
    downloadMB: 407 + 263,
    ramMB: 900,
    inputs: ['text', 'image', 'audio'],
    license: 'LFM Open License v1.0',
    sidecars: ['mmproj'],
    // A question is read in one batch: -b/-ub must hold the state.
    serverArgs: {'c': 16384, 'b': 8192, 'ub': 8192},
    notes: 'Smallest decider; default on 8 GB Macs.',
  },
  {
    id: 'LiquidAI/d1-2B-GGUF:Q4_K_M',
    name: 'd1 2B',
    family: 'd1',
    role: 'decider',
    runtime: 'llama',
    params: '1.9B',
    downloadMB: 1100 + 203,
    ramMB: 1900,
    inputs: ['text', 'image', 'video'],
    license: 'LFM Open License v1.0',
    sidecars: ['mmproj'],
    serverArgs: {'c': 32768, 'b': 8192, 'ub': 8192},
    notes: 'Best open d1 on the decision boards; default decider on 16 GB+.',
  },
  {
    id: 'LiquidAI/d1-Omni-2B-GGUF:Q8_0',
    name: 'd1 Omni 2B',
    family: 'd1',
    role: 'decider',
    runtime: 'llama',
    params: '2B',
    downloadMB: 1846 + 326,
    ramMB: 2700,
    inputs: ['text', 'image', 'audio', 'video'],
    license: 'LFM Open License v1.0',
    sidecars: ['mmproj'],
    serverArgs: {'c': 16384, 'b': 16384, 'ub': 16384},
  },
  {
    id: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    name: 'Strands decider 2B (Qwen3.5)',
    family: 'strands-decider',
    role: 'decider',
    runtime: 'strands',
    params: '2B + LoRA',
    // Qwen3.5-2B-Base safetensors (4548 MB) + adapter and head (214 MB).
    downloadMB: 4548 + 214,
    ramMB: 5200,
    inputs: ['text', 'image'],
    license: 'Apache-2.0',
    notes: 'Runs in the strands-decider sidecar (PyTorch/MPS). ' +
        'Install with scripts/install-strands-decider.sh.',
  },
  {
    id: 'StrandsAgents/strands-decider-E2B-gemma4-v1-2610',
    name: 'Strands decider E2B (Gemma 4)',
    family: 'strands-decider',
    role: 'decider',
    runtime: 'strands',
    params: 'E2B + LoRA',
    // gemma-4-E2B safetensors (10247 MB) + adapter and head (299 MB).
    downloadMB: 10247 + 299,
    ramMB: 10500,
    inputs: ['text'],
    license: 'Apache-2.0 (adapter); Gemma terms (base)',
    notes: 'Runs in the strands-decider sidecar.',
  },
];

export function findModel(id: string): CatalogModel|undefined {
  return CATALOG.find(m => m.id === id);
}

export function modelsForRole(role: ModelRole): CatalogModel[] {
  return CATALOG.filter(m => m.role === role);
}

export interface Recommendation {
  llm: string;
  decider: string;
  // Upper bound on RAM all loaded models may use together.
  modelBudgetMB: number;
}

// Picks the starter models for a machine. The budget leaves the browser and
// the OS at least half of physical memory (and never less than 5 GB), so the
// agent cannot push the Mac into swap.
export function recommendForMemory(totalMB: number): Recommendation {
  const modelBudgetMB = Math.max(0, Math.min(totalMB / 2, totalMB - 5 * 1024));
  if (totalMB >= 15 * 1024) {
    return {
      llm: 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M',
      decider: 'LiquidAI/d1-2B-GGUF:Q4_K_M',
      modelBudgetMB,
    };
  }
  return {
    llm: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M',
    decider: 'LiquidAI/d1-omni-600M-GGUF:Q8_0',
    modelBudgetMB,
  };
}

// The llama-server router preset (INI) for the catalog's llama models.
export function routerPresetIni(models: readonly CatalogModel[] = CATALOG): string {
  const lines = [
    'version = 1',
    '',
    '[*]',
    // Hide the bare cache entry when a preset covers the same repo.
    'dedup-cache-models = true',
    'stop-timeout = 5',
  ];
  for (const model of models) {
    if (model.runtime !== 'llama') {
      continue;
    }
    lines.push('', `[${model.id}]`);
    for (const [key, value] of Object.entries(model.serverArgs ?? {})) {
      lines.push(`${key} = ${value}`);
    }
  }
  return lines.join('\n') + '\n';
}
