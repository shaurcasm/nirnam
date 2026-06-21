import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

export default defineConfig({
  server: {
    port: 3002,
    headers: { 'Access-Control-Allow-Origin': '*' },
  },
  output: {
    assetPrefix: 'auto',
  },
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: 'remote',
      remotes: {
        host: 'host@http://localhost:5002/remoteEntry.js',
      },
      exposes: {
        './Button': './src/components/Button',
        './ButtonEvent': './src/events/ButtonEvent',
      },
      filename: 'remoteEntry.js',
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true },
        '@palinc/nirnam': { singleton: true },
      },
    }),
  ],
});
