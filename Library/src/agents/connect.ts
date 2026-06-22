import type { NirnamAgent } from './agent';
import type { ConnectOptions, UnsubscribeFn } from './types';

/**
 * Connect agents in a topology. Returns a teardown function that removes
 * all subscriptions set up by the connection.
 *
 * pipeline: agents[0] publishes → agents[1] receives, processes, publishes → agents[2] ...
 * fan-out:  agents[0] (source) publishes → all other agents receive and process independently.
 *
 * NOTE: Agents must share the same NirnamBus instance for messages to route correctly.
 * Agents run in the main thread — they do NOT survive page refresh and are NOT shared
 * across browser tabs. Cross-tab agent coordination requires the Layer 3 static SharedWorker
 * and is planned for a future major version.
 */
export function connectAgents(
  agents: NirnamAgent[],
  options: ConnectOptions,
): UnsubscribeFn {
  if (agents.length < 2) {
    throw new Error('[connectAgents] At least 2 agents are required.');
  }

  const unsubs: UnsubscribeFn[] = [];
  const { topology, topic } = options;

  if (topology === 'pipeline') {
    return _connectPipeline(agents, topic);
  }

  if (topology === 'fan-out') {
    return _connectFanOut(agents, topic);
  }

  return () => unsubs.forEach(u => u());
}

function _connectPipeline(agents: NirnamAgent[], topic: string): UnsubscribeFn {
  const unsubs: UnsubscribeFn[] = [];

  // agents[0] is the source; it publishes `nirnam:pipeline:{topic}:0`.
  // agents[i] (1..n-1) subscribe to stage i-1, run via agent.run(), publish to stage i.
  // agents[n-1] receives the final output from stage n-2.

  for (let i = 1; i < agents.length; i++) {
    const inputTopic = `nirnam:pipeline:${topic}:${i - 1}`;
    const outputTopic = `nirnam:pipeline:${topic}:${i}`;
    const agent = agents[i];
    const isLast = i === agents.length - 1;

    const unsub = agent.subscribe<string>(inputTopic, async (input) => {
      try {
        const result = await agent.run(input);
        if (!isLast) {
          agent.publish(outputTopic, result);
        }
      } catch (err) {
        console.error(`[connectAgents] Pipeline stage ${i} (${agent.agentId}) failed:`, err);
      }
    });

    unsubs.push(unsub);
  }

  // Attach a helper on the source agent that kicks off the pipeline
  const source = agents[0];
  const originalPublish = source.publish.bind(source);
  const kickTopic = `nirnam:pipeline:${topic}:0`;

  // Provide a named function to start the pipeline from the source
  const start = (input: string) => originalPublish(kickTopic, input);

  // Expose `start` via the source agent's publish on the given topic
  const startUnsub = (() => {
    (source as unknown as Record<string, unknown>)[`_pipeline_${topic}_start`] = start;
    return () => {
      delete (source as unknown as Record<string, unknown>)[`_pipeline_${topic}_start`];
    };
  })();

  unsubs.push(startUnsub);

  return () => unsubs.forEach(u => u());
}

function _connectFanOut(agents: NirnamAgent[], topic: string): UnsubscribeFn {
  if (agents.length < 2) {
    throw new Error('[connectAgents] fan-out requires at least 1 source and 1 receiver.');
  }

  const unsubs: UnsubscribeFn[] = [];
  const fanTopic = `nirnam:fanout:${topic}`;
  const receivers = agents.slice(1);

  // All receivers subscribe to the fan-out topic and process independently
  for (const agent of receivers) {
    const unsub = agent.subscribe<string>(fanTopic, async (input) => {
      try {
        await agent.run(input);
      } catch (err) {
        console.error(`[connectAgents] Fan-out receiver (${agent.agentId}) failed:`, err);
      }
    });
    unsubs.push(unsub);
  }

  // The source publishes to the fan-out topic
  const source = agents[0];
  const startUnsub = (() => {
    const publish = (input: string) => source.publish(fanTopic, input);
    (source as unknown as Record<string, unknown>)[`_fanout_${topic}_publish`] = publish;
    return () => {
      delete (source as unknown as Record<string, unknown>)[`_fanout_${topic}_publish`];
    };
  })();
  unsubs.push(startUnsub);

  return () => unsubs.forEach(u => u());
}

/**
 * Helper: publish to start a connected pipeline.
 * Equivalent to calling the source agent's pipeline publish directly.
 */
export function pipelinePublish(
  sourceAgent: NirnamAgent,
  topic: string,
  input: string,
): void {
  sourceAgent.publish(`nirnam:pipeline:${topic}:0`, input);
}

/**
 * Helper: publish to trigger a fan-out.
 */
export function fanOutPublish(
  sourceAgent: NirnamAgent,
  topic: string,
  input: string,
): void {
  sourceAgent.publish(`nirnam:fanout:${topic}`, input);
}
