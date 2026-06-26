import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";

export default defineConfig({
  server: { port: 3002 },
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: "scribe_agent",
      dts: false,
      exposes: {
        "./ScribeAgent": "./src/components/ScribeAgent",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^18.3.1" },
        "react-dom": { singleton: true, requiredVersion: "^18.3.1" },
        "@palinc/nirnam": { singleton: true },
        "@modelcontextprotocol/sdk": { singleton: true, requiredVersion: "^1.0.0" },
      },
    }),
  ],
});
