# Workspace layout

Current repository layout for CodePilot Agent:

```
apps/web          Next.js frontend (scaffold)
apps/api          HTTP API (scaffold)
packages/agent    Agent loop package (scaffold)
packages/mcp-server
                  MCP server package (scaffold)
test-repository   Standalone sample app (`mini-checkout`) for agent demos
docs              Project documentation
```

Install and run the sample separately:

```bash
cd test-repository && npm install && npm test
```

This file describes layout only. Feature docs will be added when those features exist.
