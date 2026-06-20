import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

export default [
  {
    input: 'src/index.ts',
    output: [
      { file: pkg.main, format: 'cjs', sourcemap: true },
      { file: pkg.module, format: 'esm', sourcemap: true },
      { name: 'Nirnam', file: pkg.unpkg, format: 'umd', sourcemap: true },
    ],
    plugins: [
      resolve({ extensions: ['.ts', '.js'] }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        exclude: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
      }),
      terser({ compress: { drop_console: false } }),
    ],
  },
  {
    input: 'dist/index.d.ts',
    output: [{ file: 'dist/index.d.ts', format: 'es' }],
    plugins: [dts()],
    external: [/\.css$/],
  },
];
