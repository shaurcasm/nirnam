import * as React from 'react';
import type { NirnamBus } from './bus';

const NirnamContext = React.createContext<NirnamBus | null>(null);

function useNirnamBus(): NirnamBus {
  const bus = React.useContext(NirnamContext);
  if (!bus) throw new Error('[Nirnam] useNirnam hooks must be used within <NirnamProvider>');
  return bus;
}

export interface NirnamProviderProps {
  bus: NirnamBus;
  children: React.ReactNode;
}

/**
 * Provides a NirnamBus instance to the React subtree.
 * The bus lifecycle (close) is managed by the caller.
 *
 * @example
 * const bus = useMemo(() => createBus(), []);
 * useEffect(() => () => bus.close(), [bus]);
 * return <NirnamProvider bus={bus}>{children}</NirnamProvider>;
 */
export function NirnamProvider({ bus, children }: NirnamProviderProps): React.ReactElement {
  return React.createElement(NirnamContext.Provider, { value: bus }, children);
}

/**
 * Subscribes to a topic and returns the latest received value.
 * Automatically unsubscribes when the component unmounts or topic/bus changes.
 */
export function useNirnam<T>(topic: string, initialValue?: T): T | undefined {
  const bus = useNirnamBus();
  const [value, setValue] = React.useState<T | undefined>(initialValue);
  React.useEffect(() => bus.subscribe<T>(topic, setValue), [bus, topic]);
  return value;
}

/**
 * Returns a stable publish function bound to the context bus.
 */
export function useNirnamPublish(): <T>(topic: string, payload: T) => void {
  const bus = useNirnamBus();
  return React.useCallback(<T>(topic: string, payload: T) => bus.publish<T>(topic, payload), [bus]);
}

/**
 * Returns a function that sends a narrow request via the context bus.
 */
export function useNirnamRequest<Req = unknown, Res = unknown>(): (topic: string, payload: Req, timeout?: number) => Promise<Res> {
  const bus = useNirnamBus();
  return React.useCallback(
    (topic: string, payload: Req, timeout?: number) => bus.request<Req, Res>(topic, payload, timeout),
    [bus],
  );
}
