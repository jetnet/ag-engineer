# Changelog

## [0.3.0] — 2026-04-02

### Changed
- **Context tracking: multi-source strategy for live token data**
  - Primary source: `GetCascadeTrajectorySteps` → `steps[].metadata.modelUsage`
    (returns a sliding ~1135-step window; last step with modelUsage is freshest)
  - Fallback source: `GetCascadeTrajectoryGeneratorMetadata` → `generatorMetadata[].chatModel.usage`
    (batch-updated, can lag 45+ entries / 50K+ tokens behind)
  - Diagnostic: `GetCascadeTrajectory` → `numTotalSteps`/`numTotalGM` for source comparison
  - Compares totals from both sources, picks the freshest automatically

### Added
- **Multi-LS discovery**: discovers ALL `language_server` processes with `--workspace_id` logging
  - Antigravity spawns one LS per workspace; cascades may live on any LS
  - Logs all LS instances with workspace IDs for diagnostics
  - Prioritizes workspace-matched LS, falls back to first HTTP responder
- Diagnostic log: `Sources: steps=153K GM=101K | totalSteps=2037 totalGM=620`
- `StreamAgentStateUpdates` research findings documented in ARCHITECTURE.md

### Fixed
- **51K+ token accuracy gap**: Steps modelUsage returns 153K while GM was stuck at 101K
  for the same conversation — multi-source strategy eliminates this discrepancy
- Discovery no longer blindly picks the first LS process (previously connected to
  wrong workspace's LS, returning stale data from a different project)

### Discovered (API behavior)
- **Multi-LS**: Each workspace gets its own LS process with independent in-memory trajectory forks
- **Steps modelUsage**: Updates more frequently than GM (per-flush vs batch)
- **`StreamAgentStateUpdates`**: Connect streaming framing works (`application/connect+json` +
  `0x00 + uint32_be(len) + JSON`). Returns 17MB+ initial snapshot with full state.
  No delta frames observed during IDLE status — future work for RUNNING state.
- **`numTotalGM`**: Can exceed returned GM array by 45+ entries (unflushed)

## [0.2.0] — 2026-04-01

### Changed
- **Context tracking: switch to live GeneratorMetadata API**
  - Replaced frozen `GetCascadeTrajectorySteps` (returns stale ~1135-step buffer after checkpoint)
  - Now uses `GetCascadeTrajectoryGeneratorMetadata` — dedicated lightweight endpoint
  - One GM entry per LLM call with live `chatModel.usage` token counts
  - Formula: `inputTokens + cacheReadTokens + outputTokens` = total context usage

### Added
- Rich debug logging for context tracking:
  - Peak context ever seen in session
  - Model distribution across GM entries
  - Last 3 GM entries as trend indicator
  - Selected entry clearly marked with `→ Using`
- Full API reference in ARCHITECTURE.md documenting all LS endpoints and their behavior

### Fixed
- Context window no longer shows stale/frozen values from checkpoint buffer
- Removed unnecessary multi-page pagination loop (API ignores startIndex/endIndex)

### Discovered (API behavior)
- `GetCascadeTrajectorySteps`: ignores pagination params, returns frozen buffer
- `GetCascadeTrajectoryGeneratorMetadata`: returns fresh data, 1 entry ahead of `GetCascadeTrajectory`
- `StreamAgentStateUpdates`: needs Connect streaming framing, not regular JSON POST (future work)

## [0.1.0] — 2026-04-01

### Added
- Language server auto-discovery (Linux, macOS, Windows)
- Connect-RPC client with CSRF authentication
- Quota monitoring service with per-model breakdown
- Context window monitoring (best-effort token extraction)
- Status bar with color-coded thresholds and rich tooltip
- Sidebar WebView dashboard with connection, context, and quota panels
- Non-overlapping poller with exponential backoff
- Configuration: polling interval, quota thresholds, context limit overrides
- Commands: Open Dashboard, Refresh Now, Show Diagnostics, Reset State
- Output channel logging with structured diagnostics
- GlobalState caching for instant UI on restart
