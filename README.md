# MemQ MCP Server

This is the standalone Model Context Protocol (MCP) server for **MemQ** — the sovereign memory protocol by Multinex AI.

## Overview
MemQ provides a multi-tiered graph memory protocol (HOT/WARM/COLD) powering persistent agent recall across Redis, Qdrant, and Neo4j/FalkorDB.

## Installation

### For Claude Desktop (via Smithery)
To install the MemQ MCP Server in Claude Desktop, use the Smithery CLI:
```bash
npx @smithery/cli install @multinex/memq-mcp --client claude
```

### Manual Installation (Cursor / Windsurf / Copilot / Claude)
Add the following to your project's `.mcp.json` or your global MCP configuration file:

```json
{
  "mcpServers": {
    "memq-mcp": {
      "command": "deno",
      "args": [
        "run",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "mod.ts"
      ],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "FALKOR_REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

## Running via Docker
If you prefer to run the gateway as a container or deploy it to a remote environment:
```bash
docker run -p 8000:8000 ghcr.io/multinex-ai/memq-mcp:latest
```

## Configuration
MemQ requires running backends to store memory. Set the following environment variables if not using the defaults:
- `QDRANT_URL` (default: http://localhost:6333)
- `FALKOR_REDIS_URL` (default: redis://localhost:6379)
- `SOUL_JOURNAL_PATH` (default: /tmp/soul_journal.jsonl)
