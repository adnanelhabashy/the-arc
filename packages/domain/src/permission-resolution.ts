import {
  clampPermissionModeToCeiling,
  normalizeRecordedPermissionMode,
  permissionModeRank,
  permissionModeValues,
  type PermissionMode,
  type RecordedPermissionMode,
} from "./shared-types.js";

/**
 * The product-level default every surface falls back to when nothing more
 * specific is known. Deliberately the middle of the ladder: a provider that
 * cannot honour it is adapted *downward*, never upward.
 */
export const PRODUCT_DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/**
 * Where a resolved permission came from. Ordered the way
 * `resolveEffectivePermissionMode` walks it, so a caller reporting a value can
 * say whose decision it was.
 *
 * There is deliberately no separate "role" tier: Mission Control is the source
 * of truth for a role's permission and forwards it as the explicit request when
 * it dispatches, so the two share one precedence step rather than two that
 * would have to be kept in sync.
 */
export const permissionModeSourceValues = [
  "explicit",
  "thread-last",
  "parent",
  "project",
  "product",
] as const;
export type PermissionModeSource = (typeof permissionModeSourceValues)[number];

export interface ResolveEffectivePermissionModeArgs {
  /**
   * An explicit execution request — a composer selection, a CLI
   * `--permission-mode`, a workflow call's configured selection, or the
   * permission of the Mission Control role doing the dispatching.
   */
  requestedMode?: PermissionMode | null;
  /** The thread's own last execution setting, when nothing newer was asked for. */
  recordedMode?: RecordedPermissionMode | null;
  /**
   * The parent/origin thread's mode. An inherited *default*, never a ceiling:
   * the host/machine ceiling is what constrains, not a peer thread.
   */
  inheritedMode?: RecordedPermissionMode | null;
  /** The project's stored default. */
  projectDefault?: PermissionMode | null;
  /** Overrides `PRODUCT_DEFAULT_PERMISSION_MODE` when a surface has its own. */
  productDefault?: PermissionMode | null;

  providerId: string;
  /**
   * `provider.capabilities.permissionModes`. `null` means the provider did not
   * report a set, which is treated as "no constraint" — the behaviour for
   * providers that publish no capability list.
   */
  providerSupportedModes?: readonly PermissionMode[] | null;
  /** The machine's `host.maxPermissionMode`. Always authoritative. */
  hostPermissionCeiling: PermissionMode;
}

export interface ResolvedPermissionMode {
  kind: "resolved";
  mode: PermissionMode;
  /** Whose decision produced the mode before any adaptation. */
  source: PermissionModeSource;
  /** The mode the source asked for, before adaptation. */
  preferredMode: PermissionMode;
  /** True when the provider could not execute `preferredMode` and the mode moved *down*. */
  adapted: boolean;
}

export interface UnsupportedPermissionMode {
  kind: "unsupported";
  /**
   * `provider` — the preferred mode is outside the provider's set and nothing
   * at or below it is supported.
   * `ceiling` — the machine permits no mode the provider supports at all.
   */
  reason: "provider" | "ceiling";
  providerId: string;
  preferredMode: PermissionMode;
  source: PermissionModeSource;
  supported: readonly PermissionMode[];
  ceiling: PermissionMode;
  /** Modes the provider supports within the ceiling; empty for `ceiling`. */
  permittedModes: readonly PermissionMode[];
}

export type PermissionModeResolution =
  | ResolvedPermissionMode
  | UnsupportedPermissionMode;

/**
 * The provider's modes within a machine ceiling, highest first. The single
 * source of truth for "what may this provider actually be asked to do here",
 * shared by resolution and by UI option lists.
 */
export function permissionModesWithinCeiling(
  supported: readonly PermissionMode[] | null | undefined,
  ceiling: PermissionMode,
): PermissionMode[] {
  const ceilingRank = permissionModeRank(ceiling);
  return (supported ?? permissionModeValues)
    .filter((mode) => permissionModeRank(mode) <= ceilingRank)
    .sort((left, right) => permissionModeRank(right) - permissionModeRank(left));
}

/**
 * One central provider-aware permission policy. Every provider execution path
 * in Arc resolves through this: threads (new, resumed, forked, child), provider
 * handoff, workflow workers, automations, Mission Control role dispatch, and
 * the CLI.
 *
 * Two rules hold unconditionally:
 *
 * 1. The host/machine ceiling is authoritative. Provider compatibility can
 *    never lift it.
 * 2. Provider compatibility can never *escalate*. If the preferred mode is
 *    unavailable, the result moves down the ladder or fails loudly — a provider
 *    that supports only `full` does not get to turn a requested `accept-edits`
 *    into `full`.
 */
export function resolveEffectivePermissionMode(
  args: ResolveEffectivePermissionModeArgs,
): PermissionModeResolution {
  const candidates: readonly [PermissionModeSource, PermissionMode | undefined][] =
    [
      ["explicit", args.requestedMode ?? undefined],
      [
        "thread-last",
        args.recordedMode == null
          ? undefined
          : normalizeRecordedPermissionMode(args.recordedMode),
      ],
      [
        "parent",
        args.inheritedMode == null
          ? undefined
          : normalizeRecordedPermissionMode(args.inheritedMode),
      ],
      ["project", args.projectDefault ?? undefined],
      ["product", args.productDefault ?? PRODUCT_DEFAULT_PERMISSION_MODE],
    ];

  let source: PermissionModeSource = "product";
  let preferredMode: PermissionMode = PRODUCT_DEFAULT_PERMISSION_MODE;
  for (const [candidateSource, candidate] of candidates) {
    if (candidate !== undefined) {
      source = candidateSource;
      preferredMode = candidate;
      break;
    }
  }

  const supported = args.providerSupportedModes ?? permissionModeValues;
  const ceiling = args.hostPermissionCeiling;
  const permittedModes = permissionModesWithinCeiling(supported, ceiling);

  if (permittedModes.length === 0) {
    return {
      kind: "unsupported",
      reason: "ceiling",
      providerId: args.providerId,
      preferredMode,
      source,
      supported,
      ceiling,
      permittedModes,
    };
  }

  const clamped = clampPermissionModeToCeiling({
    ceiling,
    permissionMode: preferredMode,
    permissionModes: supported,
  });

  if (clamped === null) {
    return {
      kind: "unsupported",
      reason: "provider",
      providerId: args.providerId,
      preferredMode,
      source,
      supported,
      ceiling,
      permittedModes,
    };
  }

  return {
    kind: "resolved",
    mode: clamped,
    source,
    preferredMode,
    adapted: clamped !== preferredMode,
  };
}

export function permissionModeSourceLabel(source: PermissionModeSource): string {
  switch (source) {
    case "explicit":
      return "the requested permission mode";
    case "thread-last":
      return "this thread's last execution";
    case "parent":
      return "the parent thread's permission mode";
    case "project":
      return "the project's default permission mode";
    case "product":
      return "the product default";
  }
}

/**
 * The user-facing name of each mode. Arc's permission vocabulary is
 * `accept-edits` | `auto` | `full`, and these are the words every surface shows
 * for them — the composer picker, the CLI, and the failure messages below — so
 * a message that names a mode names it the way the user sees it in the picker.
 */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  "accept-edits": "Accept Edits",
  auto: "Approve for me",
  full: "Full Access",
};

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_LABELS[mode];
}

/**
 * The one wording for a permission failure, shared by the server's `ApiError`
 * and the CLI so an operator sees the same sentence wherever an execution was
 * started.
 *
 * A provider that offers exactly one mode within the ceiling is the case worth
 * spelling out: the user's only way forward is to select that mode, and Arc
 * will not select it for them, so the sentence names it and says so.
 */
export function describePermissionModeUnsupported(
  resolution: UnsupportedPermissionMode,
): string {
  const supportedList = resolution.supported.map(permissionModeLabel).join(", ");
  const preferred = permissionModeLabel(resolution.preferredMode);
  if (resolution.reason === "ceiling") {
    return `This machine limits permission mode to "${permissionModeLabel(resolution.ceiling)}", but provider "${resolution.providerId}" supports none of ${supportedList} within that limit. Raise the machine's permission ceiling, or choose a provider that supports "${permissionModeLabel(resolution.ceiling)}" or a lower mode.`;
  }
  // Least privilege first: this is a "choose one of" instruction, and the
  // permitted set is otherwise ordered highest-first.
  const permitted = [...resolution.permittedModes]
    .sort((left, right) => permissionModeRank(left) - permissionModeRank(right))
    .map(permissionModeLabel);
  const onlyOption = permitted.length === 1 ? permitted[0] : null;
  const requirement =
    onlyOption === null
      ? `Arc will not raise the permission level to make a provider work; choose one of ${permitted.join(", ")}.`
      : `This provider requires ${onlyOption}, and Arc will not raise the permission level on its own; select ${onlyOption} to run it.`;
  return `Provider "${resolution.providerId}" supports ${supportedList}, and none of those is at or below "${preferred}" (${permissionModeSourceLabel(resolution.source)}). ${requirement}`;
}
