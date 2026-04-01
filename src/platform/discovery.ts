/**
 * Process Discovery — finds the Antigravity language server HTTP port.
 *
 * IMPORTANT: Only probes ports that respond as HTTP/JSON.
 * Does NOT touch HTTPS/gRPC ports used by the IDE chat (which breaks Cascade).
 *
 * Strategy:
 * 1. Find LS process via `ps` → extract --csrf_token
 * 2. Get all listening ports for that PID via `ss`
 * 3. Probe each port with HTTP (not HTTPS) GetAllCascadeTrajectories
 * 4. Use the first port that responds with valid JSON
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import type { ServerConnection } from '../types';
import { logDebug, logError, logInfo, logSuccess, logWarning } from '../logging/logger';

const execAsync = promisify(exec);

// Only match --csrf_token (not --extension_server_csrf_token)
const CSRF_REGEX = /(?<!extension_server_)--csrf_token[=\s]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/;

const PROBE_PATH = '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories';

/**
 * Main discovery entry point.
 * Safe: only probes HTTP ports, won't interfere with IDE chat.
 */
export async function discoverLanguageServer(host: string): Promise<ServerConnection | null> {
  logInfo('Starting language server discovery...');

  try {
    // Step 1: Find LS process and extract CSRF token
    const { stdout } = await execAsync(
      'ps -eo pid,args | grep -v grep | grep language_server | grep csrf_token || true',
      { timeout: 5000 },
    );

    if (!stdout?.trim()) {
      logWarning('No Antigravity language server processes found.');
      return null;
    }

    // Parse PID and CSRF from first matching line
    const line = stdout.trim().split('\n')[0];
    const pidMatch = line.match(/^\s*(\d+)/);
    const csrfMatch = line.match(CSRF_REGEX);

    if (!pidMatch || !csrfMatch) {
      logWarning('Could not extract PID or CSRF token from process args.');
      return null;
    }

    const pid = parseInt(pidMatch[1], 10);
    const csrfToken = csrfMatch[1];
    logInfo(`Found LS PID: ${pid}, CSRF: ${csrfToken.substring(0, 8)}...`);

    // Step 2: Get all listening ports for this PID
    const ports = await getListeningPorts(pid);
    if (ports.length === 0) {
      logWarning(`No listening ports found for PID ${pid}`);
      return null;
    }

    logInfo(`PID ${pid} has ${ports.length} listening port(s): ${ports.join(', ')}`);

    // Step 3: Probe each port with HTTP-only (safe, won't break chat)
    for (const port of ports) {
      logDebug(`Probing HTTP ${host}:${port}...`);
      const ok = await httpProbe(host, port, csrfToken);
      if (ok) {
        logSuccess(`Connected to LS HTTP port ${port}`);
        return { host, port, csrfToken, pid };
      }
    }

    logWarning('All ports probed, none responded to HTTP JSON requests.');
    return null;
  } catch (err) {
    logError(`Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Get listening ports for a PID using ss/netstat.
 */
async function getListeningPorts(pid: number): Promise<number[]> {
  const ports: number[] = [];
  try {
    const cmd =
      process.platform === 'darwin'
        ? `lsof -iTCP -sTCP:LISTEN -P -n | grep ${pid}`
        : `ss -tlnp 2>/dev/null | grep "pid=${pid}," || netstat -tlnp 2>/dev/null | grep "${pid}/"`;
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    const matches = stdout.matchAll(/:(\d{4,5})\b/g);
    for (const m of matches) {
      const p = parseInt(m[1], 10);
      if (p > 1024 && p < 65536) ports.push(p);
    }
  } catch {
    // Best-effort
  }
  return [...new Set(ports)];
}

/**
 * HTTP-only probe — sends a lightweight RPC request via plain HTTP.
 * Does NOT try HTTPS (which would interfere with IDE chat connections).
 */
function httpProbe(host: string, port: number, csrfToken: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({});
    const req = http.request(
      {
        hostname: host,
        port,
        path: PROBE_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Codeium-Csrf-Token': csrfToken,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              JSON.parse(data); // Verify it's valid JSON
              resolve(true);
            } catch {
              logDebug(`Port ${port}: HTTP 200 but invalid JSON`);
              resolve(false);
            }
          } else {
            logDebug(`Port ${port}: HTTP ${res.statusCode}`);
            resolve(false);
          }
        });
      },
    );

    req.on('error', (err) => {
      logDebug(`Port ${port}: ${err.message}`);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      logDebug(`Port ${port}: timeout`);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}
