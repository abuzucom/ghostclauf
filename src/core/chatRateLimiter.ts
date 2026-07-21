const CHANNEL_INTERVAL_MS = 1_000;
const GLOBAL_WINDOW_MS = 30_000;
const GLOBAL_MESSAGE_LIMIT = 20;
const MAX_QUEUE_LENGTH = 100;

interface QueuedMessage<T> {
  broadcasterId: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Serialize chat sends while respecting Twitch's conservative chat limits. */
export class ChatRateLimiter {
  private readonly queue: QueuedMessage<unknown>[] = [];
  private readonly lastSentAt = new Map<string, number>();
  private readonly sentAt: number[] = [];
  private active = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  enqueue<T>(broadcasterId: string, task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('chat rate limiter is stopped'));
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      return Promise.reject(new Error('chat send queue is full'));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        broadcasterId,
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /** Stop accepting work and reject messages that have not started. */
  close(): void {
    this.closed = true;
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const error = new Error('chat rate limiter is stopped');
    for (const item of this.queue.splice(0)) item.reject(error);
  }

  private pump(): void {
    if (this.closed || this.active || !this.queue.length) return;

    const now = Date.now();
    this.pruneSentAt(now);
    if (this.sentAt.length >= GLOBAL_MESSAGE_LIMIT) {
      this.scheduleWake(this.sentAt[0]! + GLOBAL_WINDOW_MS);
      return;
    }

    const readyIndex = this.queue.findIndex((item) => {
      const lastSent = this.lastSentAt.get(item.broadcasterId);
      return lastSent === undefined || now - lastSent >= CHANNEL_INTERVAL_MS;
    });
    if (readyIndex < 0) {
      const nextAvailable = Math.min(
        ...this.queue.map(
          (item) => (this.lastSentAt.get(item.broadcasterId) ?? now) + CHANNEL_INTERVAL_MS,
        ),
      );
      this.scheduleWake(nextAvailable);
      return;
    }

    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const [item] = this.queue.splice(readyIndex, 1);
    if (!item) return;
    this.lastSentAt.set(item.broadcasterId, now);
    this.sentAt.push(now);
    this.active = true;
    void item.task()
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }

  private pruneSentAt(now: number): void {
    const cutoff = now - GLOBAL_WINDOW_MS;
    while (this.sentAt[0] !== undefined && this.sentAt[0] <= cutoff) this.sentAt.shift();
  }

  private scheduleWake(timestamp: number): void {
    if (this.wakeTimer !== undefined) return;
    const delay = Math.max(0, timestamp - Date.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, delay);
  }
}
