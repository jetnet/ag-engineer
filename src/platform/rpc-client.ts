/**
 * Connect-RPC HTTP client for the Antigravity language server.
 *
 * SAFETY: Only uses plain HTTP (not HTTPS) to avoid interfering
 * with the IDE's internal chat connections.
 *
 * Protocol (reverse-engineered):
 * - POST to http://127.0.0.1:<port>/<rpc_path>
 * - Headers: X-Codeium-Csrf-Token, Content-Type: application/json
 * - Body: JSON
 * - Response: JSON
 */
import * as http from 'http';
import { logDebug, logError } from '../logging/logger';
import type { UserStatusResponse } from '../types';

const DEFAULT_TIMEOUT = 10_000;
const GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

interface RpcOptions {
  host: string;
  port: number;
  csrfToken: string;
  path?: string;
  body?: Record<string, unknown>;
  timeout?: number;
}

interface RpcResult {
  success: boolean;
  data?: unknown;
  statusCode?: number;
  error?: string;
}

/**
 * Make an RPC call to the language server via HTTP only.
 */
export async function rpcCall(options: RpcOptions): Promise<RpcResult> {
  const {
    host,
    port,
    csrfToken,
    path = GET_USER_STATUS_PATH,
    body = {},
    timeout = DEFAULT_TIMEOUT,
  } = options;

  const bodyStr = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'X-Codeium-Csrf-Token': csrfToken,
    'Content-Length': Buffer.byteLength(bodyStr),
  };

  return makeRequest(host, port, path, headers, bodyStr, timeout);
}

function makeRequest(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string | number>,
  body: string,
  timeout: number,
): Promise<RpcResult> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers,
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve({ success: true, data: parsed, statusCode: res.statusCode });
            } catch {
              resolve({ success: false, statusCode: res.statusCode, error: 'Invalid JSON' });
            }
          } else {
            resolve({
              success: false,
              statusCode: res.statusCode,
              error: `HTTP ${res.statusCode}`,
            });
          }
        });
      },
    );

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Quick probe — check if a port responds to GetUserStatus via HTTP.
 */
export async function rpcProbe(host: string, port: number, csrfToken: string): Promise<boolean> {
  logDebug(`Probing ${host}:${port}...`);
  const result = await rpcCall({
    host,
    port,
    csrfToken,
    body: { metadata: { ideName: 'antigravity-engineer', ideVersion: '0.1.0' } },
    timeout: 5000,
  });
  if (result.success) {
    logDebug(`Probe ${host}:${port} succeeded`);
    return true;
  }
  logDebug(`Probe ${host}:${port} failed: ${result.error} (status: ${result.statusCode})`);
  return false;
}

/**
 * Fetch user status (quotas, model configs, credits).
 */
export async function fetchUserStatus(
  host: string,
  port: number,
  csrfToken: string,
): Promise<UserStatusResponse | null> {
  const result = await rpcCall({
    host,
    port,
    csrfToken,
    body: { metadata: { ideName: 'antigravity-engineer', ideVersion: '0.1.0' } },
  });

  if (!result.success) {
    logError(`GetUserStatus failed: ${result.error}`);
    return null;
  }

  return result.data as UserStatusResponse;
}
