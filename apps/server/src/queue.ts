/**
 * The single writer (#197, decision 0010). DuckDB allows one writer, and the collector, the processor and settings
 * changes all write; every write runs as a job on this queue, one at a time, in the order it was added.
 * Reads do not use the queue.
 */

export interface JobInfo {
  id: number;
  name: string;
}

export interface QueueStats {
  pending: number;
  running: JobInfo | null;
  done: number;
  failed: number;
}

export class QueueClosedError extends Error {
  override name = "QueueClosedError";
}

type Job = JobInfo & { run: () => Promise<void> };

export class WriteQueue {
  readonly #jobs: Job[] = [];
  #running: JobInfo | null = null;
  #nextId = 1;
  #done = 0;
  #failed = 0;
  #closed = false;
  #idle: (() => void)[] = [];
  readonly #onError: (job: JobInfo, error: unknown) => void;

  /** `onError` sees every failed job; the job's own promise is rejected too. */
  constructor(onError: (job: JobInfo, error: unknown) => void = () => {}) {
    this.#onError = onError;
  }

  /** Add a write job. Resolves with its result after every earlier job has finished. A failure does not stop the queue. */
  add<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.#closed) return Promise.reject(new QueueClosedError(`queue is closed; job "${name}" not run`));
    return new Promise<T>((resolve, reject) => {
      const info = { id: this.#nextId++, name };
      this.#jobs.push({
        ...info,
        run: async () => {
          try {
            resolve(await fn());
            this.#done++;
          } catch (e) {
            this.#failed++;
            try {
              this.#onError(info, e);
            } catch {
              // A broken error handler must not stop the queue.
            }
            reject(e);
          }
        },
      });
      void this.#pump();
    });
  }

  stats(): QueueStats {
    return { pending: this.#jobs.length, running: this.#running, done: this.#done, failed: this.#failed };
  }

  /** Resolves when no job is running or waiting. */
  idle(): Promise<void> {
    if (!this.#running && this.#jobs.length === 0) return Promise.resolve();
    return new Promise((r) => this.#idle.push(r));
  }

  /** Stop taking jobs; resolves when the jobs already added have finished (graceful shutdown, #198). */
  close(): Promise<void> {
    this.#closed = true;
    return this.idle();
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    for (let job = this.#jobs.shift(); job; job = this.#jobs.shift()) {
      this.#running = { id: job.id, name: job.name };
      await job.run();
      this.#running = null;
    }
    for (const r of this.#idle.splice(0)) r();
  }
}
