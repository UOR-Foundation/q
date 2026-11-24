// LangBot's message aggregator: a person who sends a question in several quick messages is answered
// once, for all of them. Messages with the same key (a person in a channel) that arrive within the
// window of each other become one batch. Every message of the burst learns the whole batch, so each
// can be treated as part of it (a message in a burst that addressed the agent is a request, never
// knowledge); only the last one is answered. It normalizes input; it decides nothing.

export interface Batch<T> { items: T[]; last: boolean }
interface Burst<T> { items: T[]; timer: ReturnType<typeof setTimeout>; settle: ((batch: Batch<T>) => void)[] }

export class Aggregator<T> {
  readonly windowMs: number;
  #bursts = new Map<string, Burst<T>>();
  constructor(windowMs: number) {
    this.windowMs = Math.max(0, windowMs);
  }

  offer(key: string, item: T): Promise<Batch<T>> {
    if (this.windowMs === 0) return Promise.resolve({ items: [item], last: true });
    return new Promise((resolve) => {
      const burst = this.#bursts.get(key);
      if (burst) {
        clearTimeout(burst.timer);
        burst.items.push(item);
        burst.settle.push(resolve);
      }
      const current = burst ?? { items: [item], settle: [resolve], timer: undefined as unknown as ReturnType<typeof setTimeout> };
      current.timer = setTimeout(() => {
        this.#bursts.delete(key);
        current.settle.forEach((settle, i) => settle({ items: current.items, last: i === current.settle.length - 1 }));
      }, this.windowMs);
      this.#bursts.set(key, current);
    });
  }
}
