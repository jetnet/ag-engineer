/**
 * Core types for Antigravity Engineer extension.
 * All interfaces for RPC responses, internal state, and UI models.
 */

// === Discovery ===

export interface ServerConnection {
  host: string;
  port: number;
  csrfToken: string;
  workspaceId?: string;
  pid: number;
}

export interface ProcessCandidate {
  pid: number;
  ppid: number;
  extensionPort: number;
  csrfToken: string;
  extensionServerCsrfToken?: string;
  workspaceId?: string;
}

// === RPC Response Types ===

export interface UserStatusResponse {
  planStatus?: PlanStatus;
  cascadeModelConfigData?: CascadeModelConfigData;
  [key: string]: unknown;
}

export interface PlanStatus {
  planInfo?: PlanInfo;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
  [key: string]: unknown;
}

export interface PlanInfo {
  planName?: string;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  knowledgeBaseEnabled?: boolean;
  canBuyMoreCredits?: boolean;
  [key: string]: unknown;
}

export interface CascadeModelConfigData {
  clientModelConfigs?: ClientModelConfig[];
  [key: string]: unknown;
}

export interface ClientModelConfig {
  label?: string;
  modelId?: string;
  quotaInfo?: QuotaInfo;
  [key: string]: unknown;
}

export interface QuotaInfo {
  resetTime?: string;
  remainingPercentage?: number;
  usedPercentage?: number;
  [key: string]: unknown;
}

// === Normalized Internal Models ===

export interface ModelQuota {
  label: string;
  modelId: string;
  remainingPercentage: number;
  usedPercentage: number;
  resetTime: Date | null;
  timeUntilReset: string;
  isLow: boolean;
  isCritical: boolean;
}

export interface CreditsInfo {
  available: number;
  monthly: number;
  usedPercentage: number;
  remainingPercentage: number;
}

export interface TokenUsage {
  promptCredits?: CreditsInfo;
  flowCredits?: CreditsInfo;
  totalAvailable: number;
  totalMonthly: number;
  overallRemainingPercentage: number;
}

export interface QuotaSnapshot {
  timestamp: Date;
  models: ModelQuota[];
  tokenUsage?: TokenUsage;
  userInfo?: {
    planName: string;
    monthlyPromptCredits?: number;
    availablePromptCredits?: number;
    totalAiCredits?: number;
  };
}

export interface ContextSnapshot {
  conversationId?: string;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextLimit: number;
  usedPercentage: number;
  remainingTokens: number;
  isEstimated: boolean;
  timestamp: Date;
}

export interface DiagnosticInfo {
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error';
  discoveredPort?: number;
  discoveredPid?: number;
  discoveredWorkspaceId?: string;
  lastSuccessfulPoll?: Date;
  lastError?: string;
  pollCount: number;
  failCount: number;
}

// === Events ===

export type QuotaUpdateCallback = (snapshot: QuotaSnapshot) => void;
export type ContextUpdateCallback = (snapshot: ContextSnapshot) => void;
export type DiagnosticUpdateCallback = (info: DiagnosticInfo) => void;
export type ConnectionUpdateCallback = (conn: ServerConnection | null) => void;
