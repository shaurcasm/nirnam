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
        mcp_remote: "mcp_remote@http://localhost:3001/mf-manifest.json",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^18.3.1" },
        "react-dom": { singleton: true, requiredVersion: "^18.3.1" },
        "@shaurcasm/nirnam": { singleton: true, requiredVersion: "*" },
        "@modelcontextprotocol/sdk": { singleton: true, requiredVersion: "^1.0.0" },
      },
    }),
  ],
});
