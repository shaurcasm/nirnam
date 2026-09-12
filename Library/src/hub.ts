/**
 * MessageHub — the routing core of the bus.
 *
 * The hub is handed ports and routes between them. It does not know whether
 * it is running in a SharedWorker, a dedicated Worker, or inline on the main
 * thread; the three hub kinds differ only in who calls `connect()` and with
 * what. That is what lets one implementation serve all of them, and what lets
 * the tests drive it with plain objects.
 *
 * A port joins by `connect()`. Any connected port may hand the hub another
 * port with a `{ type: 'connect' }` message carrying it in the transfer list,
 * which is how a participant that cannot reach the hub directly — a dedicated
 * worker, say — is introduced by one that can. A port leaves by a
 * `{ type: 'disconnect' }` message, by closing, or by `disconnect()`.
 */

import type { AgentRegistration } from './types';

/**
 * The least a port needs to be routable. `MessagePort` qualifies as is; a
 * fake for tests needs only `postMessage` and `onmessage`.
 *
 * `onmessage` takes a `MessageEvent` because that is what the real ports
 * hand out and property types are checked contravariantly — a narrower
 * event type here would make `MessagePort` unassignable.
 */
export interface HubPort {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  start?(): void;
  addEventListener?(type: 'close', listener: () => void): void;
}

interface HubMessage {
  type?: string;
  topic?: string;
  payload?: unknown;
  requestId?: string;
  sourcePageId?: string;
  agentId?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  error?: string;
  code?: string;
}

export class MessageHub {
  private readonly ports = new Set<HubPort>();
  private readonly topicSubscribers = new Map<string, Set<HubPort>>();
  private readonly pendingRequests = new Map<string, HubPort>();
  private readonly rrCounters = new Map<string, number>();
  private readonly agentRegistry = new Map<string, AgentRegistration>();
  private readonly agentPortMap = new Map<string, HubPort>();
  private readonly agentWatchers = new Set<HubPort>();

  get portCount(): number {
    return this.ports.size;
  }

  connect(port: HubPort): void {
    this.ports.add(port);
    port.onmessage = (event) => {
      const data = event.data as HubMessage | null;
      if (data && typeof data === 'object' && data.type === 'connect') {
        const adopted: HubPort | undefined = event.ports?.[0];
        if (adopted) this.connect(adopted);
        return;
      }
      this.handleMessage(data, port);
    };
    port.addEventListener?.('close', () => this.disconnect(port));
    port.start?.();
  }

  disconnect(port: HubPort): void {
    if (!this.ports.delete(port)) return;

    this.topicSubscribers.forEach((subs, topic) => {
      subs.delete(port);
      if (subs.size === 0) this.forgetTopic(topic);
    });
    this.pendingRequests.forEach((origin, id) => {
      if (origin === port) this.pendingRequests.delete(id);
    });

    const left: string[] = [];
    this.agentPortMap.forEach((owner, agentId) => {
      if (owner === port) {
        this.agentPortMap.delete(agentId);
        this.agentRegistry.delete(agentId);
        left.push(agentId);
      }
    });
    this.agentWatchers.delete(port);
    left.forEach(agentId => this.notifyWatchers({ type: 'agent-left', agentId }));
  }

  handleMessage(data: unknown, port: HubPort): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as HubMessage;
    const { type, topic, payload, requestId } = msg;

    try {
      switch (type) {
        case 'subscribe':
          if (!topic) throw new Error('subscribe requires a topic');
          this.subscribe(topic, port);
          break;
        case 'unsubscribe':
          if (!topic) throw new Error('unsubscribe requires a topic');
          this.unsubscribe(topic, port);
          break;
        case 'broadcast':
          if (!topic) throw new Error('broadcast requires a topic');
          this.broadcast(topic, payload, msg.sourcePageId);
          break;
        case 'request':
        case 'request-stream':
          if (!topic || !requestId) throw new Error(`${type} requires topic and requestId`);
          this.request(type, topic, payload, requestId, port);
          break;
        case 'response':
          if (!requestId) throw new Error('response requires requestId');
          this.response(requestId, payload, port);
          break;
        case 'error':
          if (requestId) this.forwardError(requestId, msg);
          break;
        case 'stream-chunk':
          if (!requestId) throw new Error('stream-chunk requires requestId');
          this.pendingRequests.get(requestId)?.postMessage({ type: 'stream-chunk', requestId, payload });
          break;
        case 'stream-end':
          if (!requestId) throw new Error('stream-end requires requestId');
          this.streamEnd(requestId);
          break;
        case 'register':
          if (!msg.agentId) throw new Error('register requires agentId');
          this.registerAgent(msg.agentId, msg.capabilities, msg.metadata, port);
          break;
        case 'discover':
          if (!requestId) throw new Error('discover requires requestId');
          this.discoverAgents(requestId, port);
          break;
        case 'watch-agents':
          this.agentWatchers.add(port);
          break;
        case 'disconnect':
          this.disconnect(port);
          break;
        default:
          throw new Error(`Unknown message type: "${String(type)}"`);
      }
    } catch (err) {
      port.postMessage({ type: 'error', topic, requestId, error: (err as Error).message });
    }
  }

  // ---- Pub/Sub ---------------------------------------------------------------

  private subscribe(topic: string, port: HubPort): void {
    let subs = this.topicSubscribers.get(topic);
    if (!subs) {
      subs = new Set();
      this.topicSubscribers.set(topic, subs);
    }
    subs.add(port);
  }

  private unsubscribe(topic: string, port: HubPort): void {
    const subs = this.topicSubscribers.get(topic);
    if (!subs) return;
    subs.delete(port);
    if (subs.size === 0) this.forgetTopic(topic);
  }

  private forgetTopic(topic: string): void {
    this.topicSubscribers.delete(topic);
    this.rrCounters.delete(topic);
  }

  private broadcast(topic: string, payload: unknown, sourcePageId: string | undefined): void {
    this.topicSubscribers.get(topic)?.forEach(port => {
      port.postMessage({ type: 'broadcast', topic, payload, sourcePageId });
    });
  }

  // ---- Request / reply / streaming -------------------------------------------

  private pickHandler(topic: string): HubPort | null {
    const subs = this.topicSubscribers.get(topic);
    if (!subs || subs.size === 0) return null;
    const handlers = Array.from(subs);
    const idx = (this.rrCounters.get(topic) ?? 0) % handlers.length;
    this.rrCounters.set(topic, idx + 1);
    return handlers[idx];
  }

  private request(type: string, topic: string, payload: unknown, requestId: string, origin: HubPort): void {
    const handler = this.pickHandler(topic);
    if (!handler) {
      origin.postMessage({
        type: 'error',
        topic,
        requestId,
        error: `No handler registered for topic "${topic}"`,
        code: 'NO_HANDLER',
      });
      return;
    }
    this.pendingRequests.set(requestId, origin);
    handler.postMessage({ type, topic, payload, requestId });
  }

  private response(requestId: string, payload: unknown, responder: HubPort): void {
    const origin = this.pendingRequests.get(requestId);
    if (!origin) {
      responder.postMessage({
        type: 'error',
        requestId,
        error: `No pending request for id "${requestId}"`,
        code: 'HANDLER_REJECTED',
      });
      return;
    }
    this.pendingRequests.delete(requestId);
    origin.postMessage({ type: 'response', requestId, payload });
  }

  private forwardError(requestId: string, msg: HubMessage): void {
    const origin = this.pendingRequests.get(requestId);
    if (!origin) return;
    this.pendingRequests.delete(requestId);
    origin.postMessage({ type: 'error', requestId, error: msg.error, code: msg.code });
  }

  private streamEnd(requestId: string): void {
    const origin = this.pendingRequests.get(requestId);
    if (!origin) return;
    origin.postMessage({ type: 'stream-end', requestId });
    this.pendingRequests.delete(requestId);
  }

  // ---- Agents ----------------------------------------------------------------

  private registerAgent(
    agentId: string,
    capabilities: string[] | undefined,
    metadata: Record<string, unknown> | undefined,
    port: HubPort,
  ): void {
    const registration: AgentRegistration = { agentId, capabilities, metadata };
    this.agentRegistry.set(agentId, registration);
    this.agentPortMap.set(agentId, port);
    this.notifyWatchers({ type: 'agent-joined', agent: registration });
  }

  private discoverAgents(requestId: string, port: HubPort): void {
    port.postMessage({ type: 'agent-list', requestId, agents: Array.from(this.agentRegistry.values()) });
  }

  private notifyWatchers(message: unknown): void {
    this.agentWatchers.forEach(watcher => watcher.postMessage(message));
  }
}
