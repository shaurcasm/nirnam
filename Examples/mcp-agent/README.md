# mcp-agent — Document Q&A Example

Three MFEs communicating via `NirnamMCPTransport`:

| App | Port | Role |
|---|---|---|
| `host` | 3000 | Orchestrator UI |
| `ollama-agent` | 3001 | MCP server — document analysis via local Ollama |
| `scribe-agent` | 3002 | MCP server — Q&A tracking and markdown export |

## Prerequisites

1. **Ollama** running locally with a model pulled:

   ```bash
   # Start Ollama with CORS allowed from the host page
   OLLAMA_ORIGINS=http://localhost:3000 ollama serve

   # In another terminal, pull the model (first run only)
   ollama pull llama3.2
   ```

2. **Node 18+** and `npm`.

## Running

Open three terminals:

```bash
# Terminal 1 — OllamaAgent remote (MCP server)
cd Examples/mcp-agent/ollama-agent
npm install && npm run dev

# Terminal 2 — ScribeAgent remote (MCP server)
cd Examples/mcp-agent/scribe-agent
npm install && npm run dev

# Terminal 3 — Host (orchestrator UI)
cd Examples/mcp-agent/host
npm install && npm run dev
```

Open **http://localhost:3000** in your browser.

## How it works

1. The host loads `OllamaAgent` and `ScribeAgent` as remote MFEs via Module Federation.
   Loading them also starts their MCP servers — each one calls `server.connect(transport)`
   where the transport is a `NirnamMCPTransport` backed by the Nirnam SharedWorker bus.

2. Module Federation shares `@palinc/nirnam` as a singleton, so all three MFEs
   connect to the **same SharedWorker process**. This is essential for agent discovery
   and MCP message routing to work.

3. The Orchestrator creates two MCP clients (`host-ollama → ollama-agent` and
   `host-scribe → scribe-agent`) and coordinates:

   ```
   User pastes markdown  →  ollamaClient.callTool('load_document', { content })
                         →  Ollama summarises it

   User asks question    →  ollamaClient.callTool('ask', { question })
                         →  Ollama answers using document as context
                         →  scribeClient.callTool('record', { question, answer })
                         →  Q&A doc updated

   User clicks Download  →  scribeClient.callTool('get_document')
                         →  browser saves qa-document.md
   ```

## Changing the model

Pass `model` in the `ask` call, or change the default in `OllamaAgent.tsx`:

```ts
const answer = await ollamaClient.callTool({
  name: "ask",
  arguments: { question, model: "mistral" },
});
```

Any model you have pulled in Ollama (`ollama list`) works.
