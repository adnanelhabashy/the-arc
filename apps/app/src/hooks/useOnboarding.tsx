// First-run onboarding gate (Phase 20). A clean Arc profile — no threads,
// no connected accounts — shows the welcome flow once; an existing profile
// never sees it just because the persisted "completed" flag predates this
// feature (defaultAppSettings.onboardingCompleted only defaults to false,
// so the empty-state check below is what actually distinguishes a fresh
// install from an old one). Settings can reopen it manually at any time via
// `replay()`, independent of the persisted flag.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { useArcAccountsList } from "@/hooks/queries/arc-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";

interface OnboardingController {
  // Whether the overlay should render right now.
  open: boolean;
  // False while the queries that decide first-run status are still loading.
  dataReady: boolean;
  // Finish (or skip) onboarding: closes the overlay and persists that it
  // should not auto-show again.
  complete: () => void;
  // Reopen onboarding on demand (a "Replay setup" row in Settings), even for
  // a profile that already has accounts and threads.
  replay: () => void;
}

const onboardingContext = createContext<OnboardingController | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const systemConfig = useSystemConfig();
  const sidebarNavigation = useSidebarNavigation();
  const accounts = useArcAccountsList();
  const updateGeneralSettings = useUpdateGeneralSettings();
  const [replayRequested, setReplayRequested] = useState(false);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  const settings = systemConfig.data?.generalSettings ?? null;
  const hasThreads =
    sidebarNavigation.data === undefined
      ? null
      : listSidebarNavigationThreads(sidebarNavigation.data).length > 0;
  const hasAccounts =
    accounts.data === undefined ? null : accounts.data.accounts.length > 0;

  const dataReady = settings !== null && hasThreads !== null && hasAccounts !== null;
  const isFreshProfile = dataReady && hasThreads === false && hasAccounts === false;
  const shouldAutoShow =
    dataReady &&
    settings.onboardingCompleted === false &&
    isFreshProfile &&
    !dismissedThisSession;

  const open = replayRequested || shouldAutoShow;

  const complete = useCallback(() => {
    setReplayRequested(false);
    setDismissedThisSession(true);
    if (settings !== null && !settings.onboardingCompleted) {
      updateGeneralSettings.mutate({ ...settings, onboardingCompleted: true });
    }
  }, [settings, updateGeneralSettings]);

  const replay = useCallback(() => setReplayRequested(true), []);

  const value = useMemo<OnboardingController>(
    () => ({ open, dataReady, complete, replay }),
    [open, dataReady, complete, replay],
  );

  return (
    <onboardingContext.Provider value={value}>
      {children}
    </onboardingContext.Provider>
  );
}

export function useOnboardingController(): OnboardingController {
  const value = useContext(onboardingContext);
  if (value === null) {
    throw new Error("OnboardingProvider is required");
  }
  return value;
}
