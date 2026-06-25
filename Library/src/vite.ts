import workerSource from './worker-source';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface NirnamPluginOptions {
  /**
   * Filename written inside `publicDir` and served as the static worker URL.
   * Defaults to `'nirnam-worker.js'` → served at `/nirnam-worker.js`.
   */
  workerPath?: string;
}

/**
 * Minimal Vite Plugin shape (structurally compatible with Vite's `Plugin` type).
 * Accepts a `Plugin` annotation in vite.config.ts without importing from `vite`.
 */
export interface NirnamVitePlugin {
  name: string;
  config(): { define: Record<string, string> };
  configResolved(config: { publicDir: string }): void;
}

/**
 * Vite plugin that enables Layer 3 (static URL SharedWorker) for Nirnam.
 *
 * - Copies the Nirnam worker script to `<publicDir>/<workerPath>` so it is
 *   served as a stable static file (e.g. `/nirnam-worker.js`).
 * - Injects `__NIRNAM_STATIC_WORKER_URL__` via `define` so `createBus()`
 *   picks it up automatically without any explicit `workerUrl` option.
 *
 * @example
 * // vite.config.ts
 * import { nirnamPlugin } from '@palinc/nirnam/vite';
 * export default { plugins: [nirnamPlugin()] };
 *
 * // App code — URL auto-injected, no options needed
 * const bus = createBus();
 */
export function nirnamPlugin(options?: NirnamPluginOptions): NirnamVitePlugin {
  const workerPath = options?.workerPath ?? 'nirnam-worker.js';
  const workerUrl = `/${workerPath}`;

  return {
    name: 'nirnam',
    config() {
      return {
        define: {
          __NIRNAM_STATIC_WORKER_URL__: JSON.stringify(workerUrl),
        },
      };
    },
    configResolved(config) {
      mkdirSync(config.publicDir, { recursive: true });
      writeFileSync(join(config.publicDir, workerPath), workerSource);
    },
  };
}
