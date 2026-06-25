/**
 * Unit tests for the three build-tool plugins that enable Layer 3
 * (static URL SharedWorker) deployment:
 *   @palinc/nirnam/vite   → nirnamPlugin
 *   @palinc/nirnam/rsbuild → nirnamRsbuildPlugin
 *   @palinc/nirnam/webpack → NirnamWebpackPlugin
 *
 * node:fs is mocked throughout so no real files are written.
 * The worker source module is replaced with a short stub.
 */

jest.mock('../src/worker-source', () => ({ __esModule: true, default: '/* test worker source */' }));
jest.mock('node:fs', () => ({
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { nirnamPlugin } from '../src/vite';
import { nirnamRsbuildPlugin } from '../src/rsbuild';
import { NirnamWebpackPlugin } from '../src/webpack';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal mock webpack Compiler whose hooks fire synchronously. */
function createMockCompiler() {
  const emitAsset = jest.fn();
  const processAssetsTap = jest.fn((_opts: unknown, fn: () => void) => fn());

  const mockCompilation = {
    hooks: { processAssets: { tap: processAssetsTap } },
    emitAsset,
  };

  const thisCompilationTap = jest.fn(
    (_name: string, fn: (c: typeof mockCompilation) => void) => fn(mockCompilation),
  );

  const definePluginApply = jest.fn();
  const DefinePlugin = jest.fn().mockReturnValue({ apply: definePluginApply });
  const RawSource = jest.fn().mockImplementation((src: string) => ({ _source: src }));

  const compiler = {
    webpack: {
      DefinePlugin,
      Compilation: { PROCESS_ASSETS_STAGE_ADDITIONAL: 100 },
      sources: { RawSource },
    },
    hooks: { thisCompilation: { tap: thisCompilationTap } },
  };

  return {
    compiler,
    mocks: { DefinePlugin, definePluginApply, thisCompilationTap, processAssetsTap, emitAsset, RawSource },
  };
}

/** Creates a minimal mock Rsbuild plugin API that captures callbacks. */
function createMockRsbuildAPI(rootPath = '/app') {
  const configCallbacks: Array<(config: Record<string, unknown>) => void> = [];
  const beforeBuildCallbacks: Array<() => void> = [];
  const beforeDevCallbacks: Array<() => void> = [];

  const api = {
    context: { rootPath },
    modifyRsbuildConfig: jest.fn((fn: (c: Record<string, unknown>) => void) => {
      configCallbacks.push(fn);
    }),
    onBeforeBuild: jest.fn((fn: () => void) => beforeBuildCallbacks.push(fn)),
    onBeforeStartDevServer: jest.fn((fn: () => void) => beforeDevCallbacks.push(fn)),
  };

  return {
    api,
    runConfigCallbacks: (config: Record<string, unknown> = {}) => {
      configCallbacks.forEach(fn => fn(config));
      return config;
    },
    runBeforeBuild: () => beforeBuildCallbacks.forEach(fn => fn()),
    runBeforeDev: () => beforeDevCallbacks.forEach(fn => fn()),
  };
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// nirnamPlugin (Vite)
// ---------------------------------------------------------------------------

describe('nirnamPlugin (Vite)', () => {
  it('has the correct plugin name', () => {
    expect(nirnamPlugin().name).toBe('nirnam');
  });

  it('injects __NIRNAM_STATIC_WORKER_URL__ via define with default path', () => {
    const cfg = nirnamPlugin().config();
    expect(cfg.define.__NIRNAM_STATIC_WORKER_URL__).toBe(JSON.stringify('/nirnam-worker.js'));
  });

  it('injects a custom workerPath URL', () => {
    const cfg = nirnamPlugin({ workerPath: 'workers/bus.js' }).config();
    expect(cfg.define.__NIRNAM_STATIC_WORKER_URL__).toBe(JSON.stringify('/workers/bus.js'));
  });

  it('writes the worker source to publicDir with default filename', () => {
    nirnamPlugin().configResolved({ publicDir: '/app/public' });
    expect(mkdirSync).toHaveBeenCalledWith('/app/public', { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      join('/app/public', 'nirnam-worker.js'),
      '/* test worker source */',
    );
  });

  it('writes to a custom workerPath inside publicDir', () => {
    nirnamPlugin({ workerPath: 'workers/bus.js' }).configResolved({ publicDir: '/out/public' });
    expect(writeFileSync).toHaveBeenCalledWith(
      join('/out/public', 'workers/bus.js'),
      '/* test worker source */',
    );
  });
});

// ---------------------------------------------------------------------------
// nirnamRsbuildPlugin (Rsbuild)
// ---------------------------------------------------------------------------

describe('nirnamRsbuildPlugin (Rsbuild)', () => {
  it('has the correct plugin name', () => {
    expect(nirnamRsbuildPlugin().name).toBe('nirnam-rsbuild-plugin');
  });

  it('registers modifyRsbuildConfig, onBeforeBuild, onBeforeStartDevServer hooks', () => {
    const { api, runConfigCallbacks } = createMockRsbuildAPI();
    nirnamRsbuildPlugin().setup(api);
    runConfigCallbacks();
    expect(api.modifyRsbuildConfig).toHaveBeenCalledTimes(1);
    expect(api.onBeforeBuild).toHaveBeenCalledTimes(1);
    expect(api.onBeforeStartDevServer).toHaveBeenCalledTimes(1);
  });

  it('injects __NIRNAM_STATIC_WORKER_URL__ into source.define with default path', () => {
    const { api, runConfigCallbacks } = createMockRsbuildAPI();
    nirnamRsbuildPlugin().setup(api);
    const config = runConfigCallbacks({});
    expect((config.source as Record<string, unknown>).define).toEqual({
      __NIRNAM_STATIC_WORKER_URL__: JSON.stringify('/nirnam-worker.js'),
    });
  });

  it('injects a custom workerPath URL into source.define', () => {
    const { api, runConfigCallbacks } = createMockRsbuildAPI();
    nirnamRsbuildPlugin({ workerPath: 'static/bus.js' }).setup(api);
    const config = runConfigCallbacks({});
    expect((config.source as Record<string, unknown>).define).toEqual({
      __NIRNAM_STATIC_WORKER_URL__: JSON.stringify('/static/bus.js'),
    });
  });

  it('merges into existing source.define entries', () => {
    const { api, runConfigCallbacks } = createMockRsbuildAPI();
    nirnamRsbuildPlugin().setup(api);
    const config = runConfigCallbacks({ source: { define: { EXISTING: '"yes"' } } });
    const define = (config.source as Record<string, unknown>).define as Record<string, string>;
    expect(define.EXISTING).toBe('"yes"');
    expect(define.__NIRNAM_STATIC_WORKER_URL__).toBe(JSON.stringify('/nirnam-worker.js'));
  });

  it('writes worker file to <rootPath>/public on beforeBuild', () => {
    const { api, runBeforeBuild } = createMockRsbuildAPI('/project');
    nirnamRsbuildPlugin().setup(api);
    runBeforeBuild();
    expect(mkdirSync).toHaveBeenCalledWith(join('/project', 'public'), { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      join('/project', 'public', 'nirnam-worker.js'),
      '/* test worker source */',
    );
  });

  it('writes worker file to <rootPath>/public on beforeStartDevServer', () => {
    const { api, runBeforeDev } = createMockRsbuildAPI('/project');
    nirnamRsbuildPlugin().setup(api);
    runBeforeDev();
    expect(writeFileSync).toHaveBeenCalledWith(
      join('/project', 'public', 'nirnam-worker.js'),
      '/* test worker source */',
    );
  });

  it('uses a custom workerPath when writing the file', () => {
    const { api, runBeforeBuild } = createMockRsbuildAPI('/root');
    nirnamRsbuildPlugin({ workerPath: 'assets/w.js' }).setup(api);
    runBeforeBuild();
    expect(writeFileSync).toHaveBeenCalledWith(
      join('/root', 'public', 'assets/w.js'),
      '/* test worker source */',
    );
  });
});

// ---------------------------------------------------------------------------
// NirnamWebpackPlugin (Webpack 5)
// ---------------------------------------------------------------------------

describe('NirnamWebpackPlugin (Webpack)', () => {
  it('applies DefinePlugin with the default worker URL', () => {
    const { compiler, mocks } = createMockCompiler();
    new NirnamWebpackPlugin().apply(compiler as never);
    expect(mocks.DefinePlugin).toHaveBeenCalledWith({
      __NIRNAM_STATIC_WORKER_URL__: JSON.stringify('/nirnam-worker.js'),
    });
    expect(mocks.definePluginApply).toHaveBeenCalledWith(compiler);
  });

  it('applies DefinePlugin with a custom workerPath URL', () => {
    const { compiler, mocks } = createMockCompiler();
    new NirnamWebpackPlugin({ workerPath: 'static/nirnam.js' }).apply(compiler as never);
    expect(mocks.DefinePlugin).toHaveBeenCalledWith({
      __NIRNAM_STATIC_WORKER_URL__: JSON.stringify('/static/nirnam.js'),
    });
  });

  it('taps thisCompilation with the plugin name', () => {
    const { compiler, mocks } = createMockCompiler();
    new NirnamWebpackPlugin().apply(compiler as never);
    expect(mocks.thisCompilationTap).toHaveBeenCalledWith(
      'NirnamWebpackPlugin',
      expect.any(Function),
    );
  });

  it('emits the worker source as an asset with default filename', () => {
    const { compiler, mocks } = createMockCompiler();
    new NirnamWebpackPlugin().apply(compiler as never);
    expect(mocks.emitAsset).toHaveBeenCalledWith('nirnam-worker.js', expect.objectContaining({ _source: '/* test worker source */' }));
  });

  it('emits the worker source with a custom filename', () => {
    const { compiler, mocks } = createMockCompiler();
    new NirnamWebpackPlugin({ workerPath: 'workers/w.js' }).apply(compiler as never);
    expect(mocks.emitAsset).toHaveBeenCalledWith(
      'workers/w.js',
      expect.objectContaining({ _source: '/* test worker source */' }),
    );
  });

  it('taps processAssets at the ADDITIONAL stage', () => {
    const { compiler, mocks } = createMockCompiler();
    new NirnamWebpackPlugin().apply(compiler as never);
    expect(mocks.processAssetsTap).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'NirnamWebpackPlugin',
        stage: 100,
      }),
      expect.any(Function),
    );
  });
});
