/**
 * Sidebar WebView Provider — renders the AG Engineer dashboard.
 * Uses VS Code's WebviewView API with CSP + nonce security.
 * Receives state updates via postMessage.
 */
import * as vscode from 'vscode';
import type { QuotaSnapshot, ContextSnapshot, DiagnosticInfo } from '../../types';
import type { ModelRegistrySnapshot } from '../../services/model-registry';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravityEngineer.dashboard';
  private view?: vscode.WebviewView;
  private lastQuota: QuotaSnapshot | null = null;
  private lastContext: ContextSnapshot | null = null;
  private lastDiagnostics: DiagnosticInfo | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'refresh':
          vscode.commands.executeCommand('antigravityEngineer.refreshNow');
          break;
        case 'showLogs':
          vscode.commands.executeCommand('antigravityEngineer.showDiagnostics');
          break;
      }
    });

    // Push current state if we have it
    this.pushAllState();
  }

  updateQuota(snapshot: QuotaSnapshot): void {
    this.lastQuota = snapshot;
    this.postMessage({ type: 'quota', data: this.serializeQuota(snapshot) });
  }

  updateContext(snapshot: ContextSnapshot): void {
    this.lastContext = snapshot;
    this.postMessage({ type: 'context', data: snapshot });
  }

  updateDiagnostics(info: DiagnosticInfo): void {
    this.lastDiagnostics = info;
    this.postMessage({ type: 'diagnostics', data: info });
  }

  updateModelRegistry(snapshot: ModelRegistrySnapshot): void {
    const models = [...snapshot.models.values()]
      .filter((m) => m.maxTokens > 50_000 && !m.id.startsWith('tab_') && !m.id.startsWith('chat_'))
      .map((m) => ({
        id: m.id,
        displayName: m.displayName,
        maxTokens: m.maxTokens,
        maxOutputTokens: m.maxOutputTokens,
        modelProvider: m.modelProvider,
      }));
    this.postMessage({ type: 'modelRegistry', data: { models, email: snapshot.email } });
  }

  private pushAllState(): void {
    if (this.lastQuota) this.updateQuota(this.lastQuota);
    if (this.lastContext) this.updateContext(this.lastContext);
    if (this.lastDiagnostics) this.updateDiagnostics(this.lastDiagnostics);
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private serializeQuota(snapshot: QuotaSnapshot): unknown {
    return {
      ...snapshot,
      timestamp: snapshot.timestamp.toISOString(),
      models: snapshot.models.map((m) => ({
        ...m,
        resetTime: m.resetTime?.toISOString() || null,
      })),
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>AG Engineer</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --error: var(--vscode-errorForeground, #f44);
      --warning: var(--vscode-editorWarning-foreground, #fa0);
      --success: #4caf50;
      --clr-input: #4caf50;
      --clr-cache: #00bcd4;
      --clr-output: #d0b3ff;
      --clr-remaining: rgba(255,255,255,0.08);
      --input-bg: var(--vscode-input-background);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      padding: 12px;
      line-height: 1.5;
    }
    h2 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      color: var(--fg);
      opacity: 0.8;
      border-bottom: 1px solid var(--border);
      padding-bottom: 4px;
    }
    .card {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
    }
    .label { opacity: 0.7; font-size: 12px; }
    .value { font-weight: 600; font-size: 12px; }
    .estimated { font-style: italic; opacity: 0.6; }
    .estimated::after { content: ' ~'; font-size: 10px; }

    /* Stacked progress bar */
    .progress-container {
      width: 100%;
      height: 10px;
      background: var(--clr-remaining);
      border-radius: 5px;
      overflow: hidden;
      margin: 8px 0;
      display: flex;
    }
    .seg {
      height: 100%;
      transition: width 0.5s ease;
      min-width: 0;
    }
    .seg-input { background: var(--clr-input); }
    .seg-cache { background: var(--clr-cache); }
    .seg-output { background: var(--clr-output); border-radius: 0 5px 5px 0; }
    .seg-input:first-child { border-radius: 5px 0 0 5px; }

    /* Color legend dot */
    .legend-dot {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-right: 5px;
      vertical-align: middle;
    }

    /* Model quota list */
    .model-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      font-size: 12px;
    }
    .model-row .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .model-row .name { flex: 1; }
    .model-row .pct { width: 40px; text-align: right; font-weight: 600; }
    .model-row .reset { opacity: 0.5; font-size: 11px; }

    /* Status badge */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-ok { background: var(--success); color: #fff; }
    .badge-warn { background: var(--warning); color: #000; }
    .badge-err { background: var(--error); color: #fff; }
    .badge-off { background: var(--border); color: var(--fg); }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border: none;
      border-radius: 4px;
      background: var(--button-bg);
      color: var(--button-fg);
      font-size: 12px;
      cursor: pointer;
      margin-right: 6px;
      margin-top: 6px;
    }
    .btn:hover { background: var(--button-hover); }

    .empty-state {
      text-align: center;
      padding: 20px;
      opacity: 0.5;
      font-size: 12px;
    }

    .section { margin-bottom: 16px; }
  </style>
</head>
<body>
  <!-- CONNECTION STATUS -->
  <div class="section">
    <h2>Connection</h2>
    <div class="card" id="connection-card">
      <div class="row">
        <span class="label">Status</span>
        <span id="conn-status" class="badge badge-off">Initializing</span>
      </div>
      <div class="row" id="conn-port-row" style="display:none">
        <span class="label">Port</span>
        <span id="conn-port" class="value">—</span>
      </div>
      <div class="row" id="conn-pid-row" style="display:none">
        <span class="label">LS PID</span>
        <span id="conn-pid" class="value">—</span>
      </div>
      <div class="row" id="conn-update-row" style="display:none">
        <span class="label">Last update</span>
        <span id="conn-update" class="value">—</span>
      </div>
    </div>
  </div>

  <!-- CONTEXT WINDOW -->
  <div class="section">
    <h2>Context Window</h2>
    <div class="card" id="context-card">
      <div id="context-empty" class="empty-state">Awaiting data...</div>
      <div id="context-data" style="display:none">
        <div class="row">
          <span class="label">Model</span>
          <span id="ctx-model" class="value">—</span>
        </div>
        <div class="progress-container">
          <div id="seg-input" class="seg seg-input" style="width:0%"></div>
          <div id="seg-cache" class="seg seg-cache" style="width:0%"></div>
          <div id="seg-output" class="seg seg-output" style="width:0%"></div>
        </div>
        <div class="row">
          <span id="ctx-used" class="value">0</span>
          <span id="ctx-limit" class="label">/ 0</span>
        </div>
        <div class="row">
          <span class="label"><span class="legend-dot" style="background:var(--clr-input)"></span>Input</span>
          <span id="ctx-input" class="value">—</span>
        </div>
        <div class="row">
          <span class="label"><span class="legend-dot" style="background:var(--clr-cache)"></span>Cache</span>
          <span id="ctx-cache" class="value">—</span>
        </div>
        <div class="row">
          <span class="label"><span class="legend-dot" style="background:var(--clr-output)"></span>Output</span>
          <span id="ctx-output" class="value">—</span>
        </div>
        <div class="row">
          <span class="label">Remaining</span>
          <span id="ctx-remaining" class="value">—</span>
        </div>
        <div class="row">
          <span class="label">Used</span>
          <span id="ctx-pct" class="value">—</span>
        </div>
      </div>
    </div>
  </div>

  <!-- MODEL QUOTAS -->
  <div class="section">
    <h2>Model Quotas</h2>
    <div class="card" id="quota-card">
      <div id="quota-empty" class="empty-state">Awaiting data...</div>
      <div id="quota-list"></div>
      <div id="credits-section" style="display:none; margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px;">
        <div class="row">
          <span class="label">Plan</span>
          <span id="plan-name" class="value">—</span>
        </div>
        <div class="row" id="ai-credits-row" style="display:none">
          <span class="label">AI Credits</span>
          <span id="ai-credits" class="value">—</span>
        </div>
        <div class="row">
          <span class="label">Prompt Credits</span>
          <span id="prompt-credits" class="value">—</span>
        </div>
        <div class="row">
          <span class="label">Flow Credits</span>
          <span id="flow-credits" class="value">—</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ACTIONS -->
  <div class="section">
    <button class="btn" id="btn-refresh">↻ Refresh</button>
    <button class="btn" id="btn-logs">📋 Show Logs</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
    document.getElementById('btn-logs').addEventListener('click', () => {
      vscode.postMessage({ command: 'showLogs' });
    });

    function fmt(n) {
      if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
      if (n >= 1e3) return (n/1e3).toFixed(0) + 'K';
      return String(n);
    }

    function progressClass(pct) {
      if (pct >= 80) return 'progress-crit';
      if (pct >= 60) return 'progress-warn';
      return 'progress-ok';
    }

    function dotColor(remaining) {
      if (remaining <= 10) return 'var(--error)';
      if (remaining <= 30) return 'var(--warning)';
      return 'var(--success)';
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'context': renderContext(msg.data); break;
        case 'quota': renderQuota(msg.data); break;
        case 'diagnostics': renderDiagnostics(msg.data); break;
      }
    });

    function renderContext(ctx) {
      document.getElementById('context-empty').style.display = 'none';
      document.getElementById('context-data').style.display = 'block';

      const est = ctx.isEstimated ? ' ~' : '';
      document.getElementById('ctx-model').textContent = ctx.model;
      document.getElementById('ctx-model').className = ctx.isEstimated ? 'value estimated' : 'value';
      document.getElementById('ctx-used').textContent = fmt(ctx.totalTokens) + est;
      document.getElementById('ctx-limit').textContent = '/ ' + fmt(ctx.contextLimit);

      // Separate input into raw input and cache
      const rawInput = ctx.inputTokens - (ctx.cacheReadTokens || 0);
      const cache = ctx.cacheReadTokens || 0;
      document.getElementById('ctx-input').textContent = fmt(rawInput) + est;
      document.getElementById('ctx-cache').textContent = fmt(cache) + est;
      document.getElementById('ctx-output').textContent = fmt(ctx.outputTokens) + est;
      document.getElementById('ctx-remaining').textContent = fmt(ctx.remainingTokens);
      document.getElementById('ctx-pct').textContent = ctx.usedPercentage.toFixed(1) + '%';

      // Stacked bar segments as % of contextLimit
      const limit = ctx.contextLimit || 1;
      const inputPct = (rawInput / limit) * 100;
      const cachePct = (cache / limit) * 100;
      const outputPct = (ctx.outputTokens / limit) * 100;
      document.getElementById('seg-input').style.width = Math.min(inputPct, 100) + '%';
      document.getElementById('seg-cache').style.width = Math.min(cachePct, 100) + '%';
      document.getElementById('seg-output').style.width = Math.min(outputPct, 100) + '%';
    }

    function renderQuota(snapshot) {
      document.getElementById('quota-empty').style.display = 'none';
      const list = document.getElementById('quota-list');
      list.innerHTML = '';

      for (const m of snapshot.models) {
        const row = document.createElement('div');
        row.className = 'model-row';
        row.innerHTML =
          '<div class="dot" style="background:' + dotColor(m.remainingPercentage) + '"></div>' +
          '<span class="name">' + esc(m.label) + '</span>' +
          '<span class="pct">' + m.remainingPercentage.toFixed(0) + '%</span>' +
          '<span class="reset">' + esc(m.timeUntilReset) + '</span>';
        list.appendChild(row);
      }

      if (snapshot.tokenUsage) {
        document.getElementById('credits-section').style.display = 'block';
        const tu = snapshot.tokenUsage;
        document.getElementById('prompt-credits').textContent =
          tu.promptCredits ? fmt(tu.promptCredits.available) + ' / ' + fmt(tu.promptCredits.monthly) : 'N/A';
        document.getElementById('flow-credits').textContent =
          tu.flowCredits ? fmt(tu.flowCredits.available) + ' / ' + fmt(tu.flowCredits.monthly) : 'N/A';
      }

      if (snapshot.userInfo) {
        document.getElementById('credits-section').style.display = 'block';
        document.getElementById('plan-name').textContent = snapshot.userInfo.planName || 'N/A';
        if (snapshot.userInfo.totalAiCredits != null) {
          document.getElementById('ai-credits-row').style.display = 'flex';
          document.getElementById('ai-credits').textContent = fmt(snapshot.userInfo.totalAiCredits);
        }
      }
    }

    function renderDiagnostics(info) {
      const el = document.getElementById('conn-status');
      el.textContent = info.connectionStatus;
      el.className = 'badge ' + ({
        connected: 'badge-ok',
        connecting: 'badge-warn',
        disconnected: 'badge-off',
        error: 'badge-err'
      }[info.connectionStatus] || 'badge-off');

      if (info.connectionStatus === 'connected') {
        show('conn-port-row'); show('conn-pid-row'); show('conn-update-row');
        document.getElementById('conn-port').textContent = info.discoveredPort || '—';
        document.getElementById('conn-pid').textContent = info.discoveredPid || '—';
        document.getElementById('conn-update').textContent =
          info.lastSuccessfulPoll ? new Date(info.lastSuccessfulPoll).toLocaleTimeString() : '—';
      } else {
        hide('conn-port-row'); hide('conn-pid-row'); hide('conn-update-row');
      }
    }

    function show(id) { document.getElementById(id).style.display = 'flex'; }
    function hide(id) { document.getElementById(id).style.display = 'none'; }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
