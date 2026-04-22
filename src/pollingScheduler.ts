export type PollFn = () => Promise<void> | void;

export interface PollingSchedulerOptions {
  intervalMs?: number;
  logger?: (message: string) => void;
  onError?: (err: unknown) => void;
}

export interface PollingScheduler {
  start: () => void;
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createPollingScheduler(
  pollFn: PollFn,
  options: PollingSchedulerOptions = {}
): PollingScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.logger ?? console.log;

  let timer: NodeJS.Timeout | null = null;
  let isRunning = false;

  const runPoll = async (): Promise<void> => {
    if (isRunning) {
      log(`[${new Date().toISOString()}] Skipping poll: previous run still in progress.`);
      return;
    }

    isRunning = true;
    log(`[${new Date().toISOString()}] Poll attempt started.`);

    try {
      await pollFn();
      log(`[${new Date().toISOString()}] Poll attempt completed.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pollingScheduler] Poll attempt failed: ${message}`);
      options.onError?.(error);
    } finally {
      isRunning = false;
    }
  };

  const start = (): void => {
    if (timer) {
      return;
    }

    void runPoll();
    timer = setInterval(() => {
      void runPoll();
    }, intervalMs);
  };

  const stop = (): void => {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = null;
    log(`[${new Date().toISOString()}] Polling stopped.`);
  };

  return { start, stop };
}
