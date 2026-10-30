// Client for the System One decision API (`POST /v1/systemone`), served by
// llama.cpp for d1 models and by `strands-decider serve` for strands models.
// A decision model answers typed questions in one forward pass: no tokens
// are generated, every answer carries probabilities.

import {ensureOk, type HttpTransport} from '../http.js';

export type Question =
    {type: 'noul', instructions: string,
     criteria?: {true?: string, false?: string}}|
    {type: 'choice', instructions: string,
     criteria: Record<string, string|null>}|
    {type: 'score', instructions: string, criteria: string[]};

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>|number[];
  legend?: Record<string, string>;
}

export type Answer = NoulAnswer|ChoiceAnswer|ScoreAnswer;

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, Question>;
  // Data URLs (screenshots). Only for deciders with image input.
  images?: string[];
}

export interface DecisionResult {
  answers: Record<string, Answer>;
  inputTokens: number;
  latencyMs: number;
}

// llama.cpp limits a choice to 255 options for d1; keep well under it so
// the state still fits one batch.
export const MAX_CHOICE_OPTIONS = 48;

export class DeciderClient {
  private readonly http: HttpTransport;
  readonly modelId: string;
  // The router needs `model`; the strands sidecar serves one model and
  // ignores it.
  private readonly routed: boolean;

  constructor(http: HttpTransport, modelId: string, routed = true) {
    this.http = http;
    this.modelId = modelId;
    this.routed = routed;
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type === 'choice' &&
          Object.keys(question.criteria).length > MAX_CHOICE_OPTIONS) {
        throw new Error(`Question ${id} has too many options`);
      }
    }
    const body: Record<string, unknown> = {
      state: request.state,
      questions: request.questions,
    };
    if (this.routed) {
      body['model'] = this.modelId;
    }
    if (request.images?.length) {
      body['images'] = request.images;
    }
    const started = Date.now();
    const reply = ensureOk(
        await this.http.request('POST', '/v1/systemone', body, signal),
        `decide with ${this.modelId}`) as {
          answers?: Record<string, Answer>,
          usage?: {input_tokens?: number},
        };
    return {
      answers: reply.answers ?? {},
      inputTokens: reply.usage?.input_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}

export function noul(result: DecisionResult, id: string): number {
  const answer = result.answers[id];
  if (!answer || !('noul' in answer)) {
    throw new Error(`Decider gave no yes/no answer for ${id}`);
  }
  return answer.noul;
}

export function choice(result: DecisionResult, id: string): ChoiceAnswer {
  const answer = result.answers[id];
  if (!answer || !('choice' in answer)) {
    throw new Error(`Decider gave no choice for ${id}`);
  }
  return answer;
}
