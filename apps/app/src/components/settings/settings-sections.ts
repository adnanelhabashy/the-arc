import type { IconName } from "@bb/shared-ui/icon";
import { SETTINGS_ROUTE_PATH, getSettingsRoutePath } from "@/lib/route-paths";

export type SettingsSectionGroup = "general" | "advanced" | "archived";

export const SETTINGS_NAV_SECTION_GROUPS = [
  { id: "general", label: "General" },
  { id: "advanced", label: "Advanced" },
] as const satisfies readonly {
  id: SettingsSectionGroup;
  label: string;
}[];

export const SETTINGS_NAV_SECTIONS = [
  { icon: "Settings", id: "general", group: "general", label: "General" },
  {
    icon: "SecurityCheck",
    id: "diagnostics",
    group: "advanced",
    label: "Diagnostics",
  },
  { icon: "Bot", id: "providers", group: "general", label: "Providers" },
  { icon: "Palette", id: "appearance", group: "general", label: "Appearance" },
  { icon: "Mic", id: "voice", group: "general", label: "Voice" },
  {
    icon: "SlidersHorizontal",
    id: "keyboard",
    group: "general",
    label: "Keyboard",
  },
  { icon: "Browser", id: "browser", group: "general", label: "Browser" },
  { icon: "File", id: "files", group: "general", label: "Files" },
  { icon: "FolderGit", id: "projects", group: "general", label: "Projects" },
  { icon: "Laptop", id: "machines", group: "general", label: "Machines" },
  {
    icon: "Lock",
    id: "environment-variables",
    group: "general",
    label: "Environment variables",
  },
  {
    icon: "PackageReceive",
    id: "updates",
    group: "advanced",
    label: "Updates",
  },
  {
    icon: "ElectricPlugs",
    id: "plugins",
    group: "advanced",
    label: "Installed plugins",
  },
  {
    icon: "Puzzle",
    id: "marketplaces",
    group: "advanced",
    label: "Plugin marketplaces",
  },
  {
    icon: "Beaker",
    id: "experiments",
    group: "advanced",
    label: "Experiments",
  },
  {
    icon: "MessageSquare",
    id: "community",
    group: "advanced",
    label: "Community",
  },
  {
    icon: "Archive",
    id: "archived",
    group: "archived",
    label: "Archived threads",
  },
] as const satisfies readonly {
  icon: IconName;
  id: string;
  group: SettingsSectionGroup;
  label: string;
}[];

export type SettingsNavSection = (typeof SETTINGS_NAV_SECTIONS)[number];

export type SettingsSectionId = SettingsNavSection["id"];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_NAV_SECTIONS.some((section) => section.id === value);
}

export function getSettingsSectionRoutePath(
  sectionId: SettingsSectionId,
): string {
  return sectionId === "general"
    ? SETTINGS_ROUTE_PATH
    : getSettingsRoutePath(sectionId);
}
