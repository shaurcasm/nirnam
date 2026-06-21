import { Observable } from 'rxjs';
import type { NirnamBusOptions } from './types';
import type { NirnamBus } from './bus';
import { createBus } from './bus';

/**
 * RxJS-based service wrapping a NirnamBus instance.
 *
 * Provide it via Angular's DI using `provideNirnam()` (standalone) or
 * `NirnamModule.forRoot()` (NgModule), or inject an existing bus:
 *
 * @example
 * // app.config.ts (standalone)
 * providers: [provideNirnam({ useBroadcastChannel: true })]
 *
 * @example
 * // app.module.ts (NgModule)
 * imports: [NirnamModule.forRoot({ useBroadcastChannel: true })]
 */
export class NirnamService {
  constructor(readonly bus: NirnamBus) {}

  /**
   * Returns an Observable that emits every time the topic receives a message.
   * Unsubscribes from the bus when the Observable is unsubscribed.
   */
  subscribe<T>(topic: string): Observable<T> {
    return new Observable<T>(subscriber => {
      return this.bus.subscribe<T>(topic, value => subscriber.next(value));
    });
  }

  publish<T>(topic: string, payload: T): void {
    this.bus.publish(topic, payload);
  }

  /**
   * Sends a narrow request and returns an Observable that emits one value then completes.
   */
  request<Req, Res>(topic: string, payload: Req, timeout?: number): Observable<Res> {
    return new Observable<Res>(subscriber => {
      this.bus.request<Req, Res>(topic, payload, timeout)
        .then(result => { subscriber.next(result); subscriber.complete(); })
        .catch(err => subscriber.error(err));
    });
  }

  /**
   * Sends a streaming request and returns an Observable that emits chunks as they arrive.
   */
  requestStream<Req, Res>(topic: string, payload: Req): Observable<Res> {
    return new Observable<Res>(subscriber => {
      (async () => {
        try {
          for await (const chunk of this.bus.requestStream<Req, Res>(topic, payload)) {
            if (subscriber.closed) break;
            subscriber.next(chunk);
          }
          subscriber.complete();
        } catch (err) {
          subscriber.error(err);
        }
      })();
    });
  }

  destroy(): void {
    this.bus.close();
  }
}

/**
 * Creates a NirnamService and returns it as an Angular provider tuple.
 * Use in standalone applications via `providers` in `bootstrapApplication` or `@Component`.
 *
 * @example
 * bootstrapApplication(AppComponent, {
 *   providers: [...provideNirnam({ useBroadcastChannel: true })]
 * });
 */
export function provideNirnam(options?: NirnamBusOptions): { provide: unknown; useValue: NirnamService }[] {
  return [{ provide: NirnamService, useValue: new NirnamService(createBus(options)) }];
}

/**
 * NgModule-style integration. Use in `imports` array via `forRoot()`.
 *
 * @example
 * @NgModule({ imports: [NirnamModule.forRoot({ useBroadcastChannel: true })] })
 * export class AppModule {}
 */
export class NirnamModule {
  static forRoot(options?: NirnamBusOptions): { ngModule: typeof NirnamModule; providers: { provide: unknown; useValue: NirnamService }[] } {
    return { ngModule: NirnamModule, providers: provideNirnam(options) };
  }
}
