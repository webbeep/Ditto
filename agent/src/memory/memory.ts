// What the agent knows about the user, so answers and tasks fit them:
// notes it was told ("remember that I'm vegetarian") or learned from chats
// (preferences, places, habits), and the sites the user's tasks end up on.
// Kept by the browser in the profile (memory.json); nothing leaves the Mac.
// The user can read and delete every note, and turn learning off.

export interface Note {
  id: string;
  text: string;
  source: 'told'|'learned';
  createdAt: number;
  usedAt: number;
}

export interface MemoryData {
  // Learn new notes from chats.
  learn: boolean;
  notes: Note[];
  // Host -> how many answers came from it.
  sites: Record<string, number>;
}

// What a request gets from memory.
export interface UserProfile {
  notes: string[];
  // Sites the user's tasks most often end on.
  sites: string[];
}

const MAX_NOTES = 200;
const MAX_SITES = 100;
// Search engines say nothing about the user's sites: every search ends on
// one. (Recorded before this was filtered out, they are skipped too.)
const SEARCH_HOSTS = /^(google|bing|duckduckgo|html\.duckduckgo|search\.yahoo|yahoo|ecosia|search\.brave|startpage|kagi|baidu|yandex)\.[a-z.]+$/i;

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for',
                      'is', 'are', 'my', 'me', 'i', 'it', 'this', 'that', 'with',
                      'what', 'how', 'do', 'does', 'be', 'at', 'from', 'about',
                      // Contractions split by the tokenizer, and the note prefix.
                      'am', 'm', 's', 're', 've', 'll', 'd', 'user', 'said']);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !STOP.has(w));
}

// Same note in other words: most of the shorter one's words in the longer.
function sameNote(a: string, b: string): boolean {
  const [x, y] = [new Set(words(a)), new Set(words(b))];
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  if (!small.size) {
    return false;
  }
  let shared = 0;
  for (const w of small) {
    shared += large.has(w) ? 1 : 0;
  }
  return shared / small.size >= 0.8;
}

export class MemoryStore {
  private data!: MemoryData;
  private readonly save: (json: string) => void;

  constructor(json: string, save: (json: string) => void) {
    this.save = save;
    this.data = MemoryStore.parse(json);
  }

  // The notes as another window saved them.
  replace(json: string): void {
    this.data = MemoryStore.parse(json);
  }

  private static parse(json: string): MemoryData {
    let parsed: Partial<MemoryData> = {};
    try {
      parsed = json ? JSON.parse(json) as Partial<MemoryData> : {};
    } catch {
      // A damaged file starts over.
    }
    return {
      learn: parsed.learn ?? true,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      sites: parsed.sites ?? {},
    };
  }

  get learning(): boolean {
    return this.data.learn;
  }

  setLearning(on: boolean): void {
    this.data.learn = on;
    this.persist();
  }

  notes(): Note[] {
    return [...this.data.notes].sort((a, b) => b.createdAt - a.createdAt);
  }

  // Adds a note, or refreshes the one it repeats. Returns it if new.
  add(text: string, source: Note['source'], now = Date.now()): Note|null {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean) {
      return null;
    }
    const existing = this.data.notes.find(n => sameNote(n.text, clean));
    if (existing) {
      // Told beats learned; newer wording wins.
      existing.text = clean;
      existing.source = source === 'told' ? 'told' : existing.source;
      existing.usedAt = now;
      this.persist();
      return null;
    }
    const note: Note = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: clean, source, createdAt: now, usedAt: now,
    };
    this.data.notes.push(note);
    if (this.data.notes.length > MAX_NOTES) {
      // Forget the learned note used least recently.
      const learned = this.data.notes.filter(n => n.source === 'learned')
                          .sort((a, b) => a.usedAt - b.usedAt)[0] ??
          this.data.notes.sort((a, b) => a.usedAt - b.usedAt)[0]!;
      this.remove(learned.id);
    }
    this.persist();
    return note;
  }

  remove(id: string): void {
    this.data.notes = this.data.notes.filter(n => n.id !== id);
    this.persist();
  }

  // Removes the notes about `topic`. Returns how many.
  forget(topic: string): number {
    const asked = new Set(words(topic));
    if (!asked.size) {
      return 0;
    }
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter(note => {
      const shared = words(note.text).filter(w => asked.has(w)).length;
      return shared / asked.size < 0.6;
    });
    this.persist();
    return before - this.data.notes.length;
  }

  clear(): void {
    this.data.notes = [];
    this.data.sites = {};
    this.persist();
  }

  // An answer came from these pages: the user's tasks go there.
  visited(urls: string[]): void {
    for (const url of urls) {
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (SEARCH_HOSTS.test(host)) {
          continue;
        }
        this.data.sites[host] = (this.data.sites[host] ?? 0) + 1;
      } catch {
        // Not a URL.
      }
    }
    const hosts = Object.entries(this.data.sites);
    if (hosts.length > MAX_SITES) {
      this.data.sites = Object.fromEntries(
          hosts.sort((a, b) => b[1] - a[1]).slice(0, MAX_SITES));
    }
    this.persist();
  }

  // The notes that bear on `request` (and the user's general preferences),
  // most relevant first, and the user's usual sites.
  profileFor(request: string, max = 8, now = Date.now()): UserProfile {
    const asked = new Set(words(request));
    const scored = this.data.notes.map(note => {
      const noteWords = words(note.text);
      const overlap = noteWords.filter(w => asked.has(w)).length;
      // General preferences ("prefers metric units") apply everywhere.
      const general = /\b(prefer|prefers|always|never|usually|likes?|dislikes?|allergic|vegetarian|vegan|language|units?)\b/i
                          .test(note.text) ? 0.5 : 0;
      const recent = Math.max(0, 1 - (now - note.usedAt) / (90 * 864e5)) * 0.25;
      return {note, score: overlap + general + recent + (note.source === 'told' ? 0.25 : 0)};
    }).filter(s => s.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, max);
    for (const {note} of scored) {
      note.usedAt = now;
    }
    const sites = Object.entries(this.data.sites)
                      .filter(([host, count]) => count >= 2 && !SEARCH_HOSTS.test(host))
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 5)
                      .map(([host]) => host);
    return {notes: scored.map(s => s.note.text), sites};
  }

  toJson(): string {
    return JSON.stringify(this.data);
  }

  private persist(): void {
    this.save(this.toJson());
  }
}
