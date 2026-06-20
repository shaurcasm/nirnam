/**
 * Unit tests for NirnamMCPTransport.
 *
 * Uses a lightweight fake NirnamBus (subscribe/publish only) — no SharedWorker needed.
 */

import { NirnamMCPTransport } from '../src/mcp';
import type { JSONRPCMessage } from '../src/mcp';
import type { NirnamBus } from '../src/bus';

// --- Minimal fake bus --------------------------------------------------------

type Handler = (payload: unknown) => void;

function createFakeBus() {
  const subscriptions = new Map<string, Set<Handler>>();
  const publishes: { topic: string; payload: unknown }[] = [];

  const bus = {
    subscribe: jest.fn((topic: string, handler: Handler) => {
      const set = subscriptions.get(topic) ?? new Set<Handler>();
      set.add(handler);
      subscriptions.set(topic, set);
      return () => set.delete(handler);
    }),
    publish: jest.fn((topic: string, payload: unknown) => {
      publishes.push({ topic, payload });
      subscriptions.get(topic)?.forEach(h => h(payload));
    }),
    /** Simulate a message arriving on a topic from the "network". */
    _deliver(topic: string, payload: unknown) {
      subscriptions.get(topic)?.forEach(h => h(payload));
    },
  } as unknown as NirnamBus & { _deliver: (t: string, p: unknown) => void };

  return { bus, publishes };
}

function makeMsg(method: string, id?: number): JSONRPCMessage {
  return { jsonrpc: '2.0', id: id ?? null, method };
}

// --- Tests -------------------------------------------------------------------

describe('NirnamMCPTransport', () => {
  describe('start()', () => {
    it('subscribes to mcp:<agentId> topic', async () => {
      const { bus } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'my-agent', bus });

      await transport.start();

      expect(bus.subscribe).toHaveBeenCalledWith(
        'mcp:my-agent',
        expect.any(Function),
      );
    });

    it('calling onmessage when an envelope is received', async () => {
      const { bus } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'server', bus });
      const received: JSONRPCMessage[] = [];
      transport.onmessage = (msg) => received.push(msg);

      await transport.start();

      const msg = makeMsg('tools/list', 1);
      (bus as ReturnType<typeof createFakeBus>['bus'] & { _deliver: (t: string, p: unknown) => void })
        ._deliver('mcp:server', { from: 'client', message: msg });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(msg);
    });

    it('calls onerror when onmessage throws', async () => {
      const { bus } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'server', bus });
      transport.onmessage = () => { throw new Error('handler failure'); };
      const errors: Error[] = [];
      transport.onerror = (e) => errors.push(e);

      await transport.start();
      (bus as unknown as { _deliver: (t: string, p: unknown) => void })
        ._deliver('mcp:server', { from: 'client', message: makeMsg('ping') });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('handler failure');
    });
  });

  describe('send()', () => {
    it('publishes to mcp:<targetAgentId> with envelope from agentId', async () => {
      const { bus, publishes } = createFakeBus();
      const transport = new NirnamMCPTransport({
        agentId: 'orchestrator',
        targetAgentId: 'calc-agent',
        bus,
      });
      await transport.start();

      const msg = makeMsg('tools/call', 42);
      await transport.send(msg);

      expect(publishes).toHaveLength(1);
      expect(publishes[0].topic).toBe('mcp:calc-agent');
      expect(publishes[0].payload).toEqual({ from: 'orchestrator', message: msg });
    });

    it('uses currentSender as reply target in server mode (no targetAgentId)', async () => {
      const { bus, publishes } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'server', bus });
      await transport.start();

      // Simulate receiving a message from "client-a"
      (bus as unknown as { _deliver: (t: string, p: unknown) => void })
        ._deliver('mcp:server', { from: 'client-a', message: makeMsg('ping') });

      await transport.send(makeMsg('pong'));

      expect(publishes[0].topic).toBe('mcp:client-a');
      expect((publishes[0].payload as { from: string }).from).toBe('server');
    });

    it('throws and calls onerror when no target is known', async () => {
      const { bus } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'server', bus });
      const errors: Error[] = [];
      transport.onerror = (e) => errors.push(e);
      await transport.start();

      await expect(transport.send(makeMsg('ping'))).rejects.toThrow('Cannot send');
      expect(errors).toHaveLength(1);
    });

    it('updates currentSender on each received message', async () => {
      const { bus, publishes } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'server', bus });
      transport.onmessage = () => {};
      await transport.start();

      const deliver = (bus as unknown as { _deliver: (t: string, p: unknown) => void })._deliver.bind(bus);
      deliver('mcp:server', { from: 'client-a', message: makeMsg('first') });
      deliver('mcp:server', { from: 'client-b', message: makeMsg('second') });

      await transport.send(makeMsg('reply'));

      expect(publishes[0].topic).toBe('mcp:client-b');
    });
  });

  describe('close()', () => {
    it('unsubscribes from the bus topic', async () => {
      const { bus } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'agent', bus });
      const received: JSONRPCMessage[] = [];
      transport.onmessage = (m) => received.push(m);

      await transport.start();
      await transport.close();

      (bus as unknown as { _deliver: (t: string, p: unknown) => void })
        ._deliver('mcp:agent', { from: 'other', message: makeMsg('late') });

      expect(received).toHaveLength(0);
    });

    it('calls onclose callback', async () => {
      const { bus } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'agent', bus });
      const onclose = jest.fn();
      transport.onclose = onclose;

      await transport.start();
      await transport.close();

      expect(onclose).toHaveBeenCalled();
    });

    it('close without start does not throw', async () => {
      const { bus } = createFakeBus();
      const transport = new NirnamMCPTransport({ agentId: 'agent', bus });

      await expect(transport.close()).resolves.not.toThrow();
    });
  });
});
