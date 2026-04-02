# Changelog

## [0.3.8] — 2026-04-02

### Fixed
- **Multi-session owner resolution**: Fixed stale model/token display when switching models or sending messages in a second IDE window. Previously, the owner-cache would lock onto a stale LS port and never pick up the higher-progression LS that was actually serving the new message. Now, on every tick the discovery winner (current active LS for this window) is always queried in parallel with the cached port; whichever has the higher `progressionIndex` wins.
- **PPID binding removed**: Removed incorrect PPID-based LS priority. Investigation showed that Language Server processes are forked from `--type=utility` workers (not the Extension Host), so `ls.ppid === process.pid` was always `false`. Discovery now sorts purely by workspace match.
- **Workspace matching log**: Added `logInfo` diagnostic showing the computed `wsId` and each candidate's `workspaceId` with MATCH/no annotation — makes workspace match failures immediately visible in the output channel.

### Changed
- **Owner cache strategy**: Cache entry is now only trusted if the current active LS (`bestGlobalConn`) also returns data for the same cascadeId. If the active LS has a higher `progressionIndex` than the cache, the cache is evicted and the active LS takes over immediately. Falls through to a full LS-scan only when neither the cached port nor the active LS can provide data.

## [0.3.7] — 2026-04-02

### Added
- **Context Limit Overrides**: Fully integrated `contextLimitOverrides` into the snapshots. Overrides correctly match on the internal canonical model key (e.g., `claude-sonnet`) and take precedence over default registry token limits.

## [0.3.6] — 2026-04-02

### Changed
- **Dashboard Initialization & Stability**: Synchronous `WebviewViewProvider` registration immediately satisfies VS Code's activation lifecycle requirements, totally eliminating the 'view is not registered' error.
- **Cache Resilience**: Implemented rigorous re-hydration of serialized cache objects (particularly `resetTime` to `Date` mapping) in `services/quota.ts` preventing latent crashes during UI state restoration.
- **Diagnostics**: Significantly reduced log noise. Routine `ECONNREFUSED` connection probes during token fetching or when polling the active browser conversation are securely suppressed.
- **UI Enhancements**: Updated Sidebar metrics bar colors to better match user preference: Green (new input tokens), Cyan (cached tokens), and Light Purple (output tokens).

## [0.3.4] — 2026-04-02

### Changed
- **Housekeeping**: Removed dead code, unused variables, and stale functions left over from initial iterative development (such as the legacy `findActiveTrajectory` matcher).
- Typescript build strictly passes with no unused locals or parameters.

## [0.3.0] — 2026-04-02

### Changed
- **Context tracking: authoritative LS routing & monotonic fallback**
  - Uses `GetBrowserOpenConversation` to discover the active chat ID correctly instead of relying solely on workspace limits
  - Routes per-conversation RPC calls strictly via the **owner** Language Server processes
  - Employs authoritative `estimatedTokensUsed` calculation provided by the `contextWindowMetadata` 
  - Abandoned the flawed "higher total = fresher" heuristic in favor of a monotonic step-index fallback strategy between `GetCascadeTrajectorySteps` and `GetCascadeTrajectoryGeneratorMetadata`

### Fixed
- Workspace ID encoding in the discovery engine correctly handles explicit `-` symbols.
- Added `LoadTrajectory` fallback for recovering frozen cold conversations prior to querying for tokens.
- Extension no longer attaches to a global LS connection that returns stale context upon Chat switch and UI reload.

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

