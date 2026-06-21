import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";

export default defineConfig({
  server: { port: 3000 },
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: "mcp_host",
      remotes: {
        ollama_agent: "ollama_agent@http://localhost:3001/mf-manifest.json",
        scribe_agent: "scribe_agent@http://localhost:3002/mf-manifest.json",
      },
      shared: {
        react: { singleton: true, eager: true, requiredVersion: "^18.3.1" },
        "react-dom": { singleton: true, eager: true, requiredVersion: "^18.3.1" },
        "@palinc/nirnam": { singleton: true },
        "@modelcontextprotocol/sdk": { singleton: true, requiredVersion: "^1.0.0" },
      },
    }),
  ],
});
