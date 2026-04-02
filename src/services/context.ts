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
 *
 * v0.3.8 — Multi-LS stabilization:
 *  - Collect-and-rank Pass 1 (PPID → workspace → freshness → stepCount)
 *  - Owner-resolution Pass 2 (pick LS with highest progressionIndex)
 *  - Owner caching (skip full multi-LS scan when cache is still valid)
 *  - estimatedTokensUsed from contextWindowMetadata
 *  - Deterministic override matching (exact > longest substring)
 *  - bestGlobalTime fix for Pass 1
 */
import type { ContextSnapshot, ContextUpdateCallback, ServerConnection } from '../types';
import { logDebug, logInfo, logWarning } from '../logging/logger';
import type { ModelRegistry } from './model-registry';
import * as http from 'http';
import * as vscode from 'vscode';


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
  /** Index for arbitration */
  progressionIndex?: number;
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

/** Candidate from Pass 1 (GetBrowserOpenConversation) collect-and-rank §C-3 */
interface OpenCandidate {
  srv: ServerConnection;
  cascadeId: string;
  traj: TrajectorySummary | null;
  ppidMatch: boolean;
  workspaceMatch: boolean;
  modified: number;
  stepCount: number;
}

/** Owner cache entry §C-7 */
interface OwnerCacheEntry {
  port: number;
  csrfToken: string;
  lastProgression: number;
}

export class ContextService {
  private lastSnapshot: ContextSnapshot | null = null;
  private updateCallbacks: ContextUpdateCallback[] = [];
  private tokenHistory: Array<{ timestamp: Date; total: number }> = [];
  private readonly maxHistory = 100;
  private modelRegistry: ModelRegistry | null = null;
  private suppressedLoadTrajectories = new Set<string>();

  /** Workspace URIs to match against trajectories */
  private workspaceUris: string[] = [];

  /** Owner cache: cascadeId → {port, lastProgression} §C-7 */
  private ownerCache = new Map<string, OwnerCacheEntry>();

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
      const { discoverAllLanguageServers } = require('../platform/discovery');
      const serversToTry: ServerConnection[] = await discoverAllLanguageServers(connection.host);
      // Ensure the default connection is in the list just in case
      if (!serversToTry.some((s: ServerConnection) => s.port === connection.port)) {
        serversToTry.push(connection);
      }

      let bestGlobalId = '';
      let bestGlobalTraj: TrajectorySummary | null = null;
      let bestGlobalConn: ServerConnection | null = null;
      let bestGlobalTime = 0;

      // ─── Pass 1: Collect-and-rank via GetBrowserOpenConversation §C-3 ───
      // Instead of breaking on the first responder, collect ALL candidates and score them.
      const openCandidates: OpenCandidate[] = [];
      for (const srv of serversToTry) {
        try {
          const resp = await this.rpcCall<Record<string, any>>(
            srv,
            '/exa.language_server_pb.LanguageServerService/GetBrowserOpenConversation',
            {},
            (d) => d
          );
          if (resp && resp.cascadeId) {
            const cascadeId = resp.cascadeId as string;
            const ppidMatch = typeof srv.ppid === 'number' && srv.ppid === process.pid;  // §C-1

            // Fetch trajectory summary for scoring (workspace, modified, stepCount)
            let traj: TrajectorySummary | null = null;
            let workspaceMatch = false;
            let modified = 0;
            let stepCount = 0;

            const trajMeta = await this.rpcCall<Record<string, any>>(
              srv,
              '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory',
              { cascadeId },
              (d) => d
            );
            if (trajMeta) {
              traj = trajMeta as TrajectorySummary;
              stepCount = (trajMeta.numTotalSteps as number) || (trajMeta.stepCount as number) || 0;
              modified = this.parseModifiedTime(trajMeta.lastModifiedTime);
              workspaceMatch = this.matchesWorkspace(traj);
            } else {
              // Fallback fake summary if the call fails but we know it's active
              traj = { status: 'RUNNING' };
            }

            openCandidates.push({ srv, cascadeId, traj, ppidMatch, workspaceMatch, modified, stepCount });
          }
        } catch { /* ignore */ }
      }

      // Score and sort candidates: PPID > workspace > modified > stepCount
      if (openCandidates.length > 0) {
        openCandidates.sort((a, b) => {
          if (a.ppidMatch !== b.ppidMatch) return a.ppidMatch ? -1 : 1;
          if (a.workspaceMatch !== b.workspaceMatch) return a.workspaceMatch ? -1 : 1;
          if (a.modified !== b.modified) return b.modified - a.modified;
          return b.stepCount - a.stepCount;
        });

        const winner = openCandidates[0];
        bestGlobalId = winner.cascadeId;
        bestGlobalTraj = winner.traj;
        bestGlobalConn = winner.srv;
        bestGlobalTime = winner.modified;  // §C-6: fix 1970-01-01 log

        if (openCandidates.length > 1) {
          logDebug(`Pass 1: ${openCandidates.length} candidates — winner port=${winner.srv.port} ` +
            `ppid=${winner.ppidMatch} ws=${winner.workspaceMatch} modified=${new Date(winner.modified).toISOString()}`);
        }
      }

      // ─── Pass 2: Fallback to GetAllCascadeTrajectories workspace matching ───
      if (!bestGlobalId || !bestGlobalTraj) {
        for (const srv of serversToTry) {
          try {
            const trajectories = await this.rpcCall(
              srv,
              '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
              {},
              (data) => (data.trajectorySummaries as Record<string, any>) || null,
            );
            if (!trajectories) continue;

            for (const [id, traj] of Object.entries(trajectories)) {
              if (this.workspaceUris.length > 0 && traj.workspaces) {
                if (!this.matchesWorkspace(traj)) continue;
              }

              const modified = this.parseModifiedTime(traj.lastModifiedTime);

              if (modified && !isNaN(modified) && modified > bestGlobalTime) {
                bestGlobalTime = modified;
                bestGlobalId = id;
                bestGlobalTraj = traj;
                bestGlobalConn = srv;
              }
            }
          } catch { /* ignore */ }
        }
      }

      if (!bestGlobalId || !bestGlobalTraj || !bestGlobalConn) {
        return null;
      }

      const shortId = bestGlobalId.substring(0, 8);
      logInfo(`Mapped active trajectory ${bestGlobalId} to workspace via port ${bestGlobalConn.port} (last modified: ${new Date(bestGlobalTime).toISOString()})`);

      // ─── Owner Resolution §C-4 + §C-7 ───
      let ownerConn = bestGlobalConn;
      let tokenInfo: StepTokenInfo | null = null;
      let resolvedProg = -1;

      const cached = this.ownerCache.get(bestGlobalId);
      const candidatesToCheck = new Set<ServerConnection>([bestGlobalConn]);
      if (cached) {
        const cachedSrv = serversToTry.find(s => s.port === cached.port);
        if (cachedSrv) candidatesToCheck.add(cachedSrv);
      }

      const quickResults = await Promise.all(
        Array.from(candidatesToCheck).map(async (srv) => ({
          srv,
          info: await this.fetchLatestTokenInfo(srv, bestGlobalId),
        }))
      );

      const validQuick = quickResults.filter(c => c.info !== null);
      if (validQuick.length > 0) {
        const bestQuick = validQuick.sort((a, b) => (b.info!.progressionIndex ?? -1) - (a.info!.progressionIndex ?? -1))[0];
        const prog = bestQuick.info!.progressionIndex ?? -1;

        if (!cached || prog >= cached.lastProgression) {
          ownerConn = bestQuick.srv;
          tokenInfo = bestQuick.info;
          resolvedProg = prog;
          if (cached && ownerConn.port === cached.port) {
            logDebug(`Owner cache hit: port=${ownerConn.port} prog=${prog}`);
          } else {
            logDebug(`Owner switch: from ${cached?.port} to ${ownerConn.port} prog=${prog}`);
          }
        } else {
          logDebug(`Owner cache invalidated: best prog=${prog} < lastProg=${cached.lastProgression}`);
          this.ownerCache.delete(bestGlobalId);
        }
      } else if (cached) {
        logDebug(`Owner cache invalidated: neither bestGlobal nor cached returned data`);
        this.ownerCache.delete(bestGlobalId);
      }

      if (!tokenInfo) {
        // Full owner-resolution scan: pick LS with highest progressionIndex §C-4
        const ownerCandidates = await Promise.all(
          serversToTry.map(async (srv) => ({
            srv,
            info: await this.fetchLatestTokenInfo(srv, bestGlobalId),
          }))
        );

        const freshestOwner = ownerCandidates
          .filter(c => c.info !== null)
          .sort((a, b) => (b.info!.progressionIndex ?? -1) - (a.info!.progressionIndex ?? -1))[0];

        if (freshestOwner) {
          ownerConn = freshestOwner.srv;
          tokenInfo = freshestOwner.info;
          resolvedProg = tokenInfo?.progressionIndex ?? -1;
          logDebug(`Owner resolution fallthrough: port=${ownerConn.port} prog=${resolvedProg} (from ${ownerCandidates.filter(c => c.info).length} repsonding LS)`);
        } else {
          // All LS returned empty — keep the discovery winner
          logDebug(`Full scan failed, treating bestGlobalConn port ${bestGlobalConn.port} as fallback owner.`);
        }
      }

      if (tokenInfo) {
        // Update cache §C-7
        this.ownerCache.set(bestGlobalId, { port: ownerConn.port, csrfToken: ownerConn.csrfToken, lastProgression: resolvedProg });
      }

      // Build snapshot
      const snapshot = this.buildSnapshot(bestGlobalId, bestGlobalTraj, tokenInfo);
      return this.finishSnapshot(snapshot);
    } catch (err) {
      logWarning(`Context fetch error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Parse lastModifiedTime from any format (string, number, {seconds}) */
  private parseModifiedTime(lmt: unknown): number {
    if (!lmt) return 0;
    if (typeof lmt === 'string' || typeof lmt === 'number') {
      return new Date(lmt).getTime();
    }
    if (typeof lmt === 'object' && lmt !== null && 'seconds' in lmt) {
      return parseInt(String((lmt as Record<string, unknown>).seconds), 10) * 1000;
    }
    return 0;
  }

  /** Check if a trajectory summary matches this window's workspace URIs */
  private matchesWorkspace(traj: TrajectorySummary): boolean {
    if (this.workspaceUris.length === 0 || !traj.workspaces) return false;
    for (const ws of traj.workspaces) {
      const uri = ws.workspaceFolderAbsoluteUri || '';
      if (this.workspaceUris.some((u) => uri.includes(u) || u.includes(uri))) {
        return true;
      }
    }
    return false;
  }

  /** Common post-processing: store snapshot, update history, fire callbacks */
  private finishSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
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
  }


  private async fetchLatestTokenInfo(
    connection: ServerConnection,
    cascadeId: string,
  ): Promise<StepTokenInfo | null> {
    // --- Fetch token data ---
    let stepsResult = await this.fetchFromStepsModelUsage(connection, cascadeId);
    let gmResult = await this.fetchFromGeneratorMetadata(connection, cascadeId);

    // Also grab numTotalSteps/numTotalGM for diagnostics and cold start detection
    const trajMeta = await this.rpcCall<Record<string, unknown>>(
      connection,
      '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory',
      { cascadeId },
      (d) => d,
    );
    const numTotalSteps = (trajMeta?.numTotalSteps as number) || (trajMeta?.stepCount as number) || 0;
    const numTotalGM = trajMeta?.numTotalGeneratorMetadata ?? '?';
    const status = trajMeta?.status ?? '?';

    // --- Cold Start Recovery (LoadTrajectory) ---
    // Triggered if the summary says there is activity, but steps/gm are locally empty
    const loadKey = `${connection.port}:${cascadeId}`;
    if (!stepsResult && !gmResult && numTotalSteps > 0 && !this.suppressedLoadTrajectories.has(loadKey)) {
      logInfo(`Triggering one-shot LoadTrajectory for cold owner LS of ${cascadeId}...`);
      await this.rpcCall(connection, '/exa.language_server_pb.LanguageServerService/LoadTrajectory', { cascadeId }, d => d);
      this.suppressedLoadTrajectories.add(loadKey);
      
      // Refetch after forcing load
      stepsResult = await this.fetchFromStepsModelUsage(connection, cascadeId);
      gmResult = await this.fetchFromGeneratorMetadata(connection, cascadeId);
    }

    const stepsProg = stepsResult?.progressionIndex ?? -1;
    const gmProg = gmResult?.progressionIndex ?? -1;
    
    logDebug(`Sources: Steps(prog=${stepsProg}) GM(prog=${gmProg}) | totalSteps=${numTotalSteps} totalGM=${numTotalGM} status=${status}`);

    // Arbitrate: pick freshest source by progression marker, prefer Steps on tie
    if (stepsResult && gmResult) {
      if (stepsProg >= gmProg) {
        logDebug(`→ Using Steps modelUsage (progression ${stepsProg} >= GM ${gmProg})`);
        // Merge estimatedTokensUsed from GM if Steps doesn't have it §C-5
        if (!stepsResult.estimatedTokensUsed && gmResult.estimatedTokensUsed) {
          stepsResult.estimatedTokensUsed = gmResult.estimatedTokensUsed;
          stepsResult.tokenBreakdown = gmResult.tokenBreakdown;
        }
        return stepsResult;
      } else {
        logDebug(`→ Using GM (progression ${gmProg} > Steps ${stepsProg})`);
        return gmResult;
      }
    } else if (stepsResult) {
      return stepsResult;
    } else if (gmResult) {
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

      const stepInfo = meta?.sourceTrajectoryStepInfo as Record<string, unknown> | undefined;
      const progIndex = typeof stepInfo?.stepIndex === 'number' ? stepInfo.stepIndex : i;

      logDebug(
        `Steps[${i}/${steps.length}]: context=${contextTotal.toLocaleString()} ` +
        `(in=${inputTokens.toLocaleString()} cache=${cacheReadTokens.toLocaleString()} out=${outputTokens.toLocaleString()})`,
      );

      return { model, inputTokens, outputTokens, cacheReadTokens, apiProvider, progressionIndex: progIndex };
    }

    return null;
  }

  /**
   * Fetch token data from GeneratorMetadata API (batch-updated, may lag).
   * §C-5: Also extracts estimatedTokensUsed + tokenBreakdown from contextWindowMetadata.
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

      // §C-5: Extract estimatedTokensUsed + tokenBreakdown from contextWindowMetadata
      const cwm = chatModel?.contextWindowMetadata as Record<string, unknown> | undefined;
      let estimatedTokensUsed: number | undefined;
      if (cwm) {
        if (typeof cwm.estimatedTokensUsed === 'number') {
          estimatedTokensUsed = cwm.estimatedTokensUsed;
        } else if (typeof cwm.estimatedTokensUsed === 'string') {
          const parsed = parseInt(cwm.estimatedTokensUsed, 10);
          if (!isNaN(parsed)) estimatedTokensUsed = parsed;
        }
      }
      const tokenBreakdown = cwm?.tokenBreakdown as TokenBreakdown | undefined;

      const stepIndices = gmArray[i].stepIndices as number[] | undefined;
      const progIndex = Array.isArray(stepIndices) && stepIndices.length > 0
        ? Math.max(...stepIndices)
        : i;

      if (estimatedTokensUsed !== undefined) {
        logDebug(`GM[${i}]: estimatedTokensUsed=${estimatedTokensUsed.toLocaleString()}`);
      }

      return { model, inputTokens, outputTokens, cacheReadTokens, apiProvider, estimatedTokensUsed, tokenBreakdown, progressionIndex: progIndex };
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
    let canonicalModelKey = '';

    if (tokenInfo) {
      // Use API provider for display name
      modelName = API_PROVIDER_LABELS[tokenInfo.apiProvider] || tokenInfo.model;

      // Look up context limit from model registry
      if (this.modelRegistry) {
        let matchedModel = this.modelRegistry.getModel(tokenInfo.model);

        if (!matchedModel) {
          const chatModels = this.modelRegistry.getChatModels();
          const tokenModelLC = tokenInfo.model.toLowerCase();
          
          matchedModel = chatModels.find((m) => 
            (m.modelConstant && tokenModelLC.includes(m.modelConstant.toLowerCase())) ||
            (m.id && tokenModelLC.includes(m.id.toLowerCase()))
          );

          if (!matchedModel) {
            const providerLC = tokenInfo.apiProvider.toLowerCase();
            // Fallback: match by provider type
            matchedModel = chatModels.find((m) => {
              const nameLC = m.displayName.toLowerCase();
              if (providerLC.includes('anthropic') && nameLC.includes('claude')) return true;
              if (providerLC.includes('google') && nameLC.includes('gemini')) return true;
              if (providerLC.includes('openai') && nameLC.includes('gpt')) return true;
              return false;
            });
          }

          // Fallback: use highest context model
          if (!matchedModel) {
            matchedModel = chatModels
              .filter((m) => m.maxTokens > 50_000)
              .sort((a, b) => b.maxTokens - a.maxTokens)[0];
          }
        }

        if (matchedModel) {
          modelName = matchedModel.displayName;
          contextLimit = matchedModel.maxTokens;
          canonicalModelKey = (matchedModel.id || matchedModel.modelConstant || tokenInfo.model).toLowerCase();
        } else {
          canonicalModelKey = tokenInfo.model.toLowerCase();
        }
        
        // §C-2: Deterministic override matching — exact > longest substring
        const overrides = require('../config/settings').getConfig().contextLimitOverrides;
        if (overrides) {
          const keys = Object.keys(overrides);
          // Try exact match first
          let overrideKey = keys.find(k => canonicalModelKey === k.toLowerCase());
          if (!overrideKey) {
            // Fallback: longest substring match
            overrideKey = keys
              .filter(k => canonicalModelKey.includes(k.toLowerCase()))
              .sort((a, b) => b.length - a.length)[0];
          }
          if (overrideKey && typeof overrides[overrideKey] === 'number') {
            contextLimit = overrides[overrideKey];
          }
        }
      }
    }

    // Token data — §C-5: prefer server-authoritative estimatedTokensUsed
    const isEstimated = !tokenInfo;
    const rawInput = tokenInfo ? tokenInfo.inputTokens : 0;
    const cacheRead = tokenInfo ? tokenInfo.cacheReadTokens : 0;
    const inputTokens = rawInput + cacheRead;
    const outputTokens = tokenInfo ? tokenInfo.outputTokens : 0;
    const totalTokens = tokenInfo?.estimatedTokensUsed ?? (inputTokens + outputTokens);
    const usedPct = contextLimit > 0 ? (totalTokens / contextLimit) * 100 : 0;

    const status = traj.status || '';
    const isRunning = status.includes('RUNNING');

    if (tokenInfo) {
      const estLabel = tokenInfo.estimatedTokensUsed !== undefined ? ` est=${tokenInfo.estimatedTokensUsed.toLocaleString()}` : '';
      logInfo(
        `Context: ${modelName} — ${totalTokens.toLocaleString()}/${contextLimit.toLocaleString()} ` +
        `(${usedPct.toFixed(1)}%) [in=${tokenInfo.inputTokens.toLocaleString()} + cache=${tokenInfo.cacheReadTokens.toLocaleString()} + out=${tokenInfo.outputTokens.toLocaleString()}${estLabel}]` +
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
                // Ignore "no browser open conversation request found" since it's a normal fallback condition
                if (!parsed.message.includes('no browser open conversation')) {
                  logDebug(`RPC error on ${path}: ${parsed.message}`);
                }
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
