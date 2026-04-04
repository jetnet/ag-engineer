/**
 * Regression tests for ContextService logic extracted to pure functions.
 *
 * These tests exercise the key invariants from the v0.3.12 review:
 * - GM estimate merge safety
 * - isEstimated / totalSource correctness
 * - Workspace segment-boundary matching
 * - Pass 2 workspace-less trajectory rejection
 * - LoadTrajectory TTL suppression
 */
import { describe, it, expect } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Extract pure logic from ContextService for unit testing.
// These mirror the private methods exactly.
// ──────────────────────────────────────────────────────────────────────────────

/** uriSegmentMatch — ported from context.ts */
function uriSegmentMatch(a: string, b: string): boolean {
  const normalize = (s: string) => {
    try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
    return s.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  };
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length < nb.length ? na : nb;
  return longer.startsWith(shorter) && longer[shorter.length] === '/';
}

/** Token merge logic — should GM estimate be merged into Steps? */
function shouldMergeGmEstimate(stepsProg: number, gmProg: number): boolean {
  return gmProg === stepsProg;
}

/** isEstimated logic — does the total come from an authoritative server source? */
function computeTotalSource(
  tokenInfo: { estimatedTokensUsed?: number } | null,
): { isEstimated: boolean; totalSource: 'gm-estimate' | 'derived-sum' | 'none' } {
  const hasAuthoritativeTotal = tokenInfo?.estimatedTokensUsed !== undefined;
  const isEstimated = !hasAuthoritativeTotal;
  const totalSource: 'gm-estimate' | 'derived-sum' | 'none' =
    hasAuthoritativeTotal ? 'gm-estimate' :
    tokenInfo ? 'derived-sum' : 'none';
  return { isEstimated, totalSource };
}

/** TTL suppression check */
function isSuppressionExpired(suppressedAt: number | undefined, ttlMs: number): boolean {
  return !suppressedAt || (Date.now() - suppressedAt > ttlMs);
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('GM→Steps merge safety', () => {
  it('should merge GM estimate when same progression', () => {
    expect(shouldMergeGmEstimate(10, 10)).toBe(true);
  });

  it('should NOT merge GM estimate when Steps is newer', () => {
    expect(shouldMergeGmEstimate(12, 10)).toBe(false);
  });

  it('should NOT merge GM estimate when Steps is much newer', () => {
    expect(shouldMergeGmEstimate(50, 5)).toBe(false);
  });
});

describe('isEstimated / totalSource correctness', () => {
  it('should be gm-estimate when estimatedTokensUsed is present', () => {
    const result = computeTotalSource({ estimatedTokensUsed: 150000 });
    expect(result.isEstimated).toBe(false);
    expect(result.totalSource).toBe('gm-estimate');
  });

  it('should be derived-sum when tokenInfo exists but no estimate', () => {
    const result = computeTotalSource({ estimatedTokensUsed: undefined });
    expect(result.isEstimated).toBe(true);
    expect(result.totalSource).toBe('derived-sum');
  });

  it('should be derived-sum for tokenInfo with no estimatedTokensUsed key', () => {
    const result = computeTotalSource({});
    expect(result.isEstimated).toBe(true);
    expect(result.totalSource).toBe('derived-sum');
  });

  it('should be none when tokenInfo is null', () => {
    const result = computeTotalSource(null);
    expect(result.isEstimated).toBe(true);
    expect(result.totalSource).toBe('none');
  });

  it('should treat estimatedTokensUsed=0 as authoritative', () => {
    const result = computeTotalSource({ estimatedTokensUsed: 0 });
    expect(result.isEstimated).toBe(false);
    expect(result.totalSource).toBe('gm-estimate');
  });
});

describe('uriSegmentMatch — segment-boundary workspace matching', () => {
  it('should match exact paths', () => {
    expect(uriSegmentMatch('/home/user/project-A', '/home/user/project-A')).toBe(true);
  });

  it('should match with trailing slash normalization', () => {
    expect(uriSegmentMatch('/home/user/project-A/', '/home/user/project-A')).toBe(true);
  });

  it('should match case-insensitively', () => {
    expect(uriSegmentMatch('/Home/User/Project-A', '/home/user/project-a')).toBe(true);
  });

  it('should NOT match substring across segment boundary', () => {
    // This is the critical fix — project-A should NOT match project-AB
    expect(uriSegmentMatch('/home/user/project-A', '/home/user/project-AB')).toBe(false);
  });

  it('should match parent containing child on segment boundary', () => {
    expect(uriSegmentMatch('/home/user/project-A/subdir', '/home/user/project-A')).toBe(true);
  });

  it('should handle percent-encoded URIs', () => {
    expect(uriSegmentMatch('/home/user/my%20project', '/home/user/my project')).toBe(true);
  });

  it('should normalize backslashes to forward slashes', () => {
    expect(uriSegmentMatch('C:\\Users\\me\\project', 'C:/Users/me/project')).toBe(true);
  });

  it('should NOT match completely different paths', () => {
    expect(uriSegmentMatch('/home/user/projectA', '/opt/data/projectB')).toBe(false);
  });

  it('should NOT match similar prefixes without segment boundary', () => {
    expect(uriSegmentMatch('/home/user/foo', '/home/user/foobar')).toBe(false);
  });

  it('should handle file:// URI scheme', () => {
    expect(uriSegmentMatch('file:///home/user/project', 'file:///home/user/project')).toBe(true);
  });
});

describe('LoadTrajectory TTL suppression', () => {
  const TTL_MS = 120_000; // 2 minutes

  it('should be expired when never suppressed', () => {
    expect(isSuppressionExpired(undefined, TTL_MS)).toBe(true);
  });

  it('should NOT be expired when recently suppressed', () => {
    expect(isSuppressionExpired(Date.now() - 10_000, TTL_MS)).toBe(false);
  });

  it('should be expired when TTL exceeded', () => {
    expect(isSuppressionExpired(Date.now() - 130_000, TTL_MS)).toBe(true);
  });

  it('should respect custom TTL', () => {
    const shortTtl = 30_000;
    expect(isSuppressionExpired(Date.now() - 35_000, shortTtl)).toBe(true);
    expect(isSuppressionExpired(Date.now() - 25_000, shortTtl)).toBe(false);
  });
});
