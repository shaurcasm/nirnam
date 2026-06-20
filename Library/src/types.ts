export enum RequestType {
  BROAD = 'broad',
  NARROW = 'narrow',
}

export type NirnamMessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'broadcast'
  | 'request'
  | 'response'
  | 'error';

export interface NirnamMessage<T = unknown> {
  type: NirnamMessageType;
  topic?: string;
  payload?: T;
  requestId?: string;
  sourcePageId?: string;
  error?: string;
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
