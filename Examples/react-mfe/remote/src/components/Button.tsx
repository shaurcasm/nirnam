import { useEffect, useState } from 'react';
import { createBus } from '@palinc/nirnam';
import type { ButtonEvent } from '../events/ButtonEvent';

const bus = createBus();

const Button = () => {
  const [hostCounter, setHostCounter] = useState<number | null>(null);

  useEffect(() => {
    return bus.subscribe<number>('counter', (count) => {
      setHostCounter(count);
    });
  }, []);

  const handleClick = () => {
    const event: ButtonEvent = { message: `Clicked at ${new Date().toLocaleTimeString()}` };
    bus.publish('remote-click', { response: event.message });
  };

  return (
    <div>
      <p>Host counter (via Nirnam): {hostCounter ?? '—'}</p>
      <button onClick={handleClick}>Send Event to Host</button>
    </div>
  );
};

export default Button;
