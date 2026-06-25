import workerSource from './worker-source';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface NirnamRsbuildPluginOptions {
  /**
   * Filename written inside `<root>/public/` and served as the static worker URL.
   * Defaults to `'nirnam-worker.js'` → served at `/nirnam-worker.js`.
   */
  workerPath?: string;
}

/** Minimal Rsbuild plugin API shape (structurally compatible with `RsbuildPlugin`). */
interface RsbuildPluginAPI {
  context: { rootPath: string };
  modifyRsbuildConfig(fn: (config: Record<string, unknown>) => void): void;
  onBeforeBuild(fn: () => void): void;
  onBeforeStartDevServer(fn: () => void): void;
}

/**
 * Minimal Rsbuild plugin shape (structurally compatible with Rsbuild's
 * `RsbuildPlugin` type). Accepts a `RsbuildPlugin` annotation without
 * importing from `@rsbuild/core`.
 */
export interface NirnamRsbuildPlugin {
  name: string;
  setup(api: RsbuildPluginAPI): void;
}

/**
 * Rsbuild plugin that enables Layer 3 (static URL SharedWorker) for Nirnam.
 *
 * - Copies the Nirnam worker script to `<root>/public/<workerPath>` before
 *   every build and every dev-server start.
 * - Injects `__NIRNAM_STATIC_WORKER_URL__` via `source.define` so
 *   `createBus()` picks it up automatically.
 *
 * @example
 * // rsbuild.config.ts
 * import { nirnamRsbuildPlugin } from '@palinc/nirnam/rsbuild';
 * export default defineConfig({ plugins: [nirnamRsbuildPlugin()] });
 */
export function nirnamRsbuildPlugin(
  options?: NirnamRsbuildPluginOptions,
): NirnamRsbuildPlugin {
  const workerPath = options?.workerPath ?? 'nirnam-worker.js';
  const workerUrl = `/${workerPath}`;

  return {
    name: 'nirnam-rsbuild-plugin',
    setup(api) {
      api.modifyRsbuildConfig((config) => {
        const source =
          (config.source as Record<string, unknown> | undefined) ?? {};
        const define =
          (source.define as Record<string, string> | undefined) ?? {};
        define.__NIRNAM_STATIC_WORKER_URL__ = JSON.stringify(workerUrl);
        source.define = define;
        config.source = source;
      });

      const writeWorker = () => {
        const publicDir = join(api.context.rootPath, 'public');
        mkdirSync(publicDir, { recursive: true });
        writeFileSync(join(publicDir, workerPath), workerSource);
      };

      api.onBeforeBuild(writeWorker);
      api.onBeforeStartDevServer(writeWorker);
    },
  };
}
