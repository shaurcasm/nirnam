import { type RequestType } from './types';

/**
 * A typed CustomEvent that wraps a Nirnam bus message for DOM propagation.
 * Event name: `${requestType}_${topic}` (e.g. `broad_counter`)
 */
export class DataEvent<T = unknown> extends CustomEvent<T> {
  readonly topic: string;
  readonly requestType: RequestType;

  constructor(requestType: RequestType, topic: string, detail: T) {
    super(`${requestType}_${topic}`, { detail, bubbles: false, cancelable: false });
    this.topic = topic;
    this.requestType = requestType;
  }
}
