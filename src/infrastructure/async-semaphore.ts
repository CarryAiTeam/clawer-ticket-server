/**
 * 小型 FIFO 信号量。它只管理并发许可，不包含任何业务、网络或重试策略。
 */
export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Semaphore limit must be a positive safe integer");
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseOnce();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}
