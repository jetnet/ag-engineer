# Antigravity Engineer — Architecture

## Overview

VS Code extension for Google Antigravity IDE that provides real-time monitoring of context window usage, model quotas, and token consumption by reverse-engineering the internal language server RPC API.

## Architecture Diagram

```mermaid
graph TB
    subgraph Extension Host
        EXT[extension.ts<br/>Activation & Wiring]
        POLL[Poller<br/>setTimeout chain]
        DISC[Discovery<br/>Multi-LS Scanner]
        RPC[RPC Client<br/>HTTP POST]
        QS[Quota Service<br/>GetUserStatus]
        CS[Context Service<br/>Multi-Source Token Tracking]
        MR[Model Registry<br/>Cockpit Cache JSON]
        SB[Status Bar<br/>Compact Metrics]
        SIDE[Sidebar WebView<br/>Dashboard]
        CFG[Config / Settings]
    end

    subgraph "Antigravity Language Servers (1 per workspace)"
        LS1["LS₁ 127.0.0.1:PORT₁<br/>workspace: project-A"]
        LS2["LS₂ 127.0.0.1:PORT₂<br/>workspace: project-B"]
    end

    subgraph OS / Filesystem
        PS["Process Table<br/>(ps / ss)"]
        CACHE["~/.antigravity_cockpit/cache<br/>quota_api_v1_plugin/*.json"]
    end

    EXT --> POLL
    EXT --> DISC
    EXT --> MR
    EXT --> SB
    EXT --> SIDE

    DISC -->|"scan ps for --csrf_token<br/>+ --workspace_id"| PS
    DISC -->|"probe ports via ss"| PS
    DISC -->|ServerConnection| RPC

    POLL -->|tick every N sec| QS
    POLL -->|tick every N sec| CS

    QS -->|"POST GetUserStatus"| RPC
    CS -->|"POST GetCascadeTrajectorySteps<br/>POST GetCascadeTrajectoryGeneratorMetadata<br/>POST GetCascadeTrajectory"| RPC
    RPC -->|"HTTP + CSRF header"| LS1
    RPC -->|"HTTP + CSRF header"| LS2
    MR -->|"watch & parse JSON"| CACHE

    QS -->|QuotaSnapshot| SB
    QS -->|QuotaSnapshot| SIDE
    CS -->|ContextSnapshot| SB
    CS -->|ContextSnapshot| SIDE
    MR -->|model limits| CS

    CFG -->|display toggles| SB
```

## Data Flow — Token Tracking

```mermaid
flowchart TD
    subgraph "Multi-Source Strategy (freshness order)"
        S1["① GetCascadeTrajectorySteps<br/>→ steps[].metadata.modelUsage<br/>🟢 FRESHEST (per-flush)"]
        S2["② GetCascadeTrajectoryGeneratorMetadata<br/>→ generatorMetadata[].chatModel.usage<br/>🟡 BATCH (lags 45+ entries)"]
        S3["③ GetCascadeTrajectory<br/>→ numTotalSteps, numTotalGM<br/>🔵 METADATA only"]
    end

    S1 --> CMP{Compare totals}
    S2 --> CMP
    S3 -->|diagnostic| LOG[Debug Log]
    CMP -->|"Pick higher total<br/>(= more recent)"| RESULT[StepTokenInfo]
    RESULT --> SNAP[ContextSnapshot]

    subgraph UI
        SNAP --> SB[Status Bar]
        SNAP --> SIDE[Sidebar]
    end
```

### Multi-LS Architecture

Antigravity spawns **one Language Server per workspace**. Each LS has its own:
- PID, CSRF token, workspace_id
- HTTP port (JSON-RPC), HTTPS port (gRPC), extension port
- In-memory trajectory fork after `LoadTrajectory`

**Critical**: A cascade/conversation may be loaded on ANY LS — not necessarily the one matching the current VS Code workspace. Per-conversation reads must be routed through the LS that owns the data, which may differ from the workspace-matched LS.

Discovery logs all LS instances with workspace IDs for diagnostics:
```
Found 2 LS instance(s) [current workspace: /home/user/project-A]
  LS PID=12345 workspace_id=file_home_user_project_B csrf=e4b06aaa…
  LS PID=67890 workspace_id=file_home_user_project_A csrf=b982aa40…
```

### LS RPC Endpoints — API Reference

| Endpoint | Purpose | Status | Freshness |
|---|---|---|---|
| `GetUserStatus` | Plan, quotas, model configs | ✅ Live, primary | Real-time |
| `GetAllCascadeTrajectories` | Discover cascadeId by workspace | ✅ Live (may return empty) | Real-time |
| `GetCascadeTrajectorySteps` | Step buffer (~1135 sliding window) | ✅ **Primary token source** | Per-flush (freshest) |
| `GetCascadeTrajectoryGeneratorMetadata` | GM array — one per LLM call | ✅ **Fallback token source** | Batch (lags 45+ entries) |
| `GetCascadeTrajectory` | Trajectory summary + `numTotalSteps`/`numTotalGM` | ✅ Diagnostics | Per-flush |
| `GetUserTrajectoryDescriptions` | List of trajectory IDs per workspace | ✅ Live, discovery only | Real-time |
| `StreamAgentStateUpdates` | Real-time push of full state | ⚠️ Works (initial snapshot only) | Real-time during RUNNING |
| `GetBrowserOpenConversation` | Currently open conversation | ⚠️ Only if browser panel open | Real-time |

### Token Data Sources

#### Source 1: Steps `modelUsage` (Primary)

`GetCascadeTrajectorySteps` returns a sliding window of ~1135 steps. Each step with `metadata.modelUsage` contains:

| Field | Type | Description |
|---|---|---|
| `inputTokens` | string | Uncached prompt tokens |
| `cacheReadTokens` | string | Cached prompt tokens (Anthropic prompt cache) |
| `outputTokens` | string | Model output tokens |
| `model` | string | Internal model ID |
| `apiProvider` | string | Provider (e.g. `API_PROVIDER_ANTHROPIC_VERTEX`) |

Walking backwards from the last step gives the **freshest available token counts**.

#### Source 2: GeneratorMetadata (Fallback)

`GetCascadeTrajectoryGeneratorMetadata` returns the full `generatorMetadata[]` array. Each entry has `chatModel.usage` with the same fields. Updates in **batches** — can lag behind Steps by 45+ entries and 50K+ tokens.

#### Token Formula

**Context window usage** = `inputTokens + cacheReadTokens + outputTokens`

> `inputTokens` is the *uncached* portion; `cacheReadTokens` is the *cached* portion.
> Together they represent the full input sent to the model. Both occupy context window space.

### API Behavior Notes

- **`GetCascadeTrajectorySteps`**: Returns a ~1135-step sliding window. Ignores `startIndex`/`endIndex` params — always returns the same window centered around the latest checkpoint. The LAST step with `modelUsage` is the freshest token data.
- **`GetCascadeTrajectoryGeneratorMetadata`**: Returns the full `generatorMetadata[]` array directly. Batch-updated: `numTotalGM` (from trajectory) can exceed the returned array size by 45+ entries. No pagination params.
- **`GetCascadeTrajectory`**: Returns `numTotalSteps` and `numTotalGeneratorMetadata` for diagnostic comparison. GM entries nested inside `trajectory.generatorMetadata[]` — often less fresh than the dedicated GM endpoint.
- **`StreamAgentStateUpdates`**: Requires Connect streaming framing:
  - `Content-Type: application/connect+json`
  - Binary envelope: `0x00 + uint32_be(length) + JSON_payload`
  - Returns full state snapshot (17MB+) as first frame
  - Accepts `{conversationId}` (same as cascadeId)
  - `transfer-encoding: chunked` — long-lived connection
  - During IDLE: sends initial snapshot only, no further deltas observed
  - During RUNNING: likely sends delta frames (not yet confirmed)
  - Future work: implement as primary real-time source

## Module Responsibilities

### Discovery (`platform/discovery.ts`)
- Scans OS processes for ALL `language_server` instances via `ps aux`
- Extracts `--csrf_token` and `--workspace_id` from each process
- Logs all LS instances with workspace IDs for diagnostics
- Prioritizes workspace-matched LS, falls back to first responder
- Discovers listening ports via `ss -tlnp` (Linux) matched by PID
- Probes each port with HTTP POST to `GetUserStatus` to find the JSON-RPC port
- Filters out gRPC/HTTPS ports (only HTTP works without cert conflicts)
- Extracts `ServerConnection { host, port, csrfToken, pid }`

### RPC Client (`platform/rpc-client.ts`)
- JSON-over-HTTP POST to `exa.language_server_pb.LanguageServerService/*`
- CSRF token authentication via `X-Codeium-Csrf-Token` header
- HTTP only (avoiding HTTPS to prevent conflicts with IDE's internal gRPC)

### Poller (`services/poller.ts`)
- Non-overlapping setTimeout chain (not setInterval)
- Exponential backoff on failure (capped at 2 min)
- Immediate recovery to base interval on success
- AbortController for clean shutdown

### Quota Service (`services/quota.ts`)
- Parses `GetUserStatus` → `cascadeModelConfigData` for per-model quotas
- `remainingFraction` is 0.0–1.0 float (missing = 0% = depleted)
- Extracts `userTier.name` for plan name (e.g. "Google AI Ultra")
- Extracts `userTier.availableCredits` for total AI credits
- Normalizes prompt/flow credits with percentage calculations
- Alphabetically sorted model list for stable UI

### Context Service (`services/context.ts`)
- **Step 1**: `GetAllCascadeTrajectories` → find conversation matching current workspace URIs
- **Step 2**: Multi-source token fetch:
  - Source 1: `GetCascadeTrajectorySteps` → last step with `metadata.modelUsage`
  - Source 2: `GetCascadeTrajectoryGeneratorMetadata` → last GM entry with token data
  - Source 3: `GetCascadeTrajectory` → `numTotalSteps`/`numTotalGM` for diagnostics
- **Step 3**: Compare source totals, pick the **freshest** (highest total = most recent context)
- **Step 4**: Extract `inputTokens + cacheReadTokens + outputTokens` = context window usage
- Model detection via `apiProvider` → display name mapping
- Context limits from Model Registry (`maxTokens` per model)
- **No estimation fallback** — only shows real data, empty if no conversation exists for workspace

### Model Registry (`services/model-registry.ts`)
- Reads `~/.antigravity_cockpit/cache/quota_api_v1_plugin/authorized/*.json`
- Parses chat model metadata: `displayName`, `maxTokens`, `modelId`
- FSWatcher for live updates when cache files change
- Provides `getChatModels()` to Context Service for limit resolution

### Status Bar (`ui/statusbar.ts`)
- Format: `$(pulse) Opus 133K/200K (67%) | 🟢Flash 100% 🔴Opus 0% | 💎10K`
- Configurable sections via settings:
  - `statusBar.showContextWindow` — toggle context display
  - `statusBar.models` — filter which models show quota dots (empty = all)
  - `statusBar.showCredits` — toggle credits display
- Model grouping: deduplicates variants (e.g. Gemini Pro High/Low → "Pro")
- Short names: Opus, Sonnet, Pro, Flash, GPT
- Rich tooltip with full breakdown
- Click → opens sidebar dashboard

### Sidebar (`ui/sidebar/provider.ts`)
- WebView with CSP + nonce security
- Native VS Code theme variable integration (`--vscode-*`)
- Sections: Connection, Context Window (with progress bar), Model Quotas, Credits
- PostMessage bridge for state updates
- Refresh and Show Logs buttons

## Configuration

```mermaid
graph LR
    subgraph "Settings (antigravityEngineer.*)"
        A[pollingInterval: 30s]
        B[lowQuotaThreshold: 30%]
        C[criticalQuotaThreshold: 10%]
        D[contextLimitOverrides: object]
        E[serverHost: 127.0.0.1]
        F[debugMode: false]
        G["statusBar.showContextWindow: true"]
        H["statusBar.models: string[]"]
        I["statusBar.showCredits: true"]
    end
```

## Security Model

- All traffic is local (`127.0.0.1` only)
- CSRF token from process arguments (never stored externally)
- WebView uses Content Security Policy with nonce
- No external network calls
- No telemetry or analytics
- Token values redacted in diagnostic logs

## Known Limitations

1. **Batch-updated data**: Both Steps and GM sources update in batches (not per-turn). Token counts may lag a few turns behind the actual context window state.
2. **No per-turn push**: `StreamAgentStateUpdates` only sends an initial snapshot during IDLE. Delta frames during RUNNING are not yet confirmed/implemented.
3. **Multi-LS routing**: A cascade may be loaded on a different LS than the workspace-matched one. Current discovery probes all LS instances but doesn't guarantee routing to the cascade owner.
4. **Sliding window**: Steps API returns ~1135 steps. For very long conversations, older steps fall out of the window.
