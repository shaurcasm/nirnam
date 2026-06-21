import { lazy, Suspense, useEffect, useState } from 'react';
import { createBus } from '@palinc/nirnam';
import type { ButtonEventResponse } from './events/ButtonEventResponse';
import './App.css';

const RemoteButton = lazy(() => import('remote/Button'));

// Module-level bus — one per MFE, shared across all components in this app.
const bus = createBus();

const App = () => {
  const [counter, setCounter] = useState(0);
  const [lastRemoteEvent, setLastRemoteEvent] = useState<ButtonEventResponse | null>(null);

  useEffect(() => {
    const id = setInterval(() => setCounter(c => c + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    bus.publish('counter', counter);
  }, [counter]);

  useEffect(() => {
    const unsub = bus.subscribe<ButtonEventResponse>('remote-click', (event) => {
      setLastRemoteEvent(event);
    });
    return unsub;
  }, []);

  return (
    <div className="content">
      <h1>MFE Host</h1>
      <p>Counter: {counter}</p>
      {lastRemoteEvent && (
        <p>Last remote event: {lastRemoteEvent.response}</p>
      )}
      <Suspense fallback={<span>Loading remote...</span>}>
        <RemoteButton />
      </Suspense>
    </div>
  );
};

export default App;
