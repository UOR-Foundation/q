// LangBot's message aggregator: a person who sends a question in several quick messages is answered
// once, for all of them. Messages with the same key (a person in a channel) that arrive within the
// window of each other become one batch. The last message of a burst gets the batch; the earlier ones
// get null, because they are folded into it. It normalizes input; it decides nothing.

interface Burst<T> { items: T[]; timer: ReturnType<typeof setTimeout>; settle: ((batch: T[] | null) => void)[] }

export class Aggregator<T> {
  readonly windowMs: number;
  #bursts = new Map<string, Burst<T>>();
  constructor(windowMs: number) {
    this.windowMs = Math.max(0, windowMs);
  }

  offer(key: string, item: T): Promise<T[] | null> {
    if (this.windowMs === 0) return Promise.resolve([item]);
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
        current.settle.forEach((settle, i) => settle(i === current.settle.length - 1 ? current.items : null));
      }, this.windowMs);
      this.#bursts.set(key, current);
    });
  }
}
