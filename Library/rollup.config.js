import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';

const plugins = [
  resolve({ extensions: ['.ts', '.js'] }),
  commonjs(),
  typescript({
    tsconfig: './tsconfig.json',
    exclude: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
  }),
  terser({ compress: { drop_console: false } }),
];

export default [
  // Main bundle
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.js', format: 'cjs', sourcemap: true },
      { file: 'dist/index.esm.js', format: 'esm', sourcemap: true },
      { name: 'Nirnam', file: 'dist/index.umd.js', format: 'umd', sourcemap: true },
    ],
    plugins,
  },
  // MCP transport bundle (separate subpath export, no external deps)
  {
    input: 'src/mcp.ts',
    output: [
      { file: 'dist/mcp.js', format: 'cjs', sourcemap: true },
      { file: 'dist/mcp.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins,
  },
  // React integration bundle
  {
    input: 'src/react.ts',
    external: ['react'],
    output: [
      { file: 'dist/react.js', format: 'cjs', sourcemap: true },
      { file: 'dist/react.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins,
  },
  // Angular integration bundle
  {
    input: 'src/angular.ts',
    external: ['rxjs'],
    output: [
      { file: 'dist/angular.js', format: 'cjs', sourcemap: true },
      { file: 'dist/angular.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins,
  },
  // Type declarations -- main
  {
    input: 'dist/index.d.ts',
    output: [{ file: 'dist/index.d.ts', format: 'es' }],
    plugins: [dts()],
    external: [/\.css$/],
  },
  // Type declarations -- mcp
  {
    input: 'dist/mcp.d.ts',
    output: [{ file: 'dist/mcp.d.ts', format: 'es' }],
    plugins: [dts()],
    external: [/\.css$/],
  },
  // Type declarations -- react
  {
    input: 'dist/react.d.ts',
    output: [{ file: 'dist/react.d.ts', format: 'es' }],
    plugins: [dts()],
    external: ['react', /\.css$/],
  },
  // Type declarations -- angular
  {
    input: 'dist/angular.d.ts',
    output: [{ file: 'dist/angular.d.ts', format: 'es' }],
    plugins: [dts()],
    external: ['rxjs', /\.css$/],
  },
  // Agent layer bundle
  {
    input: 'src/agents.ts',
    output: [
      { file: 'dist/agents.js', format: 'cjs', sourcemap: true },
      { file: 'dist/agents.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins,
  },
  // Agent React hooks bundle
  {
    input: 'src/agents-react.ts',
    external: ['react'],
    output: [
      { file: 'dist/agents-react.js', format: 'cjs', sourcemap: true },
      { file: 'dist/agents-react.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins,
  },
  // Agent testing utilities bundle
  {
    input: 'src/agents-testing.ts',
    output: [
      { file: 'dist/agents-testing.js', format: 'cjs', sourcemap: true },
      { file: 'dist/agents-testing.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins,
  },
  // Type declarations -- agents
  {
    input: 'dist/agents.d.ts',
    output: [{ file: 'dist/agents.d.ts', format: 'es' }],
    plugins: [dts()],
    external: [/\.css$/],
  },
  // Type declarations -- agents/react
  {
    input: 'dist/agents-react.d.ts',
    output: [{ file: 'dist/agents-react.d.ts', format: 'es' }],
    plugins: [dts()],
    external: ['react', /\.css$/],
  },
  // Type declarations -- agents/testing
  {
    input: 'dist/agents-testing.d.ts',
    output: [{ file: 'dist/agents-testing.d.ts', format: 'es' }],
    plugins: [dts()],
    external: [/\.css$/],
  },
];
