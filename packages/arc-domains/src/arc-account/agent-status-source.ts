import type { ArcAgentAccountStatusSource } from "../arc-agent/manager.js";
import type {
  ArcAgentAccountState,
  ArcAgentId,
} from "../arc-agent/types.js";
import type { ArcAccountService } from "./service.js";

// Bridges the Arc account service into ArcAgentManager: pool accounts decide
// Codex/Claude Code readiness, OMP accounts decide OMP readiness (Phase 8).
// A failing source maps to "unknown" inside the service, never to a fabricated
// "not-connected".
export class ServiceArcAccountStatusSource
  implements ArcAgentAccountStatusSource
{
  private readonly service: ArcAccountService;

  constructor(service: ArcAccountService) {
    this.service = service;
  }

  async getAccountState(agentId: ArcAgentId): Promise<ArcAgentAccountState> {
    try {
      return await this.service.accountStateForAgent(agentId);
    } catch {
      return "unknown";
    }
  }
}
