/**
 * Status Bar item — компактное отображение контекста + квоты в футере VS Code.
 *
 * Формат: 🟢 Model | 53K/200K (26%) | Quota: 80%
 * Пороги цветов:
 *   Green  < 60% контекста использовано
 *   Yellow < 80% контекста использовано
 *   Red    ≥ 80% контекста использовано
 *
 * Клик открывает панель дашборда.
 * Тултип показывает полную разбивку.
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
  private lastObservedAiCredits: number | null = null;
  private blinkTimer: any = null;
  private isConsuming: boolean = false;
  private notifiedDepletedModels = new Set<string>();

  constructor() {
    this.item = vscode.window.createStatusBarItem('ag-engineer-status', vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'antigravityEngineer.openDashboard';
    this.item.name = 'AG Engineer';
    // Первый рендер
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
    
    try {
      const gConf = vscode.workspace.getConfiguration('antigravity');
      const dump = JSON.stringify(gConf);
      if (dump.length > 20) {
        require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', `CONFIG DUMP: ${dump}\n`);
      }
    } catch {}

    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    try {
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

    // Чтение настроек отображения
    const { statusBar: sb } = getConfig();

    // Нормальное состояние — белый/дефолтный фон, если не мигает
    if (!this.blinkTimer) {
      this.item.backgroundColor = undefined;
    }
    const parts: string[] = [];

    // Контекстное окно — главная метрика (всегда выводим)
    if (this.lastContext) {
      const ctx = this.lastContext;
      const shortModel = this.shortenModelName(ctx.model || 'Unknown');
      const totalStr = this.formatTokens(ctx.totalTokens || 0);
      const limitStr = this.formatTokens(ctx.contextLimit || 200000);
      const pct = ctx.usedPercentage || 0;
      const pctStr = pct.toFixed(0);
      const squeezeIcon = pct > 90 ? '⚠️' : '';
      const imgIcon = ctx.hasImageGeneration ? ' 📷' : '';
      parts.push(`${squeezeIcon}${shortModel}${imgIcon} ${totalStr}/${limitStr} (${pctStr}%)`);
    }

    // Квоты моделей — жесткий порядок как в настройках Antigravity, без группировки
    if (this.lastQuota && this.lastQuota.models.length > 0) {
      const desiredOrder = [
        'Gemini 3.1 Pro (High)',
        'Gemini 3.1 Pro (Low)',
        'Gemini 3 Flash',
        'Claude Sonnet 4.6 (Thinking)',
        'Claude Opus 4.6 (Thinking)',
        'GPT-OSS 120B (Medium)'
      ];

      const quotaParts: string[] = [];
      const modelMap = new Map();
      
      // Индексируем модели
      for (const m of this.lastQuota.models) {
        modelMap.set(m.label, m.remainingPercentage);
      }

      // Достаем в нужном порядке
      for (const label of desiredOrder) {
        if (modelMap.has(label)) {
          const pct = modelMap.get(label);
          const dot = pct <= 0 ? '🔴' : pct <= 30 ? '🟡' : '🟢';
          let short = this.shortenModelName(label);
          if (label.includes('Pro (High)')) short = 'Pro(H)';
          if (label.includes('Pro (Low)')) short = 'Pro(L)';
          quotaParts.push(`${dot}${short} ${Math.round(pct)}%`);
        }
      }

      // Добиваем остальные, если они есть
      for (const [label, pct] of modelMap) {
        if (!desiredOrder.includes(label)) {
          const dot = pct <= 0 ? '🔴' : pct <= 30 ? '🟡' : '🟢';
          quotaParts.push(`${dot}${this.shortenModelName(label)} ${Math.round(pct)}%`);
        }
      }

      // Check for depleted models to warn once
      for (const [label, pct] of modelMap) {
        if (pct <= 0 && !this.notifiedDepletedModels.has(label)) {
          vscode.window.showWarningMessage(`Antigravity: Квота модели ${label} исчерпана (0%). Пожалуйста, подождите сброса.`);
          this.notifiedDepletedModels.add(label);
        } else if (pct > 0 && this.notifiedDepletedModels.has(label)) {
          this.notifiedDepletedModels.delete(label); // Reset tracking when it refills
        }
      }

      if (quotaParts.length > 0) {
        parts.push(quotaParts.join(' | '));
      }
    }

    // AI Credits
    if (sb.showCredits && this.lastQuota?.userInfo?.totalAiCredits != null) {
      const currentCredits = this.lastQuota.userInfo.totalAiCredits;
      if (this.lastObservedAiCredits !== null && currentCredits < this.lastObservedAiCredits) {
        this.triggerBlink();
      }
      this.lastObservedAiCredits = currentCredits;

      const prefix = this.isConsuming ? '🔥' : '💎';
      parts.push(`${prefix} ${currentCredits.toLocaleString()}`);
    }

    if (parts.length > 0) {
      this.item.text = `$(pulse) ${parts.join(' | ')}`;
      this.item.show();
      try {
        require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', `RENDERED: ${this.item.text}\n`);
      } catch {}
    } else {
      this.item.text = '$(pulse) AG';
      this.item.show();
    }
    this.item.tooltip = this.buildTooltip();
    } catch (e) {
      require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', `STATUSBAR ERROR: ${e instanceof Error ? e.stack : String(e)}\n`);
    }
  }

  private triggerBlink(): void {
    // Blinker disabled to prevent status bar remaining red continuously
    this.isConsuming = true;
    setTimeout(() => {
      this.isConsuming = false;
      this.render();
    }, 1000);
  }

  private buildTooltip(): string {
    const lines: string[] = ['AG Engineer Dashboard (click to open)', ''];

    if (this.lastContext) {
      const c = this.lastContext;
      const est = c.isEstimated ? ' (estimated)' : '';
      const rawInput = c.inputTokens - (c.cacheReadTokens || 0);
      lines.push(`📊 Context${est}`);
      lines.push(`  Model: ${c.model}`);
      lines.push(`  Input tokens: ${rawInput.toLocaleString()}`);
      lines.push(`  Cache tokens: ${(c.cacheReadTokens || 0).toLocaleString()}`);
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
      if (this.lastQuota.userInfo?.totalAiCredits != null) {
        lines.push(`  💎 AI Credits: ${this.lastQuota.userInfo.totalAiCredits.toLocaleString()}`);
      }
      if (this.lastQuota.userInfo?.planName) {
        lines.push(`  Plan: ${this.lastQuota.userInfo.planName}`);
      }
      lines.push('');
    }

    lines.push(`🔌 ${this.diagnosticInfo.connectionStatus}`);
    if (this.diagnosticInfo.lastSuccessfulPoll) {
      lines.push(`  Last update: ${this.diagnosticInfo.lastSuccessfulPoll.toLocaleTimeString()}`);
    }

    return lines.join('\n');
  }

  private shortenModelName(name: string): string {
    // Проверяем по подстрокам — от длинных к коротким, чтобы избежать ложных совпадений
    const lower = name.toLowerCase();
    if (lower.includes('opus'))   return 'Opus';
    if (lower.includes('sonnet')) return 'Sonnet';
    if (lower.includes('haiku'))  return 'Haiku';
    if (lower.includes('flash'))  return 'Flash';
    if (lower.includes('ultra'))  return 'Ultra';
    if (lower.includes('3.1 pro') || lower.includes('3.1pro')) return 'Pro 3.1';
    if (lower.includes('3 pro') || lower.includes('3pro'))    return 'Pro 3';
    if (lower.includes('pro'))    return 'Pro';
    if (lower.includes('gemini')) return 'Gemini';
    if (lower.includes('gpt-oss') || lower.includes('gpt oss')) return 'GPT‑OSS';
    if (lower.includes('gpt'))    return 'GPT';
    if (lower.includes('claude')) return 'Claude';
    // Fallback — обрезаем
    return name.length > 10 ? name.substring(0, 10) + '…' : name;
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }
}
