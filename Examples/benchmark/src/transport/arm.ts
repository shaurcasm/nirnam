/**
 * What every transport arm offers the workloads. An arm that cannot do a
 * thing leaves the method out and the table says so — that absence is part
 * of the result, not a gap in the benchmark.
 */

export type Handler = (payload: unknown) => void;
export type RequestHandler = (payload: unknown) => unknown | Promise<unknown>;
export type StreamHandler = (payload: unknown) => AsyncIterable<unknown>;

export interface TransportArm {
  id: string;
  label: string;
  /** One line under the label: what this arm is and what it stands for. */
  note: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;

  subscribe(topic: string, handler: Handler): () => void;
  publish(topic: string, payload: unknown): void;

  handle?(topic: string, handler: RequestHandler): () => void;
  request?(topic: string, payload: unknown): Promise<unknown>;

  handleStream?(topic: string, handler: StreamHandler): () => void;
  requestStream?(topic: string, payload: unknown): AsyncIterable<unknown>;

  /**
   * Have the arm's own worker publish `count` messages on `topic` for the
   * main thread to receive. Resolves once the worker has been asked.
   */
  workerPublish?(topic: string, count: number): Promise<void>;
  /** A round trip answered inside the arm's worker. */
  workerRequest?(payload: unknown): Promise<unknown>;
}

/** A transcript-sized payload, like the ones Wevaad's agents fan out. */
export function makePayload(seq: number): { seq: number; sentAt: number; speaker: string; text: string } {
  return {
    seq,
    sentAt: performance.now(),
    speaker: seq % 2 ? 'for' : 'against',
    text: 'The proposition rests on a premise that has not been examined, and I would like to examine it now, briefly.',
  };
}
