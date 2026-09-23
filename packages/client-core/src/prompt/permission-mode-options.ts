import { permissionModeLabel, type PermissionMode } from "@bb/domain";

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  description: string;
  tone?: "warning";
}

/**
 * The labels come from `@bb/domain`'s `permissionModeLabel`, the same source the
 * server's permission failure messages use, so the picker and an error that
 * tells the user which mode to select always name it identically. Only the
 * descriptions and tone — presentation — are decided here.
 */
export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: "accept-edits",
    label: permissionModeLabel("accept-edits"),
    description:
      "Applies edits inside the workspace automatically. Anything beyond the workspace asks you first.",
  },
  {
    value: "auto",
    label: permissionModeLabel("auto"),
    description:
      "Same workspace sandbox, with requests reviewed automatically. High-risk actions can still come back to you.",
  },
  {
    value: "full",
    label: permissionModeLabel("full"),
    tone: "warning",
    description:
      "No sandbox and no approvals — the agent can run anything on your machine.",
  },
];
