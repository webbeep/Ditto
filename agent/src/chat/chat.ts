// Chats: the conversation history the agent panel shows and the context the
// agent gets for follow-up questions. Stored per profile (localStorage in
// the agent page); nothing leaves the machine.

import type {Evidence} from '../agent/prompts.js';

export interface Turn {
  question: string;
  answer: string;
  sources: Evidence[];
  // One line per agent step, as shown under the answer.
  trace: string[];
  at: number;
  failed?: boolean;
}

export interface Chat {
  id: string;
  title: string;
  turns: Turn[];
  createdAt: number;
  updatedAt: number;
}

// What a follow-up question gets from the chat so far.
export interface ChatContext {
  // Earlier questions and answers, oldest first, within the budget.
  history: Array<{question: string, answer: string}>;
  // The last turn's sources: a follow-up is often answered by them.
  sources: Evidence[];
}

// Small models have 16K-token windows shared with page text; history gets a
// fixed slice of it (about 1.5K tokens).
export const HISTORY_BUDGET_CHARS = 6000;
const MAX_CHATS = 200;
const MAX_PASSAGE_CHARS = 600;

export function chatTitle(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

export function contextFor(chat: Chat|undefined,
                           budget = HISTORY_BUDGET_CHARS): ChatContext {
  if (!chat?.turns.length) {
    return {history: [], sources: []};
  }
  const history: ChatContext['history'] = [];
  let used = 0;
  // Newest first until the budget is spent, then back in order.
  for (let i = chat.turns.length - 1; i >= 0; --i) {
    const turn = chat.turns[i]!;
    if (turn.failed) {
      continue;
    }
    // Without its [n] markers: they point at sources this prompt does not
    // have, and small models copy them.
    const plain = turn.answer.replace(/\s*\[\d+\]/g, '');
    const answer = plain.length > 1200 ? `${plain.slice(0, 1200)}…` : plain;
    const cost = turn.question.length + answer.length;
    if (used + cost > budget && history.length) {
      break;
    }
    used += cost;
    history.unshift({question: turn.question, answer});
  }
  const last = [...chat.turns].reverse().find(t => !t.failed);
  return {history, sources: last?.sources ?? []};
}

// Anything with localStorage's three methods.
export interface KeyValueStorage {
  getItem(key: string): string|null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

export class ChatStore {
  private readonly storage: KeyValueStorage;
  private readonly key: string;
  private chats: Chat[];
  // Deleted here, so a merge with other windows' saves leaves them out.
  private readonly removed = new Set<string>();

  constructor(storage: KeyValueStorage, key = 'ditto.chats') {
    this.storage = storage;
    this.key = key;
    this.chats = this.load();
  }

  list(): Chat[] {
    return [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Chat|undefined {
    return this.chats.find(c => c.id === id);
  }

  create(now = Date.now()): Chat {
    const chat: Chat = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      title: '',
      turns: [],
      createdAt: now,
      updatedAt: now,
    };
    this.chats.push(chat);
    return chat;
  }

  addTurn(id: string, turn: Turn): Chat {
    const chat = this.get(id);
    if (!chat) {
      throw new Error(`No chat ${id}`);
    }
    chat.turns.push({
      ...turn,
      sources: turn.sources.map(s => ({
        url: s.url,
        title: s.title,
        passages: s.passages.map(p => p.slice(0, MAX_PASSAGE_CHARS)),
      })),
    });
    chat.title ||= chatTitle(turn.question);
    chat.updatedAt = turn.at;
    this.save();
    return chat;
  }

  // Adds a line under a turn's steps after the fact (notes learned once
  // the answer was given).
  annotate(id: string, at: number, line: string): void {
    const turn = this.get(id)?.turns.find(t => t.at === at);
    if (turn && !turn.trace.includes(line)) {
      turn.trace.push(line);
      this.save();
    }
  }

  remove(id: string): void {
    this.chats = this.chats.filter(c => c.id !== id);
    this.removed.add(id);
    this.save();
  }

  // Keeps a chat from another copy of the store (one being written now).
  adopt(chat: Chat): void {
    if (!this.get(chat.id)) {
      this.chats.push(chat);
    }
  }

  private load(): Chat[] {
    try {
      const raw = this.storage.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    // Empty chats are not worth keeping; the oldest go past the cap.
    const kept = this.list().filter(c => c.turns.length).slice(0, MAX_CHATS);
    try {
      this.storage.setItem(`${this.key}.removed`, JSON.stringify([...this.removed]));
      this.storage.setItem(this.key, JSON.stringify(kept));
    } catch {
      // Storage full or unavailable: the chat lives for this session only.
    }
  }
}
