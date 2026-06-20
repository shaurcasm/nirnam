import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

export default defineConfig({
  server: {
    port: 5002,
    headers: { 'Access-Control-Allow-Origin': '*' },
  },
  output: {
    assetPrefix: 'auto',
  },
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: 'host',
      remotes: {
        remote: 'remote@http://localhost:3002/remoteEntry.js',
      },
      exposes: {
        './ButtonEventResponse': './src/events/ButtonEventResponse',
      },
      filename: 'remoteEntry.js',
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true },
        '@shaurcasm/nirnam': { singleton: true },
      },
    }),
  ],
});
