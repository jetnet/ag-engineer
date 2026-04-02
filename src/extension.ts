/**
 * Antigravity Engineer — Extension Entry Point
 *
 * Orchestrates: Discovery → RPC → Services → UI
 *
 * Lifecycle:
 * 1. Activate: init logger, load model registry, register commands, create UI, start discovery
 * 2. Poll loop: discover LS → fetch quota/context → update UI
 * 3. Deactivate: stop pollers, cleanup
 */
import * as vscode from 'vscode';
import { initLogger, logInfo, logSuccess, logWarning, setDebugMode } from './logging/logger';
import { getConfig, onConfigChange } from './config/settings';
import { discoverLanguageServer } from './platform/discovery';
import { QuotaService } from './services/quota';
import { ContextService } from './services/context';
import { ModelRegistry } from './services/model-registry';
import { Poller } from './services/poller';
import { StatusBarManager } from './ui/statusbar';
import { SidebarProvider } from './ui/sidebar/provider';
import { registerCommands } from './commands';
import type { ServerConnection, DiagnosticInfo } from './types';

const { version: EXTENSION_VERSION } = require('../package.json');

let statusBar: StatusBarManager;
let sidebarProvider: SidebarProvider;
let quotaService: QuotaService;
let contextService: ContextService;
let modelRegistry: ModelRegistry;
let poller: Poller;
let connection: ServerConnection | null = null;
let diagnostics: DiagnosticInfo = {
  connectionStatus: 'disconnected',
  pollCount: 0,
  failCount: 0,
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  logInfo(`Antigravity Engineer v${EXTENSION_VERSION} activating...`);

  const config = getConfig();
  setDebugMode(config.debugMode);

  // === Model Registry (from cockpit cache) ===
  modelRegistry = new ModelRegistry();
  await modelRegistry.load();
  modelRegistry.startWatching();
  context.subscriptions.push({ dispose: () => modelRegistry.stopWatching() });

  // === Services ===
  quotaService = new QuotaService();
  contextService = new ContextService();
  contextService.setModelRegistry(modelRegistry);

  // Pass workspace URIs so context service can match trajectories to this window
  const wsUris = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.toString());
  contextService.setWorkspaceUris(wsUris);

  // === UI ===
  statusBar = new StatusBarManager();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  // === Bootstrap UI from Cache ===
  const cachedQuota = context.globalState.get<any>('lastQuotaSnapshot');
  if (cachedQuota && cachedQuota.timestamp) {
    try {
      const restored = { ...cachedQuota, timestamp: new Date(cachedQuota.timestamp) };
      statusBar.updateQuota(restored);
      sidebarProvider.updateQuota(restored);
    } catch { /* ignore cache errors */ }
  }

  // Wire service updates to UI
  quotaService.onUpdate((snapshot) => {
    statusBar.updateQuota(snapshot);
    sidebarProvider.updateQuota(snapshot);
    context.globalState.update('lastQuotaSnapshot', {
      ...snapshot,
      timestamp: snapshot.timestamp.toISOString(),
    });
  });

  contextService.onUpdate((snapshot) => {
    statusBar.updateContext(snapshot);
    sidebarProvider.updateContext(snapshot);
  });

  modelRegistry.onUpdate((snapshot) => {
    sidebarProvider.updateModelRegistry(snapshot);
  });

  // === Commands ===
  registerCommands(context, {
    refreshNow: () => poller.triggerNow(),
    resetState: async () => {
      await context.globalState.update('lastQuotaSnapshot', undefined);
      connection = null;
      updateDiagnostics({ connectionStatus: 'disconnected', pollCount: 0, failCount: 0 });
      poller.triggerNow();
    },
  });

  // === Config Change Listener ===
  context.subscriptions.push(
    onConfigChange((newConfig) => {
      logInfo('Configuration changed, applying...');
      setDebugMode(newConfig.debugMode);
      poller.setInterval(newConfig.pollingInterval * 1000);
    }),
  );

  // === UI Event Listeners ===
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Trigger instant refresh on file switch to keep workspace context fresh
      poller.triggerNow();
    })
  );

  // === Main Poll Loop ===
  poller = new Poller(
    'main',
    async (signal) => {
      if (signal.aborted) return;

      // Step 1: Ensure we have a connection
      if (!connection) {
        updateDiagnostics({ ...diagnostics, connectionStatus: 'connecting' });
        connection = await discoverLanguageServer(config.serverHost);

        if (!connection) {
          updateDiagnostics({
            ...diagnostics,
            connectionStatus: 'disconnected',
            failCount: diagnostics.failCount + 1,
          });
          return;
        }

        logSuccess(`Connected to LS on port ${connection.port} (PID: ${connection.pid})`);
        updateDiagnostics({
          ...diagnostics,
          connectionStatus: 'connected',
          discoveredPort: connection.port,
          discoveredPid: connection.pid,
          discoveredWorkspaceId: connection.workspaceId,
        });
      }

      // Step 2: Fetch quota
      const quota = await quotaService.fetchQuota(connection);
      if (!quota) {
        diagnostics.failCount++;
        if (diagnostics.failCount >= 3) {
          logWarning('Multiple failures — re-discovering language server...');
          connection = null;
          updateDiagnostics({ ...diagnostics, connectionStatus: 'disconnected' });
        }
        return;
      }

      // Step 3: Fetch context (trajectory-based estimation)
      await contextService.fetchContext(connection);

      // Step 4: Update diagnostics
      diagnostics.pollCount++;
      diagnostics.failCount = 0;
      diagnostics.lastSuccessfulPoll = new Date();
      diagnostics.connectionStatus = 'connected';
      updateDiagnostics(diagnostics);
    },
    config.pollingInterval * 1000,
  );

  context.subscriptions.push({ dispose: () => poller.stop() });

  // Start!
  poller.start();
  logSuccess('Antigravity Engineer activated ✨');
}

export function deactivate(): void {
  poller?.stop();
  modelRegistry?.stopWatching();
  logInfo('Antigravity Engineer deactivated');
}

function updateDiagnostics(info: DiagnosticInfo): void {
  diagnostics = info;
  statusBar.updateDiagnostics(info);
  sidebarProvider.updateDiagnostics(info);
}
