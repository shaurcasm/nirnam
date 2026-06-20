/**
 * SharedWorker script source -- embedded as a string so the library is
 * self-contained (no static file deployment required by default).
 *
 * Runs in classic mode (no type:"module") for maximum browser compatibility,
 * including Firefox, which has historically been unreliable with module-mode
 * SharedWorkers loaded from Blob URLs.
 */
const workerSource = `
var MESSAGE_TYPES = {
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  BROADCAST: 'broadcast',
  REQUEST: 'request',
  RESPONSE: 'response',
  REQUEST_STREAM: 'request-stream',
  STREAM_CHUNK: 'stream-chunk',
  STREAM_END: 'stream-end',
  REGISTER: 'register',
  DISCOVER: 'discover',
  WATCH_AGENTS: 'watch-agents'
};

function MessageBus() {
  this.topicSubscribers = new Map();
  this.pendingRequests = new Map();
  this.rrCounters = new Map();
  // Agent registry: agentId -> { agentId, capabilities, metadata }
  this.agentRegistry = new Map();
  // Maps agentId -> port so we can clean up on port close
  this.agentPortMap = new Map();
  // Ports that want agent-joined / agent-left notifications
  this.agentWatchers = new Set();
}

MessageBus.prototype.subscribe = function(topic, port) {
  var subs = this.topicSubscribers.get(topic);
  if (!subs) { subs = new Set(); this.topicSubscribers.set(topic, subs); }
  subs.add(port);
};

MessageBus.prototype.unsubscribe = function(topic, port) {
  var subs = this.topicSubscribers.get(topic);
  if (!subs) return;
  subs.delete(port);
  if (subs.size === 0) {
    this.topicSubscribers.delete(topic);
    this.rrCounters.delete(topic);
  }
};

MessageBus.prototype.unsubscribePort = function(port) {
  var self = this;
  self.topicSubscribers.forEach(function(subs, topic) {
    subs.delete(port);
    if (subs.size === 0) {
      self.topicSubscribers.delete(topic);
      self.rrCounters.delete(topic);
    }
  });
  self.pendingRequests.forEach(function(originPort, id) {
    if (originPort === port) self.pendingRequests.delete(id);
  });
  // Clean up agent registry entries owned by this port
  var leftAgents = [];
  self.agentPortMap.forEach(function(agentPort, agentId) {
    if (agentPort === port) {
      self.agentPortMap.delete(agentId);
      self.agentRegistry.delete(agentId);
      leftAgents.push(agentId);
    }
  });
  leftAgents.forEach(function(agentId) {
    self.agentWatchers.forEach(function(watcher) {
      watcher.postMessage({ type: 'agent-left', agentId: agentId });
    });
  });
  self.agentWatchers.delete(port);
};

MessageBus.prototype.broadcast = function(topic, payload, sourcePageId) {
  var subs = this.topicSubscribers.get(topic);
  if (!subs) return;
  subs.forEach(function(port) {
    port.postMessage({ type: 'broadcast', topic: topic, payload: payload, sourcePageId: sourcePageId });
  });
};

MessageBus.prototype._pickHandler = function(topic) {
  var subs = this.topicSubscribers.get(topic);
  if (!subs || subs.size === 0) return null;
  var arr = Array.from(subs);
  var idx = (this.rrCounters.get(topic) || 0) % arr.length;
  this.rrCounters.set(topic, idx + 1);
  return arr[idx];
};

MessageBus.prototype.request = function(topic, payload, requestId, originPort, msgType) {
  var handler = this._pickHandler(topic);
  if (!handler) {
    originPort.postMessage({
      type: 'error',
      topic: topic,
      requestId: requestId,
      error: 'No handler registered for topic "' + topic + '"',
      code: 'NO_HANDLER'
    });
    return;
  }
  this.pendingRequests.set(requestId, originPort);
  handler.postMessage({ type: msgType || 'request', topic: topic, payload: payload, requestId: requestId });
};

MessageBus.prototype.response = function(requestId, payload, respondingPort) {
  var originPort = this.pendingRequests.get(requestId);
  if (!originPort) {
    respondingPort.postMessage({
      type: 'error',
      requestId: requestId,
      error: 'No pending request for id "' + requestId + '"',
      code: 'HANDLER_REJECTED'
    });
    return;
  }
  this.pendingRequests.delete(requestId);
  originPort.postMessage({ type: 'response', requestId: requestId, payload: payload });
};

MessageBus.prototype.streamChunk = function(requestId, payload) {
  var originPort = this.pendingRequests.get(requestId);
  if (originPort) {
    originPort.postMessage({ type: 'stream-chunk', requestId: requestId, payload: payload });
  }
};

MessageBus.prototype.streamEnd = function(requestId) {
  var originPort = this.pendingRequests.get(requestId);
  if (originPort) {
    originPort.postMessage({ type: 'stream-end', requestId: requestId });
    this.pendingRequests.delete(requestId);
  }
};

MessageBus.prototype.registerAgent = function(agentId, capabilities, metadata, port) {
  this.agentRegistry.set(agentId, { agentId: agentId, capabilities: capabilities, metadata: metadata });
  this.agentPortMap.set(agentId, port);
  var reg = { agentId: agentId, capabilities: capabilities, metadata: metadata };
  this.agentWatchers.forEach(function(watcher) {
    watcher.postMessage({ type: 'agent-joined', agent: reg });
  });
};

MessageBus.prototype.discoverAgents = function(requestId, requestingPort) {
  var agents = [];
  this.agentRegistry.forEach(function(reg) { agents.push(reg); });
  requestingPort.postMessage({ type: 'agent-list', requestId: requestId, agents: agents });
};

MessageBus.prototype.watchAgents = function(port) {
  this.agentWatchers.add(port);
};

var messageBus = null;

onconnect = function(event) {
  var port = event.ports[0];

  if (!messageBus) {
    messageBus = new MessageBus();
  }

  port.addEventListener('close', function() {
    messageBus.unsubscribePort(port);
  });

  port.onmessage = function(event) {
    var data = event.data;
    var type = data.type;
    var topic = data.topic;
    var payload = data.payload;
    var requestId = data.requestId;
    var sourcePageId = data.sourcePageId;
    var agentId = data.agentId;
    var capabilities = data.capabilities;
    var metadata = data.metadata;

    try {
      switch (type) {
        case MESSAGE_TYPES.SUBSCRIBE:
          if (!topic) throw new Error('subscribe requires a topic');
          messageBus.subscribe(topic, port);
          break;
        case MESSAGE_TYPES.UNSUBSCRIBE:
          if (!topic) throw new Error('unsubscribe requires a topic');
          messageBus.unsubscribe(topic, port);
          break;
        case MESSAGE_TYPES.BROADCAST:
          if (!topic) throw new Error('broadcast requires a topic');
          messageBus.broadcast(topic, payload, sourcePageId);
          break;
        case MESSAGE_TYPES.REQUEST:
          if (!topic || !requestId) throw new Error('request requires topic and requestId');
          messageBus.request(topic, payload, requestId, port, 'request');
          break;
        case MESSAGE_TYPES.REQUEST_STREAM:
          if (!topic || !requestId) throw new Error('request-stream requires topic and requestId');
          messageBus.request(topic, payload, requestId, port, 'request-stream');
          break;
        case MESSAGE_TYPES.RESPONSE:
          if (!requestId) throw new Error('response requires requestId');
          messageBus.response(requestId, payload, port);
          break;
        case MESSAGE_TYPES.STREAM_CHUNK:
          if (!requestId) throw new Error('stream-chunk requires requestId');
          messageBus.streamChunk(requestId, payload);
          break;
        case MESSAGE_TYPES.STREAM_END:
          if (!requestId) throw new Error('stream-end requires requestId');
          messageBus.streamEnd(requestId);
          break;
        case MESSAGE_TYPES.REGISTER:
          if (!agentId) throw new Error('register requires agentId');
          messageBus.registerAgent(agentId, capabilities, metadata, port);
          break;
        case MESSAGE_TYPES.DISCOVER:
          if (!requestId) throw new Error('discover requires requestId');
          messageBus.discoverAgents(requestId, port);
          break;
        case MESSAGE_TYPES.WATCH_AGENTS:
          messageBus.watchAgents(port);
          break;
        default:
          throw new Error('Unknown message type: "' + type + '"');
      }
    } catch (err) {
      port.postMessage({ type: 'error', topic: topic, requestId: requestId, error: err.message });
    }
  };

  port.start();
};
`;

export default workerSource;
