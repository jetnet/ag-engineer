/**
 * Model Registry — reads model metadata from Antigravity cockpit cache.
 *
 * Data source: ~/.antigravity_cockpit/cache/quota_api_v1_plugin/authorized/*.json
 * Each file contains per-model metadata including:
 *   - maxTokens (context window size)
 *   - maxOutputTokens
 *   - displayName
 *   - tokenizerType
 *   - quotaInfo (remainingFraction, resetTime)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logDebug, logInfo, logWarning } from '../logging/logger';

export interface ModelInfo {
  id: string;
  displayName: string;
  maxTokens: number;
  maxOutputTokens: number;
  modelConstant: string;
  tokenizerType: string;
  supportsThinking: boolean;
  thinkingBudget: number;
  apiProvider: string;
  modelProvider: string;
  remainingFraction: number;
  resetTime: string | null;
}

export interface ModelRegistrySnapshot {
  models: Map<string, ModelInfo>;
  email: string;
  updatedAt: Date;
}

const COCKPIT_CACHE_DIR = path.join(
  os.homedir(),
  '.antigravity_cockpit',
  'cache',
  'quota_api_v1_plugin',
  'authorized',
);

export class ModelRegistry {
  private models = new Map<string, ModelInfo>();
  private email = '';
  private updatedAt = new Date(0);
  private watcher: fs.FSWatcher | null = null;
  private updateCallbacks: Array<(snapshot: ModelRegistrySnapshot) => void> = [];

  onUpdate(cb: (snapshot: ModelRegistrySnapshot) => void): void {
    this.updateCallbacks.push(cb);
  }

  /** Load model data from cockpit cache files. */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(COCKPIT_CACHE_DIR)) {
        logWarning(`Cockpit cache dir not found: ${COCKPIT_CACHE_DIR}`);
        return;
      }

      const files = fs.readdirSync(COCKPIT_CACHE_DIR).filter((f) => f.endsWith('.json'));
      if (files.length === 0) {
        logWarning('No cockpit cache files found');
        return;
      }

      // Use the most recently updated file
      let bestFile = '';
      let bestTime = 0;

      for (const file of files) {
        const filePath = path.join(COCKPIT_CACHE_DIR, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(content);
          const updatedAt = data.updatedAt || 0;
          if (updatedAt > bestTime) {
            bestTime = updatedAt;
            bestFile = filePath;
          }
        } catch {
          // Skip invalid files
        }
      }

      if (!bestFile) {
        logWarning('No valid cockpit cache files');
        return;
      }

      this.parseFile(bestFile);
      logInfo(`Model registry loaded: ${this.models.size} models from ${path.basename(bestFile)}`);
    } catch (err) {
      logWarning(`Model registry load error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Watch cockpit cache dir for changes. */
  startWatching(): void {
    if (this.watcher) return;
    try {
      if (!fs.existsSync(COCKPIT_CACHE_DIR)) return;

      this.watcher = fs.watch(COCKPIT_CACHE_DIR, { persistent: false }, (_event, filename) => {
        if (filename?.endsWith('.json')) {
          logDebug(`Cockpit cache changed: ${filename}`);
          // Debounce: reload after 1s
          setTimeout(() => this.load(), 1000);
        }
      });
    } catch {
      // Watch is best-effort
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Get model info by ID or display name (case-insensitive partial match). */
  getModel(idOrName: string): ModelInfo | undefined {
    const lower = idOrName.toLowerCase();

    // Exact ID match
    const exact = this.models.get(lower);
    if (exact) return exact;

    // Partial match by displayName or id
    for (const model of this.models.values()) {
      if (
        model.displayName.toLowerCase().includes(lower) ||
        model.id.toLowerCase().includes(lower)
      ) {
        return model;
      }
    }

    return undefined;
  }

  /** Get all chat-eligible models (filters out tab/internal models). */
  getChatModels(): ModelInfo[] {
    return [...this.models.values()].filter(
      (m) =>
        !m.id.startsWith('tab_') &&
        !m.id.startsWith('chat_') &&
        m.maxTokens > 0,
    );
  }

  /** Get the context window limit for a model. */
  getContextLimit(modelIdOrName: string): number {
    const model = this.getModel(modelIdOrName);
    return model?.maxTokens || 200_000; // Conservative fallback
  }

  getSnapshot(): ModelRegistrySnapshot {
    return {
      models: new Map(this.models),
      email: this.email,
      updatedAt: this.updatedAt,
    };
  }

  private parseFile(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    this.email = data.email || '';
    this.updatedAt = new Date(data.updatedAt || 0);

    const payload = data.payload;
    if (!payload?.models) return;

    this.models.clear();
    const modelsObj = payload.models as Record<string, Record<string, unknown>>;

    for (const [id, info] of Object.entries(modelsObj)) {
      const model: ModelInfo = {
        id,
        displayName: String(info.displayName || id),
        maxTokens: Number(info.maxTokens || 0),
        maxOutputTokens: Number(info.maxOutputTokens || 0),
        modelConstant: String(info.model || ''),
        tokenizerType: String(info.tokenizerType || ''),
        supportsThinking: Boolean(info.supportsThinking),
        thinkingBudget: Number(info.thinkingBudget || 0),
        apiProvider: String(info.apiProvider || ''),
        modelProvider: String(info.modelProvider || ''),
        remainingFraction: Number(
          (info.quotaInfo as Record<string, unknown>)?.remainingFraction ?? 1,
        ),
        resetTime: String(
          (info.quotaInfo as Record<string, unknown>)?.resetTime || '',
        ) || null,
      };

      this.models.set(id, model);
    }

    // Notify callbacks
    const snapshot = this.getSnapshot();
    for (const cb of this.updateCallbacks) {
      try { cb(snapshot); } catch { /* swallow */ }
    }
  }
}
