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
   * Fetch the latest token data using a multi-source strategy:
   *
   * 1. PRIMARY: GetCascadeTrajectorySteps → steps with metadata.modelUsage
   *    Returns a sliding window of ~1135 steps. The LAST step with modelUsage
   *    is the freshest live token data available (updates per-turn).
   *
   * 2. FALLBACK: GetCascadeTrajectoryGeneratorMetadata → generatorMetadata array
   *    Lighter but updates in batches (can lag 45+ entries behind).
   *
   * 3. METADATA: GetCascadeTrajectory → numTotalSteps/numTotalGM for diagnostics
   */
  private async fetchLatestTokenInfo(
    connection: ServerConnection,
    cascadeId: string,
  ): Promise<StepTokenInfo | null> {
    // --- Source 1: Steps modelUsage (freshest) ---
    const stepsResult = await this.fetchFromStepsModelUsage(connection, cascadeId);

    // --- Source 2: GM (fallback if steps has no modelUsage) ---
    const gmResult = await this.fetchFromGeneratorMetadata(connection, cascadeId);

    // --- Diagnostic: compare sources ---
    const stepsTotal = stepsResult
      ? stepsResult.inputTokens + stepsResult.cacheReadTokens + stepsResult.outputTokens
      : 0;
    const gmTotal = gmResult
      ? gmResult.inputTokens + gmResult.cacheReadTokens + gmResult.outputTokens
      : 0;

    // Also grab numTotalSteps/numTotalGM for diagnostics
    const trajMeta = await this.rpcCall<Record<string, unknown>>(
      connection,
      '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory',
      { cascadeId },
      (d) => d,
    );
    const numTotalSteps = trajMeta?.numTotalSteps ?? '?';
    const numTotalGM = trajMeta?.numTotalGeneratorMetadata ?? '?';
    const status = trajMeta?.status ?? '?';

    logDebug(`Sources: steps=${stepsTotal.toLocaleString()} GM=${gmTotal.toLocaleString()} | totalSteps=${numTotalSteps} totalGM=${numTotalGM} status=${status}`);

    // Pick the freshest source (higher total = more recent context window)
    if (stepsTotal >= gmTotal && stepsResult) {
      logDebug(`→ Using Steps modelUsage (fresher by ${(stepsTotal - gmTotal).toLocaleString()})`);
      return stepsResult;
    } else if (gmResult) {
      logDebug(`→ Using GM (fresher by ${(gmTotal - stepsTotal).toLocaleString()})`);
      return gmResult;
    }

    return null;
  }

  /**
   * Fetch token data from Steps API — modelUsage on individual steps.
   */
  private async fetchFromStepsModelUsage(
    connection: ServerConnection,
    cascadeId: string,
  ): Promise<StepTokenInfo | null> {
    const STEPS_PATH =
      '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps';

    const data = await this.rpcCall<Record<string, unknown>>(
      connection,
      STEPS_PATH,
      { cascadeId },
      (d) => d,
    );

    const steps = (data?.steps ?? []) as Array<Record<string, unknown>>;
    if (steps.length === 0) return null;

    // Walk backwards to find the LAST step with modelUsage
    for (let i = steps.length - 1; i >= 0; i--) {
      const meta = steps[i].metadata as Record<string, unknown> | undefined;
      const mu = meta?.modelUsage as Record<string, string> | undefined;
      if (!mu) continue;

      const inputTokens = parseInt(mu.inputTokens || '0', 10);
      const cacheReadTokens = parseInt(mu.cacheReadTokens || '0', 10);
      const outputTokens = parseInt(mu.outputTokens || '0', 10);

      if (inputTokens === 0 && cacheReadTokens === 0) continue;

      const model = String(mu.model || 'Unknown');
      const apiProvider = String(mu.apiProvider || '');
      const contextTotal = inputTokens + cacheReadTokens + outputTokens;

      logDebug(
        `Steps[${i}/${steps.length}]: context=${contextTotal.toLocaleString()} ` +
        `(in=${inputTokens.toLocaleString()} cache=${cacheReadTokens.toLocaleString()} out=${outputTokens.toLocaleString()})`,
      );

      return { model, inputTokens, outputTokens, cacheReadTokens, apiProvider };
    }

    return null;
  }

  /**
   * Fetch token data from GeneratorMetadata API (batch-updated, may lag).
   */
  private async fetchFromGeneratorMetadata(
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
    if (gmArray.length === 0) return null;

    logDebug(`GM: ${gmArray.length} entries`);

    // Walk backwards to find the latest entry with token data
    for (let i = gmArray.length - 1; i >= 0; i--) {
      const chatModel = gmArray[i].chatModel as Record<string, unknown> | undefined;
      const usage = (chatModel?.usage ?? {}) as Record<string, string>;

      const inputTokens = parseInt(usage.inputTokens || '0', 10);
      const outputTokens = parseInt(usage.outputTokens || '0', 10);
      const cacheReadTokens = parseInt(usage.cacheReadTokens || '0', 10);
      const model = String(usage.model || chatModel?.model || 'Unknown');
      const apiProvider = String(usage.apiProvider || '');

      if (inputTokens === 0 && cacheReadTokens === 0) continue;

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
