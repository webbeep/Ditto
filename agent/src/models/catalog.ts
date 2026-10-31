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
  // Extra fields merged into every /v1/chat/completions request.
  requestDefaults?: Record<string, unknown>;
  notes?: string;
}

// LFM3 is non-reasoning: greedy decoding with thinking off (what
// `llama-server --reasoning off` sets, sent per request instead).
const LFM3_REQUEST = {temperature: 0, chat_template_kwargs: {enable_thinking: false}};

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
    requestDefaults: LFM3_REQUEST,
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
    requestDefaults: LFM3_REQUEST,
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

// What the app reports about the Mac, for choosing models.
export interface DeviceInfo {
  totalMb: number;
  // 'arm64' (Apple silicon: Metal on unified memory) or 'x86_64' (Intel).
  arch: string;
  chip: string;
  freeDiskMb: number;
}

export interface DeviceAdvice extends Recommendation {
  // Why these, in a sentence or two.
  reasons: string[];
  downloadMB: number;
  // The pair does not fit on the disk (with room to spare).
  lowDisk: boolean;
}

const SMALLEST = {llm: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M', decider: 'LiquidAI/d1-omni-600M-GGUF:Q8_0'};
const pairMB = (pick: {llm: string, decider: string}) =>
    (findModel(pick.llm)?.downloadMB ?? 0) + (findModel(pick.decider)?.downloadMB ?? 0);

// The pair to suggest at first launch: by memory (recommendForMemory), the
// smallest on Intel Macs (no Metal on unified memory: the models run on the
// CPU, where size is speed) and when the disk is short.
export function recommendForDevice(device: DeviceInfo): DeviceAdvice {
  const gb = Math.round(device.totalMb / 1024);
  const base = recommendForMemory(device.totalMb);
  let pick = {llm: base.llm, decider: base.decider};
  const reasons: string[] = [];
  if (device.arch !== 'arm64') {
    pick = {...SMALLEST};
    reasons.push('Intel Macs run the models on the processor, so the smallest pair answers ' +
                 'fastest.');
  } else if (pick.llm !== SMALLEST.llm) {
    reasons.push(`With ${gb} GB of memory there is room for the more accurate pair, ` +
                 'with your tabs still comfortable.');
  } else {
    reasons.push(`With ${gb} GB of memory the small pair leaves your tabs room to breathe.`);
  }
  const spare = 2048;
  if (device.freeDiskMb && device.freeDiskMb < pairMB(pick) + spare &&
      pairMB(SMALLEST) + spare <= device.freeDiskMb) {
    pick = {...SMALLEST};
    reasons.push('Disk space is short, so the smallest pair.');
  }
  const downloadMB = pairMB(pick);
  return {
    ...pick, modelBudgetMB: base.modelBudgetMB, reasons, downloadMB,
    lowDisk: !!device.freeDiskMb && device.freeDiskMb < downloadMB + spare,
  };
}

// Runtime settings shared by every model, as the router preset (INI).
//
// Only the global [*] section: llama.cpp b11960 merges a section named after
// a Hugging Face model into that model's cache entry once it is downloaded,
// but before that the section is a separate model with no source (it fails
// to load and hides the download state), and a merged entry can no longer be
// deleted through the API. One shared setting avoids both.
//  - ctx-size: a fixed context; otherwise each instance grows its KV cache
//    to whatever memory is free.
//  - batch-size/ubatch-size: a decision model reads a whole question in one
//    batch, so the batch must hold the page state and the options.
export const RUNTIME_CONTEXT = 16384;
export const RUNTIME_BATCH = 4096;

export function routerPresetIni(): string {
  return [
    'version = 1',
    '',
    '[*]',
    `ctx-size = ${RUNTIME_CONTEXT}`,
    `batch-size = ${RUNTIME_BATCH}`,
    `ubatch-size = ${RUNTIME_BATCH}`,
    'stop-timeout = 5',
  ].join('\n') + '\n';
}
