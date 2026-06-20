import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";

export default defineConfig({
  server: { port: 3001 },
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: "ollama_agent",
      dts: false,
      exposes: {
        "./OllamaAgent": "./src/components/OllamaAgent",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^18.3.1" },
        "react-dom": { singleton: true, requiredVersion: "^18.3.1" },
        "@shaurcasm/nirnam": { singleton: true },
        "@modelcontextprotocol/sdk": { singleton: true, requiredVersion: "^1.0.0" },
      },
    }),
  ],
});
