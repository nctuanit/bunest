import type { Job, QueueCounts, QueueDriver } from "../interfaces";

interface WaitingEntry {
  readonly id: string;
  readonly priority: number;
  readonly seq: number;
}

interface QueueBucket {
  readonly jobs: Map<string, Job<any, any>>;
  readonly idempotencyMap: Map<string, Job<any, any>>;
  readonly waiting: WaitingEntry[];
  readonly delayed: Set<string>;
  readonly active: Set<string>;
  readonly deadLetter: string[];
  completedCount: number;
  failedCount: number;
  seq: number;
}

function formatError(error: Error | string): { message: string; stack?: string } {
  if (typeof error === "string") {
    return { message: error };
  }
  return {
    message: error.message || String(error),
    stack: error.stack,
  };
}

/**
 * In-memory `QueueDriver` supporting priority + FIFO ordering, delayed jobs,
 * idempotency key deduplication, retries, and Dead-Letter Queue (DLQ) management.
 */
export class MemoryQueueDriver implements QueueDriver {
  private readonly buckets = new Map<string, QueueBucket>();

  private getBucket(queueName: string): QueueBucket {
    let bucket = this.buckets.get(queueName);
    if (!bucket) {
      bucket = {
        jobs: new Map(),
        idempotencyMap: new Map(),
        waiting: [],
        delayed: new Set(),
        active: new Set(),
        deadLetter: [],
        completedCount: 0,
        failedCount: 0,
        seq: 0,
      };
      this.buckets.set(queueName, bucket);
    }
    return bucket;
  }

  async enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    job: Job<TData, TResult>,
  ): Promise<Job<TData, TResult>> {
    const bucket = this.getBucket(queueName);

    // Idempotency key deduplication
    if (job.idempotencyKey !== undefined) {
      const existing = bucket.idempotencyMap.get(job.idempotencyKey);
      if (existing) {
        return existing as Job<TData, TResult>;
      }
    }

    // Explicit jobId deduplication
    const existingById = bucket.jobs.get(job.id);
    if (existingById) {
      return existingById as Job<TData, TResult>;
    }

    bucket.jobs.set(job.id, job);
    if (job.idempotencyKey !== undefined) {
      bucket.idempotencyMap.set(job.idempotencyKey, job);
    }

    const now = Date.now();
    if (job.processAfter > now) {
      job.status = "delayed";
      bucket.delayed.add(job.id);
    } else {
      job.status = "waiting";
      this.insertWaiting(bucket, job);
    }

    return job;
  }

  async dequeue<TData = unknown, TResult = unknown>(
    queueName: string,
    now: number = Date.now(),
  ): Promise<Job<TData, TResult> | null> {
    const bucket = this.getBucket(queueName);
    this.promoteReadyDelayedJobs(bucket, now);

    while (bucket.waiting.length > 0) {
      const entry = bucket.waiting.shift()!;
      const job = bucket.jobs.get(entry.id);
      if (!job || job.status !== "waiting") {
        continue;
      }
      job.status = "active";
      job.startedAt = now;
      bucket.active.add(job.id);
      return job as Job<TData, TResult>;
    }

    return null;
  }

  async ack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    result?: TResult,
  ): Promise<Job<TData, TResult> | null> {
    const bucket = this.getBucket(queueName);
    bucket.active.delete(jobId);

    const job = bucket.jobs.get(jobId);
    if (!job) {
      return null;
    }

    job.status = "completed";
    job.returnValue = result;
    job.finishedAt = Date.now();
    bucket.completedCount++;

    if (job.removeOnComplete) {
      bucket.jobs.delete(jobId);
    }

    return job as Job<TData, TResult>;
  }

  async nack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
    retryAt?: number,
  ): Promise<Job<TData, TResult> | null> {
    const bucket = this.getBucket(queueName);
    bucket.active.delete(jobId);

    const job = bucket.jobs.get(jobId);
    if (!job) {
      return null;
    }

    const formatted = formatError(error);
    job.attemptsMade += 1;
    job.failedReason = formatted.message;
    job.stacktrace.push(formatted.stack ?? formatted.message);

    if (retryAt !== undefined) {
      job.processAfter = retryAt;
      if (retryAt > Date.now()) {
        job.status = "delayed";
        bucket.delayed.add(job.id);
      } else {
        job.status = "waiting";
        this.insertWaiting(bucket, job);
      }
    } else {
      job.status = "failed";
      job.finishedAt = Date.now();
      bucket.failedCount++;
    }

    return job as Job<TData, TResult>;
  }

  async moveToDeadLetter<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
  ): Promise<Job<TData, TResult> | null> {
    const bucket = this.getBucket(queueName);
    bucket.active.delete(jobId);
    bucket.delayed.delete(jobId);

    const job = bucket.jobs.get(jobId);
    if (!job) {
      return null;
    }

    const formatted = formatError(error);
    job.attemptsMade += 1;
    job.status = "dead-letter";
    job.failedReason = formatted.message;
    job.finishedAt = Date.now();
    job.stacktrace.push(formatted.stack ?? formatted.message);
    bucket.failedCount++;

    if (!bucket.deadLetter.includes(jobId)) {
      bucket.deadLetter.push(jobId);
    }

    return job as Job<TData, TResult>;
  }

  async getJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    const bucket = this.buckets.get(queueName);
    if (!bucket) {
      return null;
    }
    return (bucket.jobs.get(jobId) as Job<TData, TResult> | undefined) ?? null;
  }

  async getCounts(queueName: string): Promise<QueueCounts> {
    const bucket = this.buckets.get(queueName);
    if (!bucket) {
      return {
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        deadLetter: 0,
      };
    }

    this.promoteReadyDelayedJobs(bucket, Date.now());
    return {
      waiting: bucket.waiting.length,
      delayed: bucket.delayed.size,
      active: bucket.active.size,
      completed: bucket.completedCount,
      failed: bucket.failedCount,
      deadLetter: bucket.deadLetter.length,
    };
  }

  async getDeadLetterJobs<TData = unknown, TResult = unknown>(
    queueName: string,
  ): Promise<Job<TData, TResult>[]> {
    const bucket = this.buckets.get(queueName);
    if (!bucket) {
      return [];
    }
    const jobs: Job<TData, TResult>[] = [];
    for (const id of bucket.deadLetter) {
      const job = bucket.jobs.get(id);
      if (job) {
        jobs.push(job as Job<TData, TResult>);
      }
    }
    return jobs;
  }

  async retryDeadLetterJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    const bucket = this.buckets.get(queueName);
    if (!bucket) {
      return null;
    }

    const dlqIdx = bucket.deadLetter.indexOf(jobId);
    if (dlqIdx === -1) {
      return null;
    }

    const job = bucket.jobs.get(jobId);
    if (!job) {
      bucket.deadLetter.splice(dlqIdx, 1);
      return null;
    }

    bucket.deadLetter.splice(dlqIdx, 1);
    job.attemptsMade = 0;
    job.failedReason = undefined;
    job.finishedAt = undefined;
    job.startedAt = undefined;
    job.processAfter = Date.now();
    job.status = "waiting";
    this.insertWaiting(bucket, job);

    return job as Job<TData, TResult>;
  }

  async getNextDelayedTimestamp(queueName: string): Promise<number | null> {
    const bucket = this.buckets.get(queueName);
    if (!bucket || bucket.delayed.size === 0) {
      return null;
    }
    let earliest: number | null = null;
    for (const id of bucket.delayed) {
      const job = bucket.jobs.get(id);
      if (!job) continue;
      if (earliest === null || job.processAfter < earliest) {
        earliest = job.processAfter;
      }
    }
    return earliest;
  }

  close(): void {
    this.buckets.clear();
  }

  private promoteReadyDelayedJobs(bucket: QueueBucket, now: number): void {
    if (bucket.delayed.size === 0) {
      return;
    }
    const ready: Job<any, any>[] = [];
    for (const id of bucket.delayed) {
      const job = bucket.jobs.get(id);
      if (!job) {
        bucket.delayed.delete(id);
        continue;
      }
      if (job.processAfter <= now) {
        bucket.delayed.delete(id);
        job.status = "waiting";
        ready.push(job);
      }
    }
    ready.sort((a, b) => a.processAfter - b.processAfter);
    for (const job of ready) {
      this.insertWaiting(bucket, job);
    }
  }

  private insertWaiting(bucket: QueueBucket, job: Job<any, any>): void {
    const entry: WaitingEntry = {
      id: job.id,
      priority: job.priority,
      seq: ++bucket.seq,
    };

    // Binary insert keeping descending priority, then ascending seq (FIFO)
    let low = 0;
    let high = bucket.waiting.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const cur = bucket.waiting[mid]!;
      const shouldGoBefore =
        entry.priority > cur.priority ||
        (entry.priority === cur.priority && entry.seq < cur.seq);
      if (shouldGoBefore) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    bucket.waiting.splice(low, 0, entry);
  }
}
