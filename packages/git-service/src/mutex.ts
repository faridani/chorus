/** A minimal FIFO async mutex: serializes operations on shared git state. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
