import { Button } from "@bb/shared-ui/button";
import { SettingsSection, SettingsWithControl } from "@/components/ui/settings-section";
import { useOnboardingController } from "@/hooks/useOnboarding";

// Lets a user who skipped or already finished first-run onboarding walk
// through it again — the persisted "completed" flag is what keeps it from
// auto-showing, not a hard one-time gate.
export function OnboardingReplaySettingsSection() {
  const { replay } = useOnboardingController();

  return (
    <SettingsSection title="Setup">
      <SettingsWithControl
        label="Welcome & agent setup"
        description="Revisit the welcome screen, agent readiness, and account connection steps."
      >
        <Button variant="outline" size="sm" onClick={replay}>
          Replay setup
        </Button>
      </SettingsWithControl>
    </SettingsSection>
  );
}
