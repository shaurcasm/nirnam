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
];
