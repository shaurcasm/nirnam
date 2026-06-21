# Angular Host + React Remote Example

This example demonstrates Nirnam being used across framework boundaries — an Angular shell hosting a React micro-frontend.

**Status:** Planned. The implementation will mirror the `react-mfe` example but with an Angular host.

## Planned structure

```
angular-react/
├── host/       ← Angular 17+ shell (Module Federation host)
└── remote/     ← React remote (same as react-mfe/remote)
```

## API usage in Angular

```ts
// Angular service wrapping the bus
import { Injectable, OnDestroy } from '@angular/core';
import { createBus, NirnamBus } from '@palinc/nirnam';

@Injectable({ providedIn: 'root' })
export class NirnamService implements OnDestroy {
  private bus: NirnamBus = createBus();

  publish<T>(topic: string, payload: T) {
    this.bus.publish(topic, payload);
  }

  subscribe<T>(topic: string, handler: (payload: T) => void) {
    return this.bus.subscribe(topic, handler);
  }

  ngOnDestroy() {
    this.bus.close();
  }
}
```

## Migration guide (if coming from the old SharedWorkerInstance API)

**Old:**
```ts
import { SharedWorkerInstance } from '@palinc/nirnam';
const worker = new SharedWorkerInstance();
worker.port.postMessage({ type: 'broadcast', topic: 'my-topic', message: data });
```

**New:**
```ts
import { createBus } from '@palinc/nirnam';
const bus = createBus();
bus.publish('my-topic', data);
```

**Old subscriber:**
```ts
worker.port.postMessage({ type: 'subscribe', topic: 'my-topic' });
worker.port.onmessage = (event) => {
  if (event.data.topic === 'my-topic') { /* handle */ }
};
```

**New subscriber:**
```ts
const unsub = bus.subscribe('my-topic', (payload) => { /* handle */ });
// Call unsub() on cleanup
```
