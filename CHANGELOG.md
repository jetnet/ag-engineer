# Changelog

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
