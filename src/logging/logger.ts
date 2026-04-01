/**
 * Structured logger with output channel integration.
 * All extension logging goes through here for consistent formatting.
 */
import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;
let debugMode = false;

export function initLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Antigravity Engineer');
  context.subscriptions.push(outputChannel);
  debugMode = vscode.workspace
    .getConfiguration('antigravityEngineer')
    .get('debugMode', false);
}

export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export function logInfo(message: string): void {
  const line = `[${timestamp()}] ℹ️  ${message}`;
  outputChannel?.appendLine(line);
}

export function logSuccess(message: string): void {
  const line = `[${timestamp()}] ✅ ${message}`;
  outputChannel?.appendLine(line);
}

export function logWarning(message: string): void {
  const line = `[${timestamp()}] ⚠️  ${message}`;
  outputChannel?.appendLine(line);
}

export function logError(message: string): void {
  const line = `[${timestamp()}] ❌ ${message}`;
  outputChannel?.appendLine(line);
}

export function logDebug(message: string): void {
  if (!debugMode) return;
  const line = `[${timestamp()}] 🔍 ${message}`;
  outputChannel?.appendLine(line);
}

export function logDiagnostic(title: string, data: Record<string, unknown>): void {
  const sep = '─'.repeat(55);
  outputChannel?.appendLine(`[${timestamp()}] 📋 ${title}`);
  outputChannel?.appendLine(sep);
  for (const [key, value] of Object.entries(data)) {
    outputChannel?.appendLine(`  ${key}: ${String(value)}`);
  }
  outputChannel?.appendLine(sep);
}

export function showOutputChannel(): void {
  outputChannel?.show(true);
}
