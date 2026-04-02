/**
 * Process Discovery — finds the Antigravity language server HTTP port.
 *
 * IMPORTANT: Only probes ports that respond as HTTP/JSON.
 * Does NOT touch HTTPS/gRPC ports used by the IDE chat (which breaks Cascade).
 *
 * Strategy:
 * 1. Find ALL LS processes via `ps` → extract --csrf_token and --workspace_id
 * 2. Log all discovered LS instances with workspace IDs
 * 3. Get all listening ports and probe each with HTTP
 * 4. Return ALL viable connections (caller picks based on cascade ownership)
 *
 * Multi-LS note: Antigravity spawns one LS per workspace. A cascade may
 * be loaded on ANY LS (not necessarily the one matching the current workspace).
 * After LoadTrajectory each LS holds its own in-memory fork.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as http from 'http';
import type { ServerConnection } from '../types';
import { logDebug, logError, logInfo, logSuccess, logWarning } from '../logging/logger';

const execAsync = promisify(exec);

// Only match --csrf_token (not --extension_server_csrf_token)
const CSRF_REGEX = /(?<!extension_server_)--csrf_token[=\s]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/;
const WORKSPACE_ID_REGEX = /--workspace_id\s+(\S+)/;

const PROBE_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

interface LSCandidate {
  pid: number;
  ppid: number;
  csrfToken: string;
  workspaceId: string;
}

/**
 * Main discovery entry point.
 * Returns the first viable connection. Logs all LS instances for diagnostics.
 */
export async function discoverLanguageServer(host: string): Promise<ServerConnection | null> {
  logInfo(`Starting language server discovery... [extension host PID=${process.pid}]`);

  try {
    // Step 1: Find ALL LS processes (ppid for window binding)
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,args | grep -v grep | grep language_server | grep csrf_token || true',
      { timeout: 5000 },
    );

    if (!stdout?.trim()) {
      logWarning('No Antigravity language server processes found.');
      return null;
    }

    const lines = stdout.trim().split('\n');
    const candidates: LSCandidate[] = [];

    for (const line of lines) {
      const pidPpidMatch = line.match(/^\s*(\d+)\s+(\d+)/);
      const csrfMatch = line.match(CSRF_REGEX);
      const wsMatch = line.match(WORKSPACE_ID_REGEX);

      if (pidPpidMatch && csrfMatch) {
        candidates.push({
          pid: parseInt(pidPpidMatch[1], 10),
          ppid: parseInt(pidPpidMatch[2], 10),
          csrfToken: csrfMatch[1],
          workspaceId: wsMatch?.[1] || 'unknown',
        });
      }
    }

    if (candidates.length === 0) {
      logWarning('Could not extract PID or CSRF token from process args.');
      return null;
    }

    // Log all LS instances for diagnostics
    const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none';
    logInfo(`Found ${candidates.length} LS instance(s) [current workspace: ${currentWs}]`);
    for (const c of candidates) {
      logDebug(`  LS PID=${c.pid} PPID=${c.ppid} workspace_id=${c.workspaceId} csrf=${c.csrfToken.substring(0, 8)}… ppidMatch=${c.ppid === process.pid}`);
    }

    // Step 2: Prioritize: workspace match > others (PPID removed — LS parent is utility process, not Extension Host)
    const wsId = 'file_' + currentWs.replace(/[/\-]/g, '_').replace(/^_/, '');
    logInfo(`Workspace matching: wsId="${wsId}" | candidates: ${candidates.map(c => `${c.workspaceId}(${c.workspaceId === wsId ? 'MATCH' : 'no'})`).join(', ')}`);
    const sorted = [...candidates].sort((a, b) => {
      const aWs = a.workspaceId === wsId ? 0 : 1;
      const bWs = b.workspaceId === wsId ? 0 : 1;
      return aWs - bWs;
    });

    // Step 3: Probe all candidates, return first that responds
    for (const candidate of sorted) {
      const ports = await getListeningPorts(candidate.pid);
      if (ports.length === 0) continue;

      logInfo(`PID ${candidate.pid} (ws=${candidate.workspaceId}) has ${ports.length} port(s): ${ports.join(', ')}`);

      for (const port of ports) {
        logDebug(`Probing HTTP ${host}:${port}...`);
        const ok = await httpProbe(host, port, candidate.csrfToken);
        if (ok) {
          logSuccess(`Connected to LS on port ${port} (PID: ${candidate.pid}, ws: ${candidate.workspaceId})`);
          return { host, port, csrfToken: candidate.csrfToken, pid: candidate.pid, ppid: candidate.ppid, workspaceId: candidate.workspaceId };
        }
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
 * Discover ALL language servers that respond to HTTP.
 * Used by ContextService to find which LS owns a particular cascade.
 */
export async function discoverAllLanguageServers(host: string): Promise<ServerConnection[]> {
  const connections: ServerConnection[] = [];

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,args | grep -v grep | grep language_server | grep csrf_token || true',
      { timeout: 5000 },
    );
    if (!stdout?.trim()) return connections;

    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const pidPpidMatch = line.match(/^\s*(\d+)\s+(\d+)/);
      const csrfMatch = line.match(CSRF_REGEX);
      const wsMatch = line.match(WORKSPACE_ID_REGEX);
      if (!pidPpidMatch || !csrfMatch) continue;

      const pid = parseInt(pidPpidMatch[1], 10);
      const ppid = parseInt(pidPpidMatch[2], 10);
      const csrfToken = csrfMatch[1];
      const workspaceId = wsMatch?.[1] || 'unknown';
      const ports = await getListeningPorts(pid);

      for (const port of ports) {
        const ok = await httpProbe(host, port, csrfToken);
        if (ok) {
          connections.push({ host, port, csrfToken, pid, ppid, workspaceId });
          break; // One HTTP port per PID is enough
        }
      }
    }
  } catch { /* best-effort */ }

  return connections;
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
              JSON.parse(data);
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
      if (err.message !== 'socket hang up' && !err.message.includes('ECONNREFUSED')) {
        logDebug(`Port ${port}: ${err.message}`);
      }
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
