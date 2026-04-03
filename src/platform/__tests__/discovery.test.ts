/**
 * Regression tests for discovery module internals.
 *
 * Tests the WORKSPACE_ID_REGEX and CSRF_REGEX parsing.
 */
import { describe, it, expect } from 'vitest';

// Ported from discovery.ts — these are module-level constants
const CSRF_REGEX = /(?<!extension_server_)--csrf_token[=\s]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/;
const WORKSPACE_ID_REGEX = /--workspace_id[=\s]+(\S+)/;

describe('WORKSPACE_ID_REGEX', () => {
  it('should match --workspace_id with space separator', () => {
    const line = '12345 67890 /path/to/language_server --workspace_id file_home_user_project --csrf_token abc123';
    const match = line.match(WORKSPACE_ID_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('file_home_user_project');
  });

  it('should match --workspace_id with = separator', () => {
    const line = '12345 67890 /path/to/language_server --workspace_id=file_home_user_project --csrf_token abc123';
    const match = line.match(WORKSPACE_ID_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('file_home_user_project');
  });

  it('should handle workspace_id with dashes and underscores', () => {
    const line = '12345 67890 /path/to/ls --workspace_id=file_home_user_my-project_v2 --csrf_token abc';
    const match = line.match(WORKSPACE_ID_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('file_home_user_my-project_v2');
  });
});

describe('CSRF_REGEX', () => {
  it('should match --csrf_token with space separator', () => {
    const line = '12345 67890 /path/to/ls --csrf_token abc-123_def.456';
    const match = line.match(CSRF_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('abc-123_def.456');
  });

  it('should match --csrf_token with = separator', () => {
    const line = '12345 67890 /path/to/ls --csrf_token=abc-123_def.456';
    const match = line.match(CSRF_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('abc-123_def.456');
  });

  it('should NOT match --extension_server_csrf_token', () => {
    const line = '12345 67890 /path/to/ls --extension_server_csrf_token abc123';
    const match = line.match(CSRF_REGEX);
    expect(match).toBeNull();
  });

  it('should match --csrf_token but not --extension_server_csrf_token in same line', () => {
    const line = '12345 67890 /path/to/ls --extension_server_csrf_token ext123 --csrf_token main456';
    const match = line.match(CSRF_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('main456');
  });
});
