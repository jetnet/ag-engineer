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

  updateContext(snapshot: ContextSnapshot, history?: Array<{ timestamp: Date; total: number }>): void {
    this.lastContext = snapshot;
    this.postMessage({ type: 'context', data: snapshot });
    if (history && history.length > 0) {
      this.postMessage({
        type: 'contextHistory',
        data: history.map(h => ({ t: h.timestamp.getTime(), v: h.total })),
      });
    }
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
      transition: all 0.3s ease;
    }
    
    @keyframes barPulse {
      0% { opacity: 1; box-shadow: 0 0 0px var(--clr-output); }
      50% { opacity: 0.8; box-shadow: 0 0 10px var(--clr-output); }
      100% { opacity: 1; box-shadow: 0 0 0px var(--clr-output); }
    }
    .is-running {
      animation: barPulse 2s infinite;
      border: 1px solid var(--clr-output);
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

    /* Sparkline chart */
    .chart-container {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }
    .chart-label {
      font-size: 10px;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 4px;
    }
    .chart-canvas {
      width: 100%;
      height: 48px;
      border-radius: 4px;
      background: rgba(255,255,255,0.03);
    }
    .chart-time {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      opacity: 0.4;
      margin-top: 2px;
    }
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
        <div class="progress-container" id="progress-bar-container">
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
        
        <div id="ctx-breakdown" style="display:none; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border)">
          <div class="row" style="margin-bottom: 6px;">
            <span class="label" style="opacity: 1; font-weight: 600;">📂 Context Anatomy</span>
          </div>
          <div id="ctx-breakdown-list"></div>
        </div>
        
        <div class="chart-container" id="chart-section" style="display:none">
          <div class="chart-label">Context over time</div>
          <canvas id="sparkline" class="chart-canvas"></canvas>
          <div class="chart-time">
            <span id="chart-t0">—</span>
            <span id="chart-t1">—</span>
          </div>
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
        case 'contextHistory': renderSparkline(msg.data); break;
      }
    });

    function renderContext(ctx) {
      document.getElementById('context-empty').style.display = 'none';
      document.getElementById('context-data').style.display = 'block';

      const est = ctx.isEstimated ? ' ~' : '';
      let toolsIcon = '';
      if (ctx.hasImageGeneration) toolsIcon += '📷';
      if (ctx.hasWebSearch) toolsIcon += '🌐';
      if (ctx.hasTerminalCommand) toolsIcon += '💻';
      if (ctx.hasFileRead) toolsIcon += '📖';
      if (toolsIcon) toolsIcon = ' ' + toolsIcon;
      document.getElementById('ctx-model').textContent = ctx.model + toolsIcon;
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
      
      const pbc = document.getElementById('progress-bar-container');
      if (pbc) {
        if (ctx.isRunning) pbc.classList.add('is-running');
        else pbc.classList.remove('is-running');
      }
      
      // Render Token Breakdown (File Weights)
      if (ctx.tokenBreakdown || ctx.cwmDump) {
        let bHtml = '';
        
        if (ctx.tokenBreakdown && ctx.tokenBreakdown.groups && ctx.tokenBreakdown.groups.length > 0) {
          // Recursive rendering
          function renderGroup(g, indent) {
            const toks = g.numTokens !== undefined ? g.numTokens : (g.tokenCount !== undefined ? g.tokenCount : (g.totalTokens !== undefined ? g.totalTokens : 0));
            if (!toks && !g.children) return; 
            
            const k = toks >= 1000 ? (toks/1000).toFixed(1)+'k' : toks;
            const pad = indent * 8;
            bHtml += '<div class="row" style="padding-left: ' + pad + 'px; font-size: 11px; margin-bottom: 2px;">' +
              '<span class="label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 130px;">' + (g.name || g.source || g.type || '?') + '</span>' +
              '<span class="value" style="font-family: Consolas, monospace; opacity: 0.8;">' + k + ' t</span>' +
            '</div>';
            if (g.children) {
              for (const child of g.children) renderGroup(child, indent + 1);
            }
          }
          for (const g of ctx.tokenBreakdown.groups) {
            renderGroup(g, 0);
          }
        } else {
          // Debug fallback: Render raw JSON if format is unexpected or missing entirely
          const payloadToDump = ctx.cwmDump || ctx.tokenBreakdown;
          bHtml = '<pre style="font-size:10px; color:var(--warning); overflow:auto; max-height:200px;">' + JSON.stringify(payloadToDump, null, 2) + '</pre>';
        }
        
        document.getElementById('ctx-breakdown-list').innerHTML = bHtml;
        document.getElementById('ctx-breakdown').style.display = 'block';
      } else {
        document.getElementById('ctx-breakdown').style.display = 'none';
      }

      // Stacked bar segments as % of contextLimit
      const limit = ctx.contextLimit || 1;
      const inputPct = (rawInput / limit) * 100;
      const cachePct = (cache / limit) * 100;
      const outputPct = (ctx.outputTokens / limit) * 100;
      document.getElementById('seg-input').style.width = Math.min(inputPct, 100) + '%';
      document.getElementById('seg-cache').style.width = Math.min(cachePct, 100) + '%';
      document.getElementById('seg-output').style.width = Math.min(outputPct, 100) + '%';

      // Capture limit for sparkline Y-axis
      if (ctx.contextLimit) lastContextLimit = ctx.contextLimit;
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

    let lastContextLimit = 200000;
    function renderSparkline(points) {
      if (!points || points.length < 2) return;
      const section = document.getElementById('chart-section');
      section.style.display = 'block';

      const canvas = document.getElementById('sparkline');
      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = 48;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const vals = points.map(p => p.v);
      const maxVal = lastContextLimit || Math.max(...vals);
      const minVal = 0;
      const range = maxVal - minVal || 1;
      const pad = 2;
      const plotW = w - pad * 2;
      const plotH = h - pad * 2;

      // Draw limit line (100%)
      ctx.strokeStyle = 'rgba(244, 67, 54, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pad, pad);
      ctx.lineTo(pad + plotW, pad);
      ctx.stroke();
      ctx.setLineDash([]);

      // Build path
      const step = plotW / (points.length - 1);
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const x = pad + i * step;
        const y = pad + plotH - ((vals[i] - minVal) / range) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      // Stroke line
      ctx.strokeStyle = '#00bcd4';
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Fill gradient under line
      const lastX = pad + (points.length - 1) * step;
      const gradient = ctx.createLinearGradient(0, pad, 0, pad + plotH);
      gradient.addColorStop(0, 'rgba(0, 188, 212, 0.3)');
      gradient.addColorStop(1, 'rgba(0, 188, 212, 0.02)');
      ctx.lineTo(lastX, pad + plotH);
      ctx.lineTo(pad, pad + plotH);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // Current value dot
      const lastY = pad + plotH - ((vals[vals.length - 1] - minVal) / range) * plotH;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#00bcd4';
      ctx.fill();

      // Time labels
      const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('chart-t0').textContent = fmtTime(points[0].t);
      document.getElementById('chart-t1').textContent = fmtTime(points[points.length - 1].t);
    }
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
