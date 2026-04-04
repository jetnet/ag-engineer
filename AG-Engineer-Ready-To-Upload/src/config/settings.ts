/**
 * Configuration manager — wraps vscode.workspace.getConfiguration
 * with typed accessors and change detection.
 */
import * as vscode from 'vscode';

export interface ExtensionConfig {
  pollingInterval: number;
  lowQuotaThreshold: number;
  criticalQuotaThreshold: number;
  contextLimitOverrides: Record<string, number>;
  serverHost: string;
  debugMode: boolean;
  /** Allow trajectories without workspace info to participate in auto-selection (Pass 2 fallback) */
  allowUnknownWorkspaceFallback: boolean;
  /** How long (seconds) to suppress repeated LoadTrajectory calls for the same cascade before re-arming */
  loadTrajectoryTtlSeconds: number;
  statusBar: {
    showContextWindow: boolean;
    models: string[];
    showCredits: boolean;
  };
}

const SECTION = 'antigravityEngineer';

/** Known default context limits per model family (tokens). */
export const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus': 200_000,
  'claude-sonnet': 200_000,
  'gemini-pro': 1_000_000,
  'gemini-flash': 1_000_000,
  'gpt': 120_000,
};

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    pollingInterval: cfg.get<number>('pollingInterval', 30),
    lowQuotaThreshold: cfg.get<number>('lowQuotaThreshold', 30),
    criticalQuotaThreshold: cfg.get<number>('criticalQuotaThreshold', 10),
    contextLimitOverrides: cfg.get<Record<string, number>>('contextLimitOverrides', {}),
    serverHost: cfg.get<string>('serverHost', '127.0.0.1'),
    debugMode: cfg.get<boolean>('debugMode', false),
    allowUnknownWorkspaceFallback: cfg.get<boolean>('allowUnknownWorkspaceFallback', false),
    loadTrajectoryTtlSeconds: cfg.get<number>('loadTrajectoryTtlSeconds', 120),
    statusBar: {
      showContextWindow: cfg.get<boolean>('statusBar.showContextWindow', true),
      models: (() => {
        const arr = cfg.get<string[]>('statusBar.models', []);
        return arr.length > 0 ? arr : ["Pro", "Flash", "Sonnet", "Opus", "GPT"];
      })(),
      showCredits: cfg.get<boolean>('statusBar.showCredits', true),
    },
  };
}

export function onConfigChange(callback: (cfg: ExtensionConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      callback(getConfig());
    }
  });
}
