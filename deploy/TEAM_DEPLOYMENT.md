# Mnemosyne Team Deployment Guide

Deploy a shared Mnemosyne MCP server to Google Cloud Run for your team.

## Prerequisites

- Google Cloud account with billing enabled
- `gcloud` CLI installed and authenticated
- Docker installed locally

## Quick Deploy (15 minutes)

### 1. Set Up Managed Backends

Mnemosyne requires Qdrant (vector DB) and FalkorDB (graph DB). Easiest options:

**Option A: Use Qdrant Cloud + Upstash Redis (Recommended for teams)**
```bash
# Qdrant Cloud: https://cloud.qdrant.io (free tier available)
# Upstash Redis: https://upstash.com (free tier, Redis-compatible)
```

**Option B: Deploy backends on Cloud Run (more control)**
```bash
# Deploy Qdrant
gcloud run deploy qdrant \
  --image qdrant/qdrant:v1.13.4 \
  --port 6333 \
  --memory 2Gi \
  --cpu 1 \
  --min-instances 1 \
  --region us-central1 \
  --allow-unauthenticated

# Deploy FalkorDB  
gcloud run deploy falkordb \
  --image falkordb/falkordb:v4.14.9 \
  --port 6379 \
  --memory 2Gi \
  --cpu 1 \
  --min-instances 1 \
  --region us-central1 \
  --allow-unauthenticated
```

### 2. Build and Push the Gateway Image

```bash
cd products/munx-memorystack/gateway-deno

# Configure your project
export PROJECT_ID=your-gcp-project-id
export REGION=us-central1

# Build and push
gcloud builds submit --tag ${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/mnemosyne-team:latest
```

### 3. Deploy to Cloud Run

```bash
# Set your backend URLs
export QDRANT_URL="https://your-qdrant-instance.cloud.qdrant.io:6333"
export FALKOR_URL="redis://your-upstash-endpoint:6379"

# Deploy
gcloud run deploy mnemosyne-team \
  --image ${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/mnemosyne-team:latest \
  --port 8000 \
  --memory 2Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --region ${REGION} \
  --allow-unauthenticated \
  --set-env-vars="PORT=8000,RELEASE_CHANNEL=self-hosted-prod,REQUIRE_AUTH=false,QDRANT_URL=${QDRANT_URL},FALKOR_REDIS_URL=${FALKOR_URL},SOUL_JOURNAL_PATH=/tmp/soul_journal.jsonl,VECTOR_DIM=256,AUTO_REFLECT_EVERY=25"
```

### 4. Get Your Service URL

```bash
gcloud run services describe mnemosyne-team --region ${REGION} --format='value(status.url)'
# Example output: https://mnemosyne-team-abc123-uc.a.run.app
```

---

## Teammate Configuration

Share these instructions with your team:

### For Copilot CLI / Cursor / Windsurf

Add to `.mcp.json` in your project root (or `~/.mcp.json` for global):

```json
{
  "mcpServers": {
    "mnemosyne-team": {
      "type": "http",
      "url": "https://mnemosyne-team-abc123-uc.a.run.app/mcp/v1"
    }
  }
}
```

### For VS Code + Continue

Add to `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "http",
          "url": "https://mnemosyne-team-abc123-uc.a.run.app/mcp/v1"
        }
      }
    ]
  }
}
```

### For Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "mnemosyne-team": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mnemosyne-team-abc123-uc.a.run.app/mcp/v1"]
    }
  }
}
```

---

## Verify It Works

```bash
# Health check
curl https://mnemosyne-team-abc123-uc.a.run.app/health

# Test MCP endpoint
curl -X POST https://mnemosyne-team-abc123-uc.a.run.app/mcp/v1 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

---

## Cost Estimate (Google Cloud Run)

| Component | Monthly Cost (estimate) |
|-----------|------------------------|
| Gateway (min 0, avg 1 instance) | ~$15-30 |
| Qdrant Cloud (free tier) | $0 |
| Upstash Redis (free tier) | $0 |
| **Total** | **~$15-30/month** |

With `min-instances: 0`, you only pay when the service is active.

---

## Adding Authentication (Optional)

For team-only access, enable Cloud Run IAM:

```bash
# Remove public access
gcloud run services remove-iam-policy-binding mnemosyne-team \
  --region ${REGION} \
  --member="allUsers" \
  --role="roles/run.invoker"

# Add team members
gcloud run services add-iam-policy-binding mnemosyne-team \
  --region ${REGION} \
  --member="user:teammate@company.com" \
  --role="roles/run.invoker"
```

Team members then authenticate with:
```bash
gcloud auth print-identity-token
```

And add the token to their MCP config:
```json
{
  "mcpServers": {
    "mnemosyne-team": {
      "type": "http", 
      "url": "https://mnemosyne-team-abc123-uc.a.run.app/mcp/v1",
      "headers": {
        "Authorization": "Bearer $(gcloud auth print-identity-token)"
      }
    }
  }
}
```

---

## Troubleshooting

**Cold starts slow?** Set `min-instances: 1` for always-warm service (~$50/month).

**Memory issues?** Increase to `--memory 4Gi`.

**Check logs:**
```bash
gcloud run logs read mnemosyne-team --region ${REGION} --limit 50
```
