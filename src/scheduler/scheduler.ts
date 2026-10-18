import type { TimelineStep } from '../scenarios/catalog.js';

export const EVENT_SCHEDULER = Symbol.for('relayo-sim:scheduler');

/** One step of a message's timeline, waiting to happen. */
export interface ScheduledStep {
  projectId: string;
  messageId: string;
  recipient: string;
  /** Position in the timeline, for stable event ids. */
  index: number;
  step: TimelineStep;
}

export type StepHandler = (job: ScheduledStep) => Promise<void>;

/** Runs timeline steps after their delay. Production uses BullMQ delayed jobs; tests use timers. */
export interface EventScheduler {
  schedule(job: ScheduledStep, delayMs: number): Promise<void>;
  start(handler: StepHandler): void;
  stop(): Promise<void>;
}

/** setTimeout-based scheduler. Steps are lost on restart; fine for tests and local runs. */
export class MemoryScheduler implements EventScheduler {
  private handler: StepHandler | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly running = new Set<Promise<void>>();

  async schedule(job: ScheduledStep, delayMs: number): Promise<void> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const run = (this.handler?.(job) ?? Promise.resolve()).catch(() => undefined);
      this.running.add(run);
      void run.finally(() => this.running.delete(run));
    }, Math.max(0, delayMs));
    this.timers.add(timer);
  }

  start(handler: StepHandler): void {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.running);
  }

  /** Steps still waiting. */
  get pending(): number {
    return this.timers.size;
  }
}
