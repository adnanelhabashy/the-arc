// bb-plugin-adnan-mission-control — frontend entry (Phase 10).
//
// One nav panel, mounted exactly once. Sections are reached through sub-path
// routing (`/plugins/adnan-mission-control/<subPath>`), not fixed tabs.
// The "Agents" section is the Arc product surface (three cards over
// ArcAgentManager); the old live thread hierarchy moved to "Threads".
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { OverviewPage } from "@/components/overview";
import { AgentsPage } from "@/components/agents";
import { AccountsPage } from "@/components/accounts";
import { ThreadsPage } from "@/components/threads";
import { RolesPage } from "@/components/roles";
import { ApprovalsPage } from "@/components/approvals";
import { VerificationPage } from "@/components/verification";
import { UsageLimitsPage } from "@/components/usage-limits";
import { AccountsUsageDisclosure } from "@/components/accounts-usage-disclosure";

const TABS = [
  { id: "overview", title: "Overview", subPath: "" },
  { id: "agents", title: "Agents", subPath: "agents" },
  { id: "accounts", title: "Accounts", subPath: "accounts" },
  { id: "usage", title: "Usage & Limits", subPath: "usage" },
  { id: "threads", title: "Threads", subPath: "threads" },
  { id: "roles", title: "Roles", subPath: "roles" },
  { id: "approvals", title: "Approvals", subPath: "approvals" },
  { id: "verification", title: "Verification", subPath: "verification" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function activeTab(subPath: string): TabId {
  if (subPath === "agents") return "agents";
  if (subPath === "accounts") return "accounts";
  if (subPath === "usage") return "usage";
  if (subPath === "threads") return "threads";
  if (subPath === "roles") return "roles";
  if (subPath === "approvals") return "approvals";
  if (subPath === "verification") return "verification";
  return "overview";
}

function MissionControlShell({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const active = activeTab(subPath);

  return (
    <div className="flex h-full flex-col">
      <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 pt-2" aria-label="Mission Control sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => navigate.toPluginPanel("mission-control", { subPath: tab.subPath })}
            aria-current={active === tab.id ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-t-md border-b-2 px-3 py-1.5 text-xs font-medium",
              active === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.title}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {active === "agents" ? (
          <AgentsPage />
        ) : active === "accounts" ? (
          <AccountsPage />
        ) : active === "usage" ? (
          <UsageLimitsPage />
        ) : active === "threads" ? (
          <ThreadsPage />
        ) : active === "roles" ? (
          <RolesPage />
        ) : active === "approvals" ? (
          <ApprovalsPage />
        ) : active === "verification" ? (
          <VerificationPage />
        ) : (
          <OverviewPage />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mission-control",
    title: "Mission Control",
    icon: "Gauge",
    path: "mission-control",
    component: MissionControlShell,
  });
  // Arc's own accounts surface in the sidebar. The builtin Provider usage
  // disclosure stays registered by its own plugin: it aggregates bb usage
  // sources (pooled accounts, local provider CLIs), while this one shows Arc's
  // unified accounts — pooled and OMP alike — from the same read model as the
  // Usage & Limits page and the thread popup.
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "accounts-usage",
    label: "Accounts & Usage",
    icon: "UserRound",
    component: AccountsUsageDisclosure,
  });
});
