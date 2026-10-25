/**
 * Public Oracle Node Registry Service
 * Provides mock data for the list of active TEE oracle nodes, their IDs,
 * and live health status, distinct from the authorized-provider list in
 * services/registry.ts (which tracks addresses authorized to submit
 * attestations, not individual running nodes).
 * Replace with a real API call once the backend exposes a nodes-list
 * endpoint (today it only exposes an aggregate `/api/v1/oracle/health`
 * snapshot, not per-node status).
 *
 * @module services/oracleNodes
 * @see Issue #653 - Implement Public Oracle Node Registry UI
 */

export type NodeHealthStatus = "online" | "degraded" | "offline";

export interface OracleNode {
  id: string;
  nodeId: string;
  operator: string;
  region: string;
  health: NodeHealthStatus;
  uptimePercent: number;
  lastHeartbeat: string;
}

const MOCK_NODES: OracleNode[] = [
  {
    id: "node-1",
    nodeId: "tee-node-us-east-01",
    operator: "StellarOracle Prime",
    region: "us-east",
    health: "online",
    uptimePercent: 99.98,
    lastHeartbeat: new Date(Date.now() - 12_000).toISOString(),
  },
  {
    id: "node-2",
    nodeId: "tee-node-us-west-02",
    operator: "Proof Oracle Alpha",
    region: "us-west",
    health: "online",
    uptimePercent: 99.91,
    lastHeartbeat: new Date(Date.now() - 8_000).toISOString(),
  },
  {
    id: "node-3",
    nodeId: "tee-node-eu-central-01",
    operator: "Veritas Oracle Node",
    region: "eu-central",
    health: "degraded",
    uptimePercent: 97.4,
    lastHeartbeat: new Date(Date.now() - 95_000).toISOString(),
  },
  {
    id: "node-4",
    nodeId: "tee-node-ap-south-01",
    operator: "Quorum Oracle",
    region: "ap-south",
    health: "online",
    uptimePercent: 99.76,
    lastHeartbeat: new Date(Date.now() - 20_000).toISOString(),
  },
  {
    id: "node-5",
    nodeId: "tee-node-ap-northeast-01",
    operator: "Anchor Oracle Network",
    region: "ap-northeast",
    health: "offline",
    uptimePercent: 82.1,
    lastHeartbeat: new Date(Date.now() - 3_600_000).toISOString(),
  },
];

function simulateDelay(ms = 700): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const oracleNodesService = {
  /** Lists all known active TEE oracle nodes with their health status. */
  async listNodes(): Promise<OracleNode[]> {
    await simulateDelay();
    return MOCK_NODES;
  },
};
