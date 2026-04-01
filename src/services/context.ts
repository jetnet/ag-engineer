/**
 * Context Window Monitoring Service.
 *
 * Uses GetCascadeTrajectory (with cascadeId) and reads the last
 * `generatorMetadata` entry which contains:
 *   - chatModel.usage: {inputTokens, outputTokens, cacheReadTokens, model, apiProvider}
 *   - contextWindowMetadata: {
 *       estimatedTokensUsed,
 *       tokenBreakdown: { totalTokens, groups: [{name, numTokens, children}] }
 *     }
 *
 * `estimatedTokensUsed` is the authoritative, server-computed context window
 * usage.  It updates with every agent turn and includes system prompt,
 * conversation history, active context items, and chat messages.
 */
import type { ContextSnapshot, ContextUpdateCallback, ServerConnection } from '../types';
import { logDebug, logInfo, logWarning } from '../logging/logger';
import type { ModelRegistry } from './model-registry';
import * as http from 'http';

const GET_TRAJECTORIES_PATH =
  '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories';

/** Model placeholder → display name mapping (from apiProvider) */
const API_PROVIDER_LABELS: Record<string, string> = {
  API_PROVIDER_ANTHROPIC_VERTEX: 'Claude',
  API_PROVIDER_ANTHROPIC: 'Claude',
  API_PROVIDER_GOOGLE: 'Gemini',
  API_PROVIDER_GOOGLE_VERTEX: 'Gemini',
  API_PROVIDER_OPENAI: 'GPT',
};

interface TrajectorySummary {
  summary?: string;
  lastModifiedTime?: string;
  status?: string;
  stepCount?: number;
  workspaces?: Array<{ workspaceFolderAbsoluteUri?: string }>;
  [key: string]: unknown;
}

interface StepTokenInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  apiProvider: string;
  /** Server-estimated total context window usage (more accurate than sum of fields) */
  estimatedTokensUsed?: number;
  /** Optional breakdown by category */
  tokenBreakdown?: TokenBreakdown;
}

interface TokenBreakdown {
  totalTokens: number;
  groups: TokenBreakdownGroup[];
}

interface TokenBreakdownGroup {
  name: string;
  type?: string;
  source?: string;
  numTokens?: number;
  children?: TokenBreakdownGroup[];
}

export class ContextService {
  private lastSnapshot: ContextSnapshot | null = null;
  private updateCallbacks: ContextUpdateCallback[] = [];
  private tokenHistory: Array<{ timestamp: Date; total: number }> = [];
  private readonly maxHistory = 100;
  private modelRegistry: ModelRegistry | null = null;
  private activeConversationId: string | undefined;
  /** Workspace URIs to match against trajectories */
  private workspaceUris: string[] = [];
  /** High-water mark: last known step index for incremental polling */
  private lastKnownStepIndex = 0;

  onUpdate(cb: ContextUpdateCallback): void {
    this.updateCallbacks.push(cb);
  }

  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  setWorkspaceUris(uris: string[]): void {
    this.workspaceUris = uris;
  }

  getLastSnapshot(): ContextSnapshot | null {
    return this.lastSnapshot;
  }

  getTokenHistory(): Array<{ timestamp: Date; total: number }> {
    return [...this.tokenHistory];
  }

  /**
   * Fetch real context data from trajectory steps.
   */
  async fetchContext(connection: ServerConnection): Promise<ContextSnapshot | null> {
    try {
      // 1. Get all trajectories to find the active conversation
      const trajectories = await this.rpcCall(
        connection,
        GET_TRAJECTORIES_PATH,
        {},
        (data) => (data.trajectorySummaries as Record<string, TrajectorySummary>) || null,
      );
      if (!trajectories) return null;

      // 2. Find the active trajectory (current workspace or most recent)
      const { id: cascadeId, traj: activeTraj } = this.findActiveTrajectory(trajectories);
      if (!cascadeId || !activeTraj) return null;

      this.activeConversationId = cascadeId;
      const shortId = cascadeId.substring(0, 8);

      // 3. Fetch live trajectory data (uses GetCascadeTrajectory which
      //    returns up-to-date steps, unlike GetCascadeTrajectorySteps)
      logDebug(`Fetching live trajectory for ${shortId}…`);
      const tokenInfo = await this.fetchLatestTokenInfo(connection, cascadeId);

      // 4. Build snapshot
      const snapshot = this.buildSnapshot(cascadeId, activeTraj, tokenInfo);
      this.lastSnapshot = snapshot;

      // Track history
      if (snapshot.totalTokens > 0) {
        this.tokenHistory.push({ timestamp: snapshot.timestamp, total: snapshot.totalTokens });
        if (this.tokenHistory.length > this.maxHistory) {
          this.tokenHistory.shift();
        }
      }

      for (const cb of this.updateCallbacks) {
        try { cb(snapshot); } catch { /* swallow */ }
      }

      return snapshot;
    } catch (err) {
      logWarning(`Context fetch error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Find the active trajectory matching the CURRENT workspace only.
   * Returns empty if no trajectory matches — we don't show stale data from other projects.
   */
  private findActiveTrajectory(
    trajectories: Record<string, TrajectorySummary>,
  ): { id?: string; traj?: TrajectorySummary } {
    let workspaceMatchId: string | undefined;
    let workspaceMatchTraj: TrajectorySummary | undefined;
    let workspaceMatchTime = 0;
    let matchCount = 0;

    for (const [id, traj] of Object.entries(trajectories)) {
      const modified = new Date(traj.lastModifiedTime || 0).getTime();

      // Only consider trajectories that match this workspace
      if (this.workspaceUris.length > 0 && traj.workspaces) {
        for (const ws of traj.workspaces) {
          const uri = ws.workspaceFolderAbsoluteUri || '';
          if (this.workspaceUris.some((u) => uri.includes(u) || u.includes(uri))) {
            matchCount++;
            if (modified > workspaceMatchTime) {
              workspaceMatchId = id;
              workspaceMatchTraj = traj;
              workspaceMatchTime = modified;
            }
          }
        }
      }
    }

    if (workspaceMatchId && workspaceMatchTraj) {
      const shortId = workspaceMatchId.substring(0, 8);
      const steps = workspaceMatchTraj.stepCount || 0;
      const status = workspaceMatchTraj.status || 'unknown';
      if (matchCount > 1) {
        logDebug(`Trajectory: ${shortId}… (${matchCount} matched, steps=${steps}, status=${status})`);
      }
      return { id: workspaceMatchId, traj: workspaceMatchTraj };
    }

    // No workspace match — don't fallback to another project
    logDebug(`No trajectory found for current workspace (${Object.keys(trajectories).length} total, ${this.workspaceUris.join(', ')})`);
    return {};
  }

  /**
   * Fetch the latest token data using the dedicated GeneratorMetadata API.
   *
   * GetCascadeTrajectoryGeneratorMetadata returns ONLY the generatorMetadata
   * array — lighter than GetCascadeTrajectory (no step data) and often
   * 1 entry fresher. Each entry has `chatModel.usage` with live token counts.
   *
   * Fallback: GetCascadeTrajectorySteps is frozen after checkpoint/truncation.
   * StreamAgentStateUpdates needs Connect streaming framing (future work).
   */
  private async fetchLatestTokenInfo(
    connection: ServerConnection,
    cascadeId: string,
  ): Promise<StepTokenInfo | null> {
    const GM_PATH =
      '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata';

    const data = await this.rpcCall<Record<string, unknown>>(
      connection,
      GM_PATH,
      { cascadeId },
      (d) => d,
    );

    const gmArray = (data?.generatorMetadata ?? []) as Array<Record<string, unknown>>;

    if (gmArray.length === 0) {
      logDebug('No generatorMetadata returned');
      return null;
    }

    logDebug(`Got ${gmArray.length} GM entries via GetCascadeTrajectoryGeneratorMetadata`);

    // --- Debug: peak context & model distribution ---
    let peakContext = 0;
    let peakIdx = 0;
    const modelCounts: Record<string, number> = {};
    for (let i = 0; i < gmArray.length; i++) {
      const u = ((gmArray[i].chatModel as Record<string, unknown>)?.usage ?? {}) as Record<string, string>;
      const total = parseInt(u.inputTokens || '0', 10) + parseInt(u.cacheReadTokens || '0', 10) + parseInt(u.outputTokens || '0', 10);
      if (total > peakContext) { peakContext = total; peakIdx = i; }
      const m = String(u.model || '').replace('MODEL_PLACEHOLDER_', 'M').replace('MODEL_', '') || '?';
      modelCounts[m] = (modelCounts[m] || 0) + 1;
    }
    logDebug(`Peak context: ${peakContext.toLocaleString()} at GM[${peakIdx}]`);
    logDebug(`Models: ${Object.entries(modelCounts).map(([m, c]) => `${m}×${c}`).join(', ')}`);

    // --- Debug: last 3 entries for trend ---
    const trendStart = Math.max(0, gmArray.length - 3);
    for (let i = trendStart; i < gmArray.length; i++) {
      const gm = gmArray[i];
      const u = ((gm.chatModel as Record<string, unknown>)?.usage ?? {}) as Record<string, string>;
      const inp = parseInt(u.inputTokens || '0', 10);
      const cache = parseInt(u.cacheReadTokens || '0', 10);
      const out = parseInt(u.outputTokens || '0', 10);
      const total = inp + cache + out;
      const m = String(u.model || '').replace('MODEL_PLACEHOLDER_', 'M');
      const steps = (gm.stepIndices as number[]) || [];
      logDebug(`  trend GM[${i}] steps=[${steps.join(',')}] ${total.toLocaleString()} (in=${inp} cache=${cache.toLocaleString()} out=${out}) ${m}`);
    }

    // Walk backwards to find the latest GM entry with token data
    for (let i = gmArray.length - 1; i >= 0; i--) {
      const gm = gmArray[i];
      const chatModel = gm.chatModel as Record<string, unknown> | undefined;
      const usage = (chatModel?.usage ?? {}) as Record<string, string>;

      const inputTokens = parseInt(usage.inputTokens || '0', 10);
      const outputTokens = parseInt(usage.outputTokens || '0', 10);
      const cacheReadTokens = parseInt(usage.cacheReadTokens || '0', 10);
      const model = String(usage.model || chatModel?.model || 'Unknown');
      const apiProvider = String(usage.apiProvider || '');

      if (inputTokens === 0 && cacheReadTokens === 0) continue;

      const contextTotal = inputTokens + cacheReadTokens + outputTokens;
      const stepIndices = gm.stepIndices as number[] | undefined;
      logDebug(
        `→ Using GM[${i}/${gmArray.length}] steps=${JSON.stringify(stepIndices)}: ` +
        `context=${contextTotal.toLocaleString()} ` +
        `(in=${inputTokens.toLocaleString()} cache=${cacheReadTokens.toLocaleString()} out=${outputTokens.toLocaleString()}) ` +
        `model=${model}`,
      );

      return { model, inputTokens, outputTokens, cacheReadTokens, apiProvider };
    }

    return null;
  }

  private buildSnapshot(
    conversationId: string,
    traj: TrajectorySummary,
    tokenInfo: StepTokenInfo | null,
  ): ContextSnapshot {
    // Determine model name and context limit
    let modelName = 'Unknown';
    let contextLimit = 200_000;

    if (tokenInfo) {
      // Use API provider for display name
      modelName = API_PROVIDER_LABELS[tokenInfo.apiProvider] || tokenInfo.model;

      // Look up context limit from model registry
      if (this.modelRegistry) {
        const chatModels = this.modelRegistry.getChatModels();
        // Match by provider type
        const providerLC = tokenInfo.apiProvider.toLowerCase();
        let matchedModel = chatModels.find((m) => {
          const nameLC = m.displayName.toLowerCase();
          if (providerLC.includes('anthropic') && nameLC.includes('claude')) return true;
          if (providerLC.includes('google') && nameLC.includes('gemini')) return true;
          if (providerLC.includes('openai') && nameLC.includes('gpt')) return true;
          return false;
        });

        // Fallback: use highest context model matching the provider
        if (!matchedModel) {
          matchedModel = chatModels
            .filter((m) => m.maxTokens > 50_000)
            .sort((a, b) => b.maxTokens - a.maxTokens)[0];
        }

        if (matchedModel) {
          modelName = matchedModel.displayName;
          contextLimit = matchedModel.maxTokens;
        }
      }
    }

    // Token data
    const isEstimated = !tokenInfo;
    const rawInput = tokenInfo ? tokenInfo.inputTokens : 0;
    const cacheRead = tokenInfo ? tokenInfo.cacheReadTokens : 0;
    const inputTokens = rawInput + cacheRead;
    const outputTokens = tokenInfo ? tokenInfo.outputTokens : 0;
    const totalTokens = inputTokens + outputTokens;
    const usedPct = contextLimit > 0 ? (totalTokens / contextLimit) * 100 : 0;

    const status = traj.status || '';
    const isRunning = status.includes('RUNNING');

    if (tokenInfo) {
      logInfo(
        `Context: ${modelName} — ${totalTokens.toLocaleString()}/${contextLimit.toLocaleString()} ` +
        `(${usedPct.toFixed(1)}%) [in=${tokenInfo.inputTokens.toLocaleString()} + cache=${tokenInfo.cacheReadTokens.toLocaleString()} + out=${tokenInfo.outputTokens.toLocaleString()}]` +
        (isRunning ? ' 🔴 RUNNING' : ''),
      );
    }

    return {
      conversationId,
      model: modelName,
      inputTokens,
      cacheReadTokens: cacheRead,
      outputTokens,
      totalTokens,
      contextLimit,
      usedPercentage: Math.min(usedPct, 100),
      remainingTokens: Math.max(contextLimit - totalTokens, 0),
      isEstimated,
      timestamp: new Date(),
    };
  }

  /**
   * Generic RPC call helper.
   */
  private rpcCall<T>(
    connection: ServerConnection,
    path: string,
    payload: Record<string, unknown>,
    extract: (data: Record<string, unknown>) => T | null,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const body = JSON.stringify(payload);
      const req = http.request(
        {
          hostname: connection.host,
          port: connection.port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Codeium-Csrf-Token': connection.csrfToken,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.code && parsed.message) {
                // RPC error
                logDebug(`RPC error on ${path}: ${parsed.message}`);
                resolve(null);
                return;
              }
              resolve(extract(parsed));
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  }
}
