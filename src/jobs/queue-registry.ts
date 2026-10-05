import { Queue, JobsOptions } from 'bullmq';
import { getQueueConnection } from './queue-connection';

export interface JobQueue {
  enqueue(jobName: string, payload: unknown): Promise<void>;
}

// One BullMQ Queue instance per name, reused across calls — BullMQ recommends against creating a
// fresh Queue object per enqueue (each one opens its own Redis connections/listeners).
const queues = new Map<string, Queue>();

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  // Bounded, not unlimited — keeps a recent window of failed jobs around for post-mortem
  // inspection (e.g. via a BullMQ dashboard) without letting Redis grow without bound.
  removeOnFail: { count: 1000 },
};

/** Real, BullMQ-backed job queue (see modules/notifications for the first consumer). Safe to
 *  call more than once with the same `name` — returns the same underlying Queue. */
export function createJobQueue(name: string): JobQueue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getQueueConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  const resolvedQueue = queue;

  return {
    async enqueue(jobName: string, payload: unknown): Promise<void> {
      await resolvedQueue.add(jobName, payload);
    },
  };
}

/** Called from server.ts's graceful shutdown, before closeQueueConnection(). */
export async function closeAllQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}
