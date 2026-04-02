/**
 * Quota Monitoring Service.
 * Polls GetUserStatus and normalizes into QuotaSnapshot.
 * Emits update events for UI consumption.
 */
import type {
  CreditsInfo,
  ModelQuota,
  QuotaSnapshot,
  QuotaUpdateCallback,
  ServerConnection,
  TokenUsage,
  UserStatusResponse,
} from '../types';
import { fetchUserStatus } from '../platform/rpc-client';
import { logDebug, logDiagnostic, logError, logInfo, logWarning } from '../logging/logger';
import { getConfig } from '../config/settings';

export class QuotaService {
  private lastSnapshot: QuotaSnapshot | null = null;
  private updateCallbacks: QuotaUpdateCallback[] = [];
  private errorCallbacks: ((err: Error) => void)[] = [];

  onUpdate(cb: QuotaUpdateCallback): void {
    this.updateCallbacks.push(cb);
  }

  onError(cb: (err: Error) => void): void {
    this.errorCallbacks.push(cb);
  }

  getLastSnapshot(): QuotaSnapshot | null {
    return this.lastSnapshot;
  }

  /** Resolve a model constant (e.g. MODEL_PLACEHOLDER_M47) to its display label. */
  getModelLabelById(modelId: string): string | undefined {
    if (!this.lastSnapshot) return undefined;
    const lc = modelId.toLowerCase();
    const found = this.lastSnapshot.models.find(m => m.modelId.toLowerCase() === lc);
    return found?.label;
  }

  /**
   * Fetch and normalize quota data from the language server.
   */
  async fetchQuota(connection: ServerConnection): Promise<QuotaSnapshot | null> {
    try {
      const response = await fetchUserStatus(connection.host, connection.port, connection.csrfToken);
      if (!response) return null;

      // Dump raw response for debugging (first few polls only)
      const rawJson = JSON.stringify(response, null, 2);
      const topKeys = Object.keys(response);
      logInfo(`RPC response keys: [${topKeys.join(', ')}]`);
      logDebug(`Raw response (${rawJson.length} chars): ${rawJson.substring(0, 2000)}`);

      const snapshot = this.parseResponse(response);
      this.lastSnapshot = snapshot;
      this.logSnapshot(snapshot);

      for (const cb of this.updateCallbacks) {
        try { cb(snapshot); } catch { /* swallow UI callback errors */ }
      }

      return snapshot;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError(`Quota fetch error: ${error.message}`);
      for (const cb of this.errorCallbacks) {
        try { cb(error); } catch { /* swallow */ }
      }
      return null;
    }
  }

  private parseResponse(response: UserStatusResponse): QuotaSnapshot {
    const config = getConfig();

    // The RPC response wraps everything in a `userStatus` key
    const root = (response as Record<string, unknown>).userStatus as Record<string, unknown> || response;
    const plan = (root.planStatus || response.planStatus) as Record<string, unknown> | undefined;
    const planInfo = plan?.planInfo as Record<string, unknown> | undefined;

    // userTier contains the real plan name (e.g. "Google AI Ultra") and AI credits
    const userTier = root.userTier as Record<string, unknown> | undefined;

    // Parse credits
    let promptCredits: CreditsInfo | undefined;
    const monthlyPrompt = Number(planInfo?.monthlyPromptCredits || 0);
    const availPrompt = Number(plan?.availablePromptCredits || 0);
    if (monthlyPrompt > 0) {
      promptCredits = {
        available: availPrompt,
        monthly: monthlyPrompt,
        usedPercentage: ((monthlyPrompt - availPrompt) / monthlyPrompt) * 100,
        remainingPercentage: (availPrompt / monthlyPrompt) * 100,
      };
    }

    let flowCredits: CreditsInfo | undefined;
    const monthlyFlow = Number(planInfo?.monthlyFlowCredits || 0);
    const availFlow = Number(plan?.availableFlowCredits || 0);
    if (monthlyFlow > 0) {
      flowCredits = {
        available: availFlow,
        monthly: monthlyFlow,
        usedPercentage: ((monthlyFlow - availFlow) / monthlyFlow) * 100,
        remainingPercentage: (availFlow / monthlyFlow) * 100,
      };
    }

    let tokenUsage: TokenUsage | undefined;
    if (promptCredits || flowCredits) {
      const totalAvailable = (promptCredits?.available || 0) + (flowCredits?.available || 0);
      const totalMonthly = (promptCredits?.monthly || 0) + (flowCredits?.monthly || 0);
      tokenUsage = {
        promptCredits,
        flowCredits,
        totalAvailable,
        totalMonthly,
        overallRemainingPercentage: totalMonthly > 0 ? (totalAvailable / totalMonthly) * 100 : 100,
      };
    }

    // Parse per-model quota info
    // Navigate: root.cascadeModelConfigData.clientModelConfigs
    const cascadeData = (root.cascadeModelConfigData || response.cascadeModelConfigData) as Record<string, unknown> | undefined;
    const modelConfigs = (cascadeData?.clientModelConfigs || []) as Array<Record<string, unknown>>;

    logDebug(`Found ${modelConfigs.length} model config(s)`);
    for (const m of modelConfigs) {
      const ma = m.modelOrAlias as Record<string, unknown> | undefined;
      const mid = String(ma?.model || m.modelId || '');
      logDebug(`  config: label="${m.label}" modelId="${mid}"`);
    }

    const models: ModelQuota[] = modelConfigs
      .filter((m) => m.quotaInfo || m.label)
      .map((m) => {
        const now = new Date();
        let resetDate: Date | null = null;
        let timeUntilReset = 'N/A';
        const qi = m.quotaInfo as Record<string, unknown> | undefined;

        if (qi?.resetTime) {
          resetDate = new Date(String(qi.resetTime));
          if (!isNaN(resetDate.getTime())) {
            const diffMs = resetDate.getTime() - now.getTime();
            if (diffMs > 0) {
              const hours = Math.floor(diffMs / 3_600_000);
              const mins = Math.floor((diffMs % 3_600_000) / 60_000);
              timeUntilReset = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
            } else {
              timeUntilReset = 'Now';
            }
          }
        }

        // remainingFraction is 0.0–1.0 in the RPC response.
        // IMPORTANT: When the field is missing/null, the model is DEPLETED (0%).
        // Only when explicitly present and === 1 is the model at full capacity.
        let remainingPct: number;
        if (qi?.remainingFraction != null) {
          remainingPct = Number(qi.remainingFraction) * 100;
        } else if (qi) {
          // quotaInfo exists but no remainingFraction → depleted
          remainingPct = 0;
        } else {
          // No quotaInfo at all → unknown, assume available
          remainingPct = 100;
        }

        // Extract model ID from modelOrAlias.model or modelId
        const modelOrAlias = m.modelOrAlias as Record<string, unknown> | undefined;
        const modelId = String(modelOrAlias?.model || m.modelId || '');

        return {
          label: String(m.label || modelId || 'Unknown'),
          modelId,
          remainingPercentage: remainingPct,
          usedPercentage: 100 - remainingPct,
          resetTime: resetDate,
          timeUntilReset,
          isLow: remainingPct <= config.lowQuotaThreshold,
          isCritical: remainingPct <= config.criticalQuotaThreshold,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    // Plan name: prefer userTier.name ("Google AI Ultra") over planInfo.planName ("Pro")
    const planName = userTier?.name
      ? String(userTier.name)
      : planInfo?.planName
        ? String(planInfo.planName)
        : undefined;

    // Total AI credits from userTier.availableCredits (e.g. GOOGLE_ONE_AI)
    let totalAiCredits: number | undefined;
    const availableCredits = userTier?.availableCredits as Array<Record<string, unknown>> | undefined;
    if (availableCredits && availableCredits.length > 0) {
      totalAiCredits = availableCredits.reduce(
        (sum, c) => sum + Number(c.creditAmount || 0),
        0,
      );
    }

    return {
      timestamp: new Date(),
      models,
      tokenUsage,
      userInfo: planName
        ? {
            planName,
            monthlyPromptCredits: monthlyPrompt,
            availablePromptCredits: availPrompt,
            totalAiCredits,
          }
        : undefined,
    };
  }

  private logSnapshot(snapshot: QuotaSnapshot): void {
    const modelSummary: Record<string, unknown> = {};
    for (const m of snapshot.models) {
      modelSummary[m.label] = `${m.remainingPercentage.toFixed(0)}% (reset: ${m.timeUntilReset})`;
    }

    logDiagnostic('Quota Update', {
      Plan: snapshot.userInfo?.planName || 'N/A',
      'Prompt Credits': snapshot.tokenUsage?.promptCredits
        ? `${snapshot.tokenUsage.promptCredits.available} / ${snapshot.tokenUsage.promptCredits.monthly}`
        : 'N/A',
      'Flow Credits': snapshot.tokenUsage?.flowCredits
        ? `${snapshot.tokenUsage.flowCredits.available} / ${snapshot.tokenUsage.flowCredits.monthly}`
        : 'N/A',
      ...modelSummary,
    });

    // Warn on low quotas
    for (const m of snapshot.models) {
      if (m.isCritical) {
        logWarning(`🔴 CRITICAL: ${m.label} quota at ${m.remainingPercentage.toFixed(0)}%!`);
      } else if (m.isLow) {
        logWarning(`🟡 LOW: ${m.label} quota at ${m.remainingPercentage.toFixed(0)}%`);
      }
    }
  }
}
