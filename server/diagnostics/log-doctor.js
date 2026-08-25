// Intelligent Server & Docker Diagnostic Engine (Log Doctor)
// Scans multi-layer logs (OS, Nginx/Web, Docker, Security, Kernel) and produces actionable insights.

class LogDoctor {
  static analyze(logs = []) {
    if (!Array.isArray(logs) || logs.length === 0) {
      return {
        healthScore: 100,
        status: 'healthy',
        issuesCount: 0,
        issues: [],
        summary: { critical: 0, warning: 0, security: 0, info: 0 },
      };
    }

    const issues = [];
    const seenIssueKeys = new Set();

    // Aggregators for frequency/threshold analysis
    const sshFailedIps = new Map(); // ip -> count
    const nginx502Upstreams = new Map(); // upstream -> count
    const oomKills = [];
    const portCollisions = new Map(); // port -> count
    const diskErrors = [];
    const dbRefusals = new Map(); // db target -> count

    for (const l of logs) {
      const msg = String(l.message || '');
      const lower = msg.toLowerCase();
      const timestamp = l.timestamp || Date.now();
      const source = l.source || (l.containerName ? `container:${l.containerName}` : 'system');

      // 1. Linux Kernel OOM Killer Detection
      if (lower.includes('out of memory: kill process') || lower.includes('invoked oom-killer') || lower.includes('killed process')) {
        const procMatch = msg.match(/killed process \d+ \((.*?)\)/i) || msg.match(/kill process \d+ \((.*?)\)/i);
        const procName = procMatch ? procMatch[1] : (l.containerName || 'process');
        oomKills.push({ procName, timestamp, raw: msg });
      }

      // 2. Nginx / Web Proxy Upstream 502 / 504 Failures
      if (lower.includes('connect() failed') && (lower.includes('111: connection refused') || lower.includes('connection refused'))) {
        const upMatch = msg.match(/while connecting to upstream, client: .*, server: .*, request: ".*", upstream: "(.*?)"/i) ||
                        msg.match(/upstream: "(.*?)"/i);
        const upstream = upMatch ? upMatch[1] : 'upstream backend';
        nginx502Upstreams.set(upstream, (nginx502Upstreams.get(upstream) || 0) + 1);
      }

      // 3. Port & Socket Collisions (EADDRINUSE / address already in use)
      if (lower.includes('address already in use') || lower.includes('eaddrinuse') || lower.includes('bind() to 0.0.0.0:') || lower.includes('port is already allocated')) {
        const portMatch = msg.match(/:(\d{2,5})/);
        const port = portMatch ? portMatch[1] : 'unknown';
        portCollisions.set(port, (portCollisions.get(port) || 0) + 1);
      }

      // 4. Disk & Filesystem Pressure
      if (lower.includes('no space left on device') || lower.includes('read-only file system') || lower.includes('disk quota exceeded')) {
        diskErrors.push({ timestamp, raw: msg, source });
      }

      // 5. SSH Brute-Force & Auth Attacks
      if (lower.includes('failed password for') || lower.includes('authentication failure')) {
        const ipMatch = msg.match(/from (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (ipMatch) {
          const ip = ipMatch[1];
          sshFailedIps.set(ip, (sshFailedIps.get(ip) || 0) + 1);
        }
      }

      // 6. Database Connection Failures
      if ((lower.includes('econnrefused') || lower.includes('connection refused')) && (msg.includes('5432') || msg.includes('3306') || msg.includes('27017') || msg.includes('6379') || lower.includes('postgres') || lower.includes('mysql') || lower.includes('redis') || lower.includes('mongo'))) {
        const dbName = lower.includes('5432') || lower.includes('postgres') ? 'PostgreSQL' :
                       (lower.includes('3306') || lower.includes('mysql') ? 'MySQL' :
                       (lower.includes('6379') || lower.includes('redis') ? 'Redis' : 'Database'));
        dbRefusals.set(dbName, (dbRefusals.get(dbName) || 0) + 1);
      }

      // 7. Critical Application Crashes / Panics
      if (lower.includes('panic:') || lower.includes('fatal error: runtime: out of memory') || lower.includes('uncaughtexception')) {
        const key = `panic_${l.containerName || 'app'}`;
        if (!seenIssueKeys.has(key)) {
          seenIssueKeys.add(key);
          issues.push({
            id: key,
            category: 'application',
            severity: 'critical',
            title: `Application Crash / Fatal Panic in [${l.containerName || 'service'}]`,
            description: `A fatal runtime panic or unhandled exception halted execution: "${msg.slice(0, 140)}"`,
            evidence: msg.slice(0, 240),
            timestamp,
            action: {
              label: 'Inspect Container Details',
              page: 'resources',
              tab: 'containers',
              actionType: 'navigate',
            },
          });
        }
      }
    }

    // Process Aggregated Diagnostics

    // 1. OOM Issues
    if (oomKills.length > 0) {
      const latest = oomKills[oomKills.length - 1];
      issues.push({
        id: 'oom_killer_detected',
        category: 'memory',
        severity: 'critical',
        title: `Linux OOM Killer Terminated [${latest.procName}]`,
        description: `Linux Kernel ran out of physical memory and invoked the OOM Killer (${oomKills.length} event${oomKills.length > 1 ? 's' : ''}). Process "${latest.procName}" was killed to protect the operating system.`,
        evidence: latest.raw,
        timestamp: latest.timestamp,
        action: {
          label: '⚡ Adjust Memory Limits / Restart',
          page: 'resources',
          tab: 'containers',
          actionType: 'navigate',
        },
      });
    }

    // 2. Nginx Upstream Failures
    for (const [upstream, count] of nginx502Upstreams.entries()) {
      issues.push({
        id: `nginx_502_${upstream}`,
        category: 'web_proxy',
        severity: 'critical',
        title: `Nginx 502 Bad Gateway: Upstream [${upstream}] Unreachable`,
        description: `Nginx failed to connect to upstream server "${upstream}" (${count} failed request${count > 1 ? 's' : ''}). The backend container or service is likely stopped, restarting, or listening on a different port.`,
        evidence: `connect() failed (111: Connection refused) while connecting to ${upstream}`,
        timestamp: Date.now(),
        action: {
          label: '🔄 Check & Restart Backend Stacks',
          page: 'deploy',
          tab: 'compose',
          actionType: 'navigate',
        },
      });
    }

    // 3. Port Collisions
    for (const [port, count] of portCollisions.entries()) {
      issues.push({
        id: `port_conflict_${port}`,
        category: 'network',
        severity: 'warning',
        title: `Port Conflict Detected on Port :${port}`,
        description: `A service failed to bind to port ${port} because another process or container is already occupying it (${count} attempt${count > 1 ? 's' : ''}).`,
        evidence: `EADDRINUSE / bind: address already in use :${port}`,
        timestamp: Date.now(),
        action: {
          label: '🔍 Inspect Ports & Processes',
          page: 'server-console',
          tab: 'manage',
          actionType: 'navigate',
        },
      });
    }

    // 4. Disk Pressure
    if (diskErrors.length > 0) {
      issues.push({
        id: 'disk_space_exhausted',
        category: 'storage',
        severity: 'critical',
        title: 'Storage Full: "No space left on device"',
        description: `Host or container filesystem has 0 bytes free. Docker cannot write layers or logs, which can freeze running containers and database write operations.`,
        evidence: diskErrors[0].raw,
        timestamp: diskErrors[0].timestamp,
        action: {
          label: '🧹 Run 1-Click System Prune',
          page: 'activity',
          tab: 'cleanup',
          actionType: 'navigate',
        },
      });
    }

    // 5. SSH Brute Force
    for (const [ip, count] of sshFailedIps.entries()) {
      if (count >= 5) {
        issues.push({
          id: `ssh_brute_force_${ip}`,
          category: 'security',
          severity: count >= 15 ? 'critical' : 'warning',
          title: `SSH Brute-Force Attack from [${ip}]`,
          description: `Detected ${count} failed SSH password login attempts from IP address "${ip}". Unauthorized entity is attempting to guess server credentials.`,
          evidence: `Failed password for invalid user/root from ${ip} (${count} attempts)`,
          timestamp: Date.now(),
          action: {
            label: '🔒 Enable Firewall / SSH Hardening',
            page: 'server-console',
            tab: 'setup',
            actionType: 'navigate',
          },
        });
      }
    }

    // 6. Database Connection Failures
    for (const [db, count] of dbRefusals.entries()) {
      issues.push({
        id: `db_refusal_${db}`,
        category: 'database',
        severity: 'warning',
        title: `${db} Connection Refused`,
        description: `Application containers are unable to reach the ${db} server (${count} failed connection${count > 1 ? 's' : ''}). Check if the database container is healthy and the port is exposed.`,
        evidence: `ECONNREFUSED to ${db}`,
        timestamp: Date.now(),
        action: {
          label: '🗄️ Inspect Database Containers',
          page: 'resources',
          tab: 'containers',
          actionType: 'navigate',
        },
      });
    }

    // Compute Summary & Health Score
    const summary = { critical: 0, warning: 0, security: 0, info: 0 };
    let scorePenalty = 0;

    for (const iss of issues) {
      if (iss.severity === 'critical') {
        summary.critical++;
        scorePenalty += 25;
      } else if (iss.severity === 'warning') {
        summary.warning++;
        scorePenalty += 10;
      } else if (iss.severity === 'security') {
        summary.security++;
        scorePenalty += 15;
      } else {
        summary.info++;
        scorePenalty += 3;
      }
    }

    const healthScore = Math.max(10, Math.min(100, 100 - scorePenalty));
    const status = healthScore >= 90 ? 'healthy' : (healthScore >= 60 ? 'warning' : 'critical');

    return {
      healthScore,
      status,
      issuesCount: issues.length,
      issues,
      summary,
    };
  }
}

module.exports = LogDoctor;
