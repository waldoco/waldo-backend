// A snapshot capture has a composition lifetime, not a process lifetime. This registry shares
// a capture only while callers overlap; settled success and failure are released so a long-lived
// Durable Object cannot accumulate an unbounded, implicit snapshot history.
export class InFlightSnapshotRegistry<T> {
  readonly #captures = new Map<string, Promise<T>>();

  capture(key: string, producer: () => Promise<T>): Promise<T> {
    const existing = this.#captures.get(key);
    if (existing !== undefined) return existing;

    const capture = Promise.resolve().then(producer);
    this.#captures.set(key, capture);
    void capture.then(
      () => this.release(key, capture),
      () => this.release(key, capture),
    );
    return capture;
  }

  private release(key: string, capture: Promise<T>): void {
    if (this.#captures.get(key) === capture) this.#captures.delete(key);
  }
}
