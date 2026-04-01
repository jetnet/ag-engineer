/**
 * Status Bar item — compact display of context + quota in the VS Code footer.
 *
 * Format: 🟢 Model | 53K/200K (26%) | Quota: 80%
 * Color thresholds:
 *   Green  < 60% context used
 *   Yellow < 80% context used
 *   Red    ≥ 80% context used
 *
 * Click opens the sidebar dashboard.
 * Tooltip shows full breakdown.
 */
import * as vscode from 'vscode';
import type { QuotaSnapshot, ContextSnapshot, DiagnosticInfo } from '../types';
import { getConfig } from '../config/settings';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private lastQuota: QuotaSnapshot | null = null;
  private lastContext: ContextSnapshot | null = null;
  private diagnosticInfo: DiagnosticInfo = {
    connectionStatus: 'disconnected',
    pollCount: 0,
    failCount: 0,
  };

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'antigravityEngineer.openDashboard';
    this.item.name = 'AG Engineer';
    this.render();
    this.item.show();
  }

  updateQuota(snapshot: QuotaSnapshot): void {
    this.lastQuota = snapshot;
    this.render();
  }

  updateContext(snapshot: ContextSnapshot): void {
    this.lastContext = snapshot;
    this.render();
  }

  updateDiagnostics(info: DiagnosticInfo): void {
    this.diagnosticInfo = info;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    if (this.diagnosticInfo.connectionStatus === 'disconnected') {
      this.item.text = '$(plug) AG: Disconnected';
      this.item.tooltip = 'Click to open dashboard. Language server not found.';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    if (this.diagnosticInfo.connectionStatus === 'connecting') {
      this.item.text = '$(loading~spin) AG: Connecting...';
      this.item.tooltip = 'Discovering language server...';
      this.item.backgroundColor = undefined;
      return;
    }

    // Read display settings
    const { statusBar: sb } = getConfig();

    // Normal state — always white/default background
    this.item.backgroundColor = undefined;
    const parts: string[] = [];

    // Context window — the most important metric
    if (sb.showContextWindow && this.lastContext && this.lastContext.totalTokens > 0) {
      const ctx = this.lastContext;
      const shortModel = this.shortenModelName(ctx.model || 'Unknown');
      const totalStr = this.formatTokens(ctx.totalTokens);
      const limitStr = this.formatTokens(ctx.contextLimit);
      const pctStr = ctx.usedPercentage.toFixed(0);
      parts.push(`${shortModel} ${totalStr}/${limitStr} (${pctStr}%)`);
    }

    // Model quotas — filtered by settings
    if (this.lastQuota && this.lastQuota.models.length > 0) {
      const filter = sb.models.map((m) => m.toLowerCase());
      const groups = new Map<string, { pct: number }>();
      for (const m of this.lastQuota.models) {
        const short = this.shortenModelName(m.label);
        // Skip if filter is set and this model isn't in it
        if (filter.length > 0 && !filter.includes(short.toLowerCase())) continue;

        const existing = groups.get(short);
        if (existing) {
          existing.pct = Math.min(existing.pct, m.remainingPercentage);
        } else {
          groups.set(short, { pct: m.remainingPercentage });
        }
      }

      const quotaParts: string[] = [];
      for (const [name, { pct }] of groups) {
        const dot = pct <= 0 ? '🔴' : pct <= 30 ? '🟡' : '🟢';
        quotaParts.push(`${dot}${name} ${Math.round(pct)}%`);
      }
      if (quotaParts.length > 0) {
        parts.push(quotaParts.join(' '));
      }
    }

    // AI Credits
    if (sb.showCredits && this.lastQuota?.userInfo?.totalAiCredits != null) {
      parts.push(`💎${this.formatTokens(this.lastQuota.userInfo.totalAiCredits)}`);
    }

    this.item.text = parts.length > 0
      ? `$(pulse) ${parts.join(' | ')}`
      : '$(pulse) AG';
    this.item.tooltip = this.buildTooltip();
  }

  private buildTooltip(): string {
    const lines: string[] = ['AG Engineer Dashboard (click to open)', ''];

    if (this.lastContext) {
      const c = this.lastContext;
      const est = c.isEstimated ? ' (estimated)' : '';
      lines.push(`📊 Context${est}`);
      lines.push(`  Model: ${c.model}`);
      lines.push(`  Input tokens: ${c.inputTokens.toLocaleString()}`);
      lines.push(`  Output tokens: ${c.outputTokens.toLocaleString()}`);
      lines.push(`  Total: ${c.totalTokens.toLocaleString()} / ${c.contextLimit.toLocaleString()}`);
      lines.push(`  Used: ${c.usedPercentage.toFixed(1)}%`);
      lines.push(`  Remaining: ${c.remainingTokens.toLocaleString()}`);
      lines.push('');
    }

    if (this.lastQuota) {
      lines.push('📈 Model Quotas');
      for (const m of this.lastQuota.models) {
        const icon = m.isCritical ? '🔴' : m.isLow ? '🟡' : '🟢';
        lines.push(`  ${icon} ${m.label}: ${m.remainingPercentage.toFixed(0)}% (reset: ${m.timeUntilReset})`);
      }

      if (this.lastQuota.tokenUsage?.promptCredits) {
        const pc = this.lastQuota.tokenUsage.promptCredits;
        lines.push(`  Prompt Credits: ${pc.available} / ${pc.monthly}`);
      }
      if (this.lastQuota.tokenUsage?.flowCredits) {
        const fc = this.lastQuota.tokenUsage.flowCredits;
        lines.push(`  Flow Credits: ${fc.available} / ${fc.monthly}`);
      }
      lines.push('');
    }

    lines.push(`🔌 ${this.diagnosticInfo.connectionStatus}`);
    if (this.diagnosticInfo.lastSuccessfulPoll) {
      lines.push(`  Last update: ${this.diagnosticInfo.lastSuccessfulPoll.toLocaleTimeString()}`);
    }

    return lines.join('\n');
  }

  private getHealthIcon(): string {
    if (this.diagnosticInfo.connectionStatus !== 'connected') return '$(plug)';
    if (this.lastContext?.usedPercentage && this.lastContext.usedPercentage >= 80) return '$(warning)';
    if (this.lastQuota?.models.some((m) => m.isCritical)) return '$(warning)';
    return '$(pulse)';
  }

  private shortenModelName(name: string): string {
    const map: Record<string, string> = {
      'claude opus': 'Opus',
      'claude sonnet': 'Sonnet',
      'gemini 3.1 pro': 'Pro',
      'gemini pro': 'Pro',
      'gemini 3 flash': 'Flash',
      'gemini flash': 'Flash',
      'gpt-oss': 'GPT',
      'gpt': 'GPT',
    };
    const lower = name.toLowerCase();
    for (const [key, short] of Object.entries(map)) {
      if (lower.includes(key)) return short;
    }
    // Truncate to 10 chars
    return name.length > 10 ? name.substring(0, 10) + '…' : name;
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }
}
