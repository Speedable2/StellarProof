/**
 * Active Oracle Nodes Table
 * Public table of active TEE oracle nodes, their IDs, and live health
 * status. Distinct from ProviderList, which shows authorized provider
 * addresses rather than individual running nodes.
 *
 * @see Issue #653 - Implement Public Oracle Node Registry UI
 */
"use client";

import React from "react";
import { Activity, AlertTriangle, XCircle } from "lucide-react";
import { type OracleNode, type NodeHealthStatus } from "../../services/oracleNodes";

interface ActiveNodesTableProps {
  nodes: OracleNode[];
  isLoading?: boolean;
}

function HealthBadge({ health }: { health: NodeHealthStatus }) {
  const config: Record<NodeHealthStatus, { label: string; className: string; Icon: typeof Activity }> = {
    online: {
      label: "Online",
      className: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
      Icon: Activity,
    },
    degraded: {
      label: "Degraded",
      className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
      Icon: AlertTriangle,
    },
    offline: {
      label: "Offline",
      className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
      Icon: XCircle,
    },
  };
  const { label, className, Icon } = config[health];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${className}`}>
      <Icon className="w-3 h-3" aria-hidden />
      {label}
    </span>
  );
}

function relativeHeartbeat(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function ActiveNodesTable({ nodes, isLoading }: ActiveNodesTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-center rounded-3xl border-2 border-dashed border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-white/[0.02]">
        <p className="text-sm font-semibold text-gray-900 dark:text-white mb-1">No Active Nodes</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          No TEE oracle nodes are currently reporting status.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-white/10">
      <table className="w-full text-sm" aria-label="Active oracle nodes">
        <thead>
          <tr className="bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/10 text-left">
            <th scope="col" className="px-4 py-2.5 font-semibold text-gray-600 dark:text-gray-300 text-xs uppercase tracking-wide">
              Node ID
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold text-gray-600 dark:text-gray-300 text-xs uppercase tracking-wide">
              Operator
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold text-gray-600 dark:text-gray-300 text-xs uppercase tracking-wide">
              Region
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold text-gray-600 dark:text-gray-300 text-xs uppercase tracking-wide">
              Uptime
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold text-gray-600 dark:text-gray-300 text-xs uppercase tracking-wide">
              Health
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold text-gray-600 dark:text-gray-300 text-xs uppercase tracking-wide">
              Last Heartbeat
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-white/10">
          {nodes.map((node) => (
            <tr key={node.id} className="bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors">
              <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">{node.nodeId}</td>
              <td className="px-4 py-3 text-gray-900 dark:text-white font-medium">{node.operator}</td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{node.region}</td>
              <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{node.uptimePercent.toFixed(2)}%</td>
              <td className="px-4 py-3">
                <HealthBadge health={node.health} />
              </td>
              <td className="px-4 py-3 text-gray-400 dark:text-gray-500 text-xs">
                {relativeHeartbeat(node.lastHeartbeat)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
