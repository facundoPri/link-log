/** An action this page started. Its batches share one toast, which settles once the run has ended and they all finished. */
export type SessionRun = { add: (batchId: string) => void; end: () => void };
export type StartRun = () => SessionRun;
