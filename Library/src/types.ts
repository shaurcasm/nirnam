export enum RequestType {
  BROAD = 'broad',
  NARROW = 'narrow',
}

export enum NirnamErrorCode {
  NO_HANDLER = 'NO_HANDLER',
  HANDLER_REJECTED = 'HANDLER_REJECTED',
  TIMEOUT = 'TIMEOUT',
  STREAM_ABORTED = 'STREAM_ABORTED',
}

export class NirnamRequestError extends Error {
  constructor(
    public readonly code: NirnamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NirnamRequestError';
  }
}

export type NirnamMessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'broadcast'
  | 'request'
  | 'response'
  | 'error'
  | 'request-stream'
  | 'stream-chunk'
  | 'stream-end';

export interface NirnamMessage<T = unknown> {
  type: NirnamMessageType;
  topic?: string;
  payload?: T;
  requestId?: string;
  sourcePageId?: string;
  error?: string;
  code?: NirnamErrorCode;
}

export interface NirnamBusOptions {
  /** Opt-in static worker URL (Layer 3). Enables true cross-tab SharedWorker sharing. */
  workerUrl?: string;
  /** Enable BroadcastChannel cross-tab fan-out (Layer 1). Default: true. */
  useBroadcastChannel?: boolean;
  /** Default timeout in ms for request() calls. Default: 5000. */
  requestTimeout?: number;
}

export type UnsubscribeFn = () => void;

export type SubscribeHandler<T = unknown> = (payload: T) => void;

export type RequestHandler<Req = unknown, Res = unknown> = (
  payload: Req
) => Res | Promise<Res>;

export type StreamHandler<Req = unknown, Res = unknown> = (
  payload: Req
) => AsyncIterable<Res>;
