import workerSource from './worker-source';

export interface NirnamWebpackPluginOptions {
  /**
   * Output filename for the worker asset (relative to the webpack output path).
   * Defaults to `'nirnam-worker.js'` → served at `/nirnam-worker.js`.
   */
  workerPath?: string;
}

/** Minimal webpack Compiler shape (structurally compatible with webpack 5 `Compiler`). */
interface MinimalCompiler {
  webpack: {
    DefinePlugin: new (
      definitions: Record<string, string>,
    ) => { apply(compiler: MinimalCompiler): void };
    Compilation: { PROCESS_ASSETS_STAGE_ADDITIONAL: number };
    sources: { RawSource: new (source: string) => unknown };
  };
  hooks: {
    thisCompilation: {
      tap(name: string, fn: (compilation: MinimalCompilation) => void): void;
    };
  };
}

interface MinimalCompilation {
  hooks: {
    processAssets: {
      tap(
        options: { name: string; stage: number },
        fn: () => void,
      ): void;
    };
  };
  emitAsset(filename: string, source: unknown): void;
}

/**
 * Webpack 5 plugin that enables Layer 3 (static URL SharedWorker) for Nirnam.
 *
 * - Emits the Nirnam worker script as `<workerPath>` in the webpack output so
 *   it is served as a stable static file.
 * - Injects `__NIRNAM_STATIC_WORKER_URL__` via an internal `DefinePlugin` so
 *   `createBus()` picks it up automatically.
 *
 * @example
 * // webpack.config.js
 * const { NirnamWebpackPlugin } = require('@palinc/nirnam/webpack');
 * module.exports = { plugins: [new NirnamWebpackPlugin()] };
 */
export class NirnamWebpackPlugin {
  private readonly workerPath: string;
  private readonly workerUrl: string;

  constructor(options?: NirnamWebpackPluginOptions) {
    this.workerPath = options?.workerPath ?? 'nirnam-worker.js';
    this.workerUrl = `/${this.workerPath}`;
  }

  apply(compiler: MinimalCompiler): void {
    const { DefinePlugin, Compilation, sources } = compiler.webpack;
    const { RawSource } = sources;

    new DefinePlugin({
      __NIRNAM_STATIC_WORKER_URL__: JSON.stringify(this.workerUrl),
    }).apply(compiler);

    compiler.hooks.thisCompilation.tap('NirnamWebpackPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'NirnamWebpackPlugin',
          stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          compilation.emitAsset(this.workerPath, new RawSource(workerSource));
        },
      );
    });
  }
}
