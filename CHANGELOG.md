# Changelog

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
