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
 * v0.3.10 — Architecture cleanup:
 *  - Collect-and-rank Pass 1 (workspace → freshness → stepCount)
 *  - Owner-resolution Pass 2 (pick LS with highest progressionIndex)
 *  - Owner caching (skip full multi-LS scan when cache is still valid)
 *  - estimatedTokensUsed from contextWindowMetadata
 *  - Deterministic override matching (exact > longest substring)
 *  - bestGlobalTime fix for Pass 1
 *  - LoadTrajectory only fires after owner resolution (no side-effect probing)
 */
import type { ContextSnapshot, ContextUpdateCallback, ServerConnection } from '../types';
import { logDebug, logInfo, logWarning } from '../logging/logger';
import type { ModelRegistry } from './model-registry';
import type { QuotaService } from './quota';
import { rpcCall as sharedRpcCall } from '../platform/rpc-client';
import * as vscode from 'vscode';


/** Model placeholder → display name mapping (from apiProvider) */
const API_PROVIDER_LABELS: Record<string, string> = {
  API_PROVIDER_ANTHROPIC_VERTEX: 'Claude',
  API_PROVIDER_ANTHROPIC: 'Claude',
  API_PROVIDER_GOOGLE: 'Gemini',
  API_PROVIDER_GOOGLE_VERTEX: 'Gemini',
  API_PROVIDER_GOOGLE_GEMINI: 'Gemini Flash',
  API_PROVIDER_OPENAI: 'GPT',
  API_PROVIDER_OSS: 'GPT-OSS',
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
  /** For extensive debugging */
  cwmDump?: unknown;
  /** Optional breakdown by category */
  tokenBreakdown?: TokenBreakdown;
  /** Index for arbitration */
  progressionIndex?: number;
  /** Set to true if any step in this generator run matches image generation schemas */
  hasImageGeneration?: boolean;
  hasWebSearch?: boolean;
  hasTerminalCommand?: boolean;
  hasFileRead?: boolean;
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
  private quotaService: QuotaService | null = null;
  /** TTL-based LoadTrajectory suppression: loadKey → timestamp (ms) */
  private suppressedLoadTrajectories = new Map<string, number>();

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

  setQuotaService(service: QuotaService): void {
    this.quotaService = service;
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
          
          require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', `PASS 1 RESP (port ${srv.port}): ${JSON.stringify(resp)}\n`);

          if (resp && resp.cascadeId) {
            const cascadeId = resp.cascadeId as string;
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

            openCandidates.push({ srv, cascadeId, traj, workspaceMatch, modified, stepCount });
          }
        } catch { /* ignore */ }
      }

      // Score and sort candidates: workspace > modified > stepCount
      if (openCandidates.length > 0) {
        openCandidates.sort((a, b) => {
          if (a.workspaceMatch !== b.workspaceMatch) return a.workspaceMatch ? -1 : 1;
          if (a.modified !== b.modified) return b.modified - a.modified;
          return b.stepCount - a.stepCount;
        });

        // DISABLE PASS 1 WINNER ASSIGNMENT TO FORCE PASS 2 LAST-MODIFIED SORTING!
        // The language server on Windows is known to return stale cascades here.
        /*
        const winner = openCandidates[0];
        bestGlobalId = winner.cascadeId;
        bestGlobalTraj = winner.traj;
        bestGlobalConn = winner.srv;
        bestGlobalTime = winner.modified;  // §C-6: fix 1970-01-01 log
        */

        if (openCandidates.length > 1) {
          logDebug(`Pass 1: ${openCandidates.length} candidates — winner port=${openCandidates[0].srv.port} ` +
            `ws=${openCandidates[0].workspaceMatch} modified=${new Date(openCandidates[0].modified).toISOString()}`);
        }
      }

      // ─── Pass 2: Fallback to GetAllCascadeTrajectories workspace matching ───
      let fallbackGlobalTime = 0;
      let fallbackGlobalId = '';
      let fallbackGlobalTraj: TrajectorySummary | null = null;
      let fallbackGlobalConn: ServerConnection | null = null;

      let debugDump = `--- PASS 2 TICK ---\n`;

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
              if (this.workspaceUris.length > 0) {
                if (!traj.workspaces || traj.workspaces.length === 0) {
                   continue;
                }
              }

              const modified = this.parseModifiedTime(traj.lastModifiedTime);
              debugDump += `Traj: ${id.substring(0,8)} - Mod: ${modified} (raw: ${JSON.stringify(traj.lastModifiedTime)}) WS: ${traj.workspaces?.[0]?.workspaceFolderAbsoluteUri}\n`;

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

      debugDump += `WINNER PASS 2: ${bestGlobalId.substring(0,8)} at ${bestGlobalTime}\n`;

      if (!bestGlobalId || !bestGlobalTraj || !bestGlobalConn) {
        require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', debugDump + 'RETURNED NULL\n');
        return null;
      }
      
      require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', debugDump);

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
          info: await this.fetchLatestTokenInfo(srv, bestGlobalId, false),
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
            // Clear LoadTrajectory suppression for this cascade — owner changed, re-arm recovery
            if (cached) {
              for (const key of this.suppressedLoadTrajectories.keys()) {
                if (key.endsWith(`:${bestGlobalId}`)) {
                  this.suppressedLoadTrajectories.delete(key);
                }
              }
            }
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
            info: await this.fetchLatestTokenInfo(srv, bestGlobalId, false),
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

      if (!tokenInfo) {
        logDebug(`No token info found during owner resolution, trying to load trajectory on winning owner port ${ownerConn.port}...`);
        tokenInfo = await this.fetchLatestTokenInfo(ownerConn, bestGlobalId, true);
      }
      
      require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', `TOKEN INFO: ${tokenInfo ? JSON.stringify(tokenInfo) : 'NULL'}\n`);

      if (tokenInfo) {
        // Update cache §C-7
        this.ownerCache.set(bestGlobalId, { port: ownerConn.port, csrfToken: ownerConn.csrfToken, lastProgression: resolvedProg });
      }

      // Build snapshot
      const snapshot = this.buildSnapshot(bestGlobalId, bestGlobalTraj, tokenInfo);
      require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', `SNAPSHOT MODEL: ${snapshot.model} TOTAL: ${snapshot.totalTokens}\n\n`);
      return this.finishSnapshot(snapshot);
    } catch (err) {
      require('fs').appendFileSync('C:/Users/Dmitry/Desktop/ag_debug.txt', `ERROR: ${err}\n\n`);
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
      if (this.workspaceUris.some((u) => this.uriSegmentMatch(uri, u))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Normalize and compare URI paths by segments (not substring).
   * Prevents false matches like /home/user/project-A matching /home/user/project-AB.
   * Allows prefix match only on '/' segment boundary.
   */
  private uriSegmentMatch(a: string, b: string): boolean {
    const normalize = (s: string) => {
      try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
      return s.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
    };
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return true;
    // Allow prefix match only on segment boundary
    const longer = na.length >= nb.length ? na : nb;
    const shorter = na.length < nb.length ? na : nb;
    return longer.startsWith(shorter) && longer[shorter.length] === '/';
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
    allowLoadTrajectory: boolean = false
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
    // Triggered if steps/gm are locally empty (e.g. trajectory not found)
    // Suppression uses TTL to allow re-arm after conversation goes cold and comes back
    const loadKey = `${connection.port}:${cascadeId}`;
    const loadTtlMs = require('../config/settings').getConfig().loadTrajectoryTtlSeconds * 1000;
    const suppressedAt = this.suppressedLoadTrajectories.get(loadKey);
    const suppressionExpired = !suppressedAt || (Date.now() - suppressedAt > loadTtlMs);
    if (!stepsResult && !gmResult && allowLoadTrajectory && suppressionExpired) {
      logInfo(`Triggering LoadTrajectory for cold owner LS of ${cascadeId}${suppressedAt ? ' (TTL expired)' : ''}...`);
      await this.rpcCall(connection, '/exa.language_server_pb.LanguageServerService/LoadTrajectory', { cascadeId }, d => d);
      this.suppressedLoadTrajectories.set(loadKey, Date.now());
      
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
        // Merge estimatedTokensUsed from GM only if same progression (safe cross-reference)
        // When Steps is ahead of GM, the GM estimate belongs to an older turn and would be stale
        if (!stepsResult.estimatedTokensUsed && gmResult.estimatedTokensUsed && gmProg === stepsProg) {
          stepsResult.estimatedTokensUsed = gmResult.estimatedTokensUsed;
          stepsResult.tokenBreakdown = gmResult.tokenBreakdown;
          logDebug(`  Merged GM estimate (same prog=${gmProg}): ${gmResult.estimatedTokensUsed.toLocaleString()}`);
        } else if (!stepsResult.estimatedTokensUsed && gmResult.estimatedTokensUsed) {
          logDebug(`  Skipped stale GM estimate (gmProg=${gmProg} < stepsProg=${stepsProg})`);
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
      
      // Determine if there is image generation in any step leading up to this points
      let hasImageGeneration = false;
      let hasWebSearch = false;
      let hasTerminalCommand = false;
      let hasFileRead = false;
      
      for (const step of gmArray) {
        const stepType = String(step.stepType || '').toLowerCase();
        const genModel = String(step.generatorModelName || '').toLowerCase();
        
        if (stepType.includes('image_generation') || genModel.includes('imagen')) {
          hasImageGeneration = true;
        }
        if (stepType.includes('search') || stepType.includes('web')) {
          hasWebSearch = true;
        }
        if (stepType.includes('cmd') || stepType.includes('command') || stepType.includes('bash') || stepType.includes('terminal')) {
          hasTerminalCommand = true;
        }
        if (stepType.includes('read_file') || stepType.includes('list_dir') || stepType.includes('view') || stepType.includes('read')) {
          hasFileRead = true;
        }
      }

      return { 
        model, 
        inputTokens, 
        outputTokens, 
        cacheReadTokens, 
        apiProvider, 
        estimatedTokensUsed, 
        cwmDump: cwm,
        tokenBreakdown, 
        progressionIndex: progIndex,
        hasImageGeneration,
        hasWebSearch,
        hasTerminalCommand,
        hasFileRead
      };
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
    
    let modelWindow = 200_000;
    let runtimeLimit = 200_000;
    let softLimit = 160_000;

    if (tokenInfo) {
      // Use API provider for display name (базовый fallback)
      modelName = API_PROVIDER_LABELS[tokenInfo.apiProvider] || tokenInfo.model;

      // §C-NEW: Authoritative model name from QuotaService (GetUserStatus RPC)
      // Ищем точное совпадение по modelId, затем fuzzy-поиск по apiProvider среди моделей квоты
      const quotaLabel = this.quotaService?.getModelLabelById(tokenInfo.model);
      if (quotaLabel) {
        modelName = quotaLabel;
        logDebug(`Model resolved via QuotaService (exact): "${tokenInfo.model}" → "${quotaLabel}"`);
      } else if (this.quotaService && tokenInfo.model.startsWith('MODEL_PLACEHOLDER_')) {
        // Fallback: найти любую модель в квоте по провайдеру
        const quotaSnap = this.quotaService.getLastSnapshot();
        if (quotaSnap && quotaSnap.models.length > 0) {
          const provLC = tokenInfo.apiProvider.toLowerCase();
          // Улучшенный выбор модели квоты: пытаемся найти точное семейство в названии модели или провайдера
          const tokenModelLC = tokenInfo.model.toLowerCase();
          const providerModel = quotaSnap.models.find(m => {
            const lb = m.label.toLowerCase();
            
            if (provLC.includes('anthropic') || tokenModelLC.includes('claude')) {
              // Если это антропик, проверяем специфичные слова
              if (tokenModelLC.includes('opus') && lb.includes('opus')) return true;
              if (tokenModelLC.includes('sonnet') && lb.includes('sonnet')) return true;
              if (lb.includes('claude')) return true; // generic fallback
            }
            if (provLC.includes('google') || tokenModelLC.includes('gemini')) {
              // Если это гугл, проверяем Flash или Pro
              if (tokenModelLC.includes('flash') && lb.includes('flash')) return true;
              if (tokenModelLC.includes('pro') && lb.includes('pro')) return true;
              // Если точной информации нет, но модель квоты flash/pro, вернем первое совпадение
              if (lb.includes('gemini') || lb.includes('flash') || lb.includes('pro')) return true;
            }
            if (provLC.includes('openai') || provLC.includes('oss') || tokenModelLC.includes('gpt')) {
              if (lb.includes('gpt')) return true;
            }
            return false;
          });
          if (providerModel) {
            modelName = providerModel.label;
            logDebug(`Model resolved via QuotaService (smart fallback): "${tokenInfo.model}" + "${tokenInfo.apiProvider}" → "${providerModel.label}"`);
          }
        }
      }

      // Look up context limit from model registry
      if (this.modelRegistry) {
        const tokenModelLC = tokenInfo.model.toLowerCase();
        logDebug(`Model matching: tokenInfo.model="${tokenInfo.model}" apiProvider="${tokenInfo.apiProvider}"`);

        // 1. Exact registry lookup by ID
        let matchedModel = this.modelRegistry.getModel(tokenInfo.model);

        // 1b. If quota gave us a label, try matching by that label for context limit
        if (!matchedModel && quotaLabel) {
          matchedModel = this.modelRegistry.getModel(quotaLabel);
        }

        if (!matchedModel) {
          const chatModels = this.modelRegistry.getChatModels();

          // 2. Exact modelConstant match
          matchedModel = chatModels.find((m) =>
            m.modelConstant && m.modelConstant.toLowerCase() === tokenModelLC
          );

          // 3. Bidirectional substring — longest match wins to avoid
          //    "gemini-2.5-flash" matching when "gemini-3-flash" is available
          if (!matchedModel) {
            const substringMatches = chatModels.filter((m) =>
              (m.modelConstant && (tokenModelLC.includes(m.modelConstant.toLowerCase()) || m.modelConstant.toLowerCase().includes(tokenModelLC))) ||
              (m.id && (tokenModelLC.includes(m.id.toLowerCase()) || m.id.toLowerCase().includes(tokenModelLC)))
            );
            if (substringMatches.length > 0) {
              // Priority: 1. Higher version number 2. Longest ID match
              matchedModel = substringMatches.sort((a, b) => {
                // Version extraction (e.g. "3.1" -> 3.1)
                const getVer = (m: any) => {
                  const match = (m.displayName || m.id || "").match(/(\d+\.?\d*)/);
                  return match ? parseFloat(match[1]) : 0;
                };
                const vA = getVer(a);
                const vB = getVer(b);
                if (Math.abs(vA - vB) > 0.01) return vB - vA; // Higher version first

                const aLen = Math.max(a.modelConstant?.length || 0, a.id?.length || 0);
                const bLen = Math.max(b.modelConstant?.length || 0, b.id?.length || 0);
                return bLen - aLen;
              })[0];
            }
          }

          // 4. Provider-type fallback — but pick the FIRST exact provider match,
          //    not just any model of the same family
          if (!matchedModel) {
            const providerLC = tokenInfo.apiProvider.toLowerCase();
            const providerMatches = chatModels.filter((m) => {
              if (providerLC.includes('anthropic') && m.apiProvider?.toLowerCase().includes('anthropic')) return true;
              if (providerLC.includes('google') && m.apiProvider?.toLowerCase().includes('google')) return true;
              if (providerLC.includes('openai') && m.apiProvider?.toLowerCase().includes('openai')) return true;
              return false;
            });

            // Within same provider, pick best match:
            // 1. Higher version (3.0 > 2.5)
            // 2. Highest tokens
            if (providerMatches.length > 0) {
              matchedModel = providerMatches.sort((a, b) => {
                const getVer = (m: any) => {
                  const match = (m.displayName || m.id || "").match(/(\d+\.?\d*)/);
                  return match ? parseFloat(match[1]) : 0;
                };
                const vA = getVer(a);
                const vB = getVer(b);
                if (Math.abs(vA - vB) > 0.01) return vB - vA; // Higher version first
                return b.maxTokens - a.maxTokens;
              })[0];
              logDebug(`Model fallback: matched by provider "${providerLC}" → ${matchedModel.displayName}`);
            }
          }

          // 5. Last resort: highest context model
          if (!matchedModel) {
            matchedModel = chatModels
              .filter((m) => m.maxTokens > 50_000)
              .sort((a, b) => b.maxTokens - a.maxTokens)[0];
          }
        }

        if (matchedModel) {
          logDebug(`Model resolved: "${matchedModel.displayName}" (id=${matchedModel.id}, const=${matchedModel.modelConstant}, limit=${matchedModel.maxTokens})`);
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
      modelWindow = contextLimit; // Default from registry
      // Fallback: Hardcoded limits for well-known model families if registry failed or gave wrong limit
      const mlc = modelName.toLowerCase();
      if (mlc.includes('gemini') || mlc.includes('flash') || mlc.includes('pro')) {
        modelWindow = 1048576;
      } else if (mlc.includes('opus') || mlc.includes('sonnet')) {
        modelWindow = 200000;
      } else if (mlc.includes('gpt')) {
        modelWindow = 120000;
      }
      
      // IDE enforces maximum 200K runtime limit
      runtimeLimit = 200000;
      softLimit = 160000;
    }

    // Token data — §C-5: prefer server-authoritative estimatedTokensUsed
    const hasAuthoritativeTotal = tokenInfo?.estimatedTokensUsed !== undefined;
    const isEstimated = !hasAuthoritativeTotal;
    const rawInput = tokenInfo ? tokenInfo.inputTokens : 0;
    const cacheRead = tokenInfo ? tokenInfo.cacheReadTokens : 0;
    const inputTokens = rawInput + cacheRead;
    const outputTokens = tokenInfo ? tokenInfo.outputTokens : 0;
    const totalTokens = tokenInfo?.estimatedTokensUsed ?? (inputTokens + outputTokens);
    const totalSource: 'gm-estimate' | 'derived-sum' | 'none' =
      hasAuthoritativeTotal ? 'gm-estimate' :
      tokenInfo ? 'derived-sum' : 'none';
    const usedPct = runtimeLimit > 0 ? (totalTokens / runtimeLimit) * 100 : 0;

    const status = traj.status || '';
    const isRunning = status.includes('RUNNING');

    if (tokenInfo) {
      const estLabel = tokenInfo.estimatedTokensUsed !== undefined ? ` est=${tokenInfo.estimatedTokensUsed.toLocaleString()}` : '';
      const rawIdLabel = modelName.includes(tokenInfo.model) ? '' : ` [id:${tokenInfo.model}]`;
      const imgLabel = tokenInfo.hasImageGeneration ? ' 📷' : '';
      logInfo(
        `Context: ${modelName}${rawIdLabel} — ${totalTokens.toLocaleString()}/${contextLimit.toLocaleString()} ` +
        `(${usedPct.toFixed(1)}%) [in=${tokenInfo.inputTokens.toLocaleString()} + cache=${tokenInfo.cacheReadTokens.toLocaleString()} + out=${tokenInfo.outputTokens.toLocaleString()}${estLabel}] ` +
        `src=${totalSource}${imgLabel}` +
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
      contextLimit: runtimeLimit,
      runtimeLimit,
      softLimit,
      modelWindow,
      usedPercentage: Math.min(usedPct, 100),
      remainingTokens: Math.max(runtimeLimit - totalTokens, 0),
      isEstimated,
      timestamp: new Date(),
      totalSource,
      cwmDump: tokenInfo?.cwmDump,
      tokenBreakdown: tokenInfo?.tokenBreakdown,
      progressionIndex: tokenInfo?.progressionIndex,
      hasImageGeneration: tokenInfo?.hasImageGeneration,
      hasWebSearch: tokenInfo?.hasWebSearch,
      hasTerminalCommand: tokenInfo?.hasTerminalCommand,
      hasFileRead: tokenInfo?.hasFileRead,
      isRunning
    };
  }

  /**
   * Generic RPC call helper — delegates to shared rpc-client.ts transport
   * which uses keepAlive agent for connection reuse across polls.
   */
  private async rpcCall<T>(
    connection: ServerConnection,
    path: string,
    payload: Record<string, unknown>,
    extract: (data: Record<string, unknown>) => T | null,
  ): Promise<T | null> {
    const result = await sharedRpcCall({
      host: connection.host,
      port: connection.port,
      csrfToken: connection.csrfToken,
      path,
      body: payload,
      timeout: 15000,
    });

    if (!result.success || !result.data) {
      return null;
    }

    try {
      const parsed = result.data as Record<string, unknown>;
      if (parsed.code && parsed.message) {
        // Ignore "no browser open conversation request found" — normal fallback condition
        if (!String(parsed.message).includes('no browser open conversation')) {
          logDebug(`RPC error on ${path}: ${parsed.message}`);
        }
        return null;
      }
      return extract(parsed);
    } catch {
      return null;
    }
  }
}
