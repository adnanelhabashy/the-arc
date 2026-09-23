import { describe, expect, it } from "vitest";
import {
  describePermissionModeUnsupported,
  permissionModesWithinCeiling,
  PRODUCT_DEFAULT_PERMISSION_MODE,
  resolveEffectivePermissionMode,
  type PermissionModeResolution,
  type ResolveEffectivePermissionModeArgs,
  type ResolvedPermissionMode,
  type UnsupportedPermissionMode,
} from "../src/permission-resolution.js";
import {
  permissionModeRank,
  permissionModeValues,
  type PermissionMode,
} from "../src/shared-types.js";

const ALL: readonly PermissionMode[] = ["accept-edits", "auto", "full"];
const ACCEPT_AND_FULL: readonly PermissionMode[] = ["accept-edits", "full"];
const ONLY_FULL: readonly PermissionMode[] = ["full"];
const ONLY_ACCEPT: readonly PermissionMode[] = ["accept-edits"];

type ResolveArgs = Omit<
  ResolveEffectivePermissionModeArgs,
  "providerId" | "hostPermissionCeiling"
> & {
  providerId?: string;
  hostPermissionCeiling?: PermissionMode;
};

function resolve(args: ResolveArgs): PermissionModeResolution {
  return resolveEffectivePermissionMode({
    providerId: "acp-omp",
    hostPermissionCeiling: "full",
    ...args,
  });
}

function expectResolved(result: PermissionModeResolution): ResolvedPermissionMode {
  if (result.kind !== "resolved") {
    throw new Error(
      `expected a resolved permission mode, got unsupported/${result.reason}`,
    );
  }
  return result;
}

function expectUnsupported(
  result: PermissionModeResolution,
): UnsupportedPermissionMode {
  if (result.kind !== "unsupported") {
    throw new Error(`expected unsupported, got ${result.mode}`);
  }
  return result;
}

describe("resolveEffectivePermissionMode — provider shape x requested mode", () => {
  it("uses the requested mode when the provider supports all three", () => {
    for (const mode of permissionModeValues) {
      const result = expectResolved(
        resolve({ requestedMode: mode, providerSupportedModes: ALL }),
      );
      expect(result.mode).toBe(mode);
      expect(result.source).toBe("explicit");
      expect(result.adapted).toBe(false);
    }
  });

  it("adapts auto down to accept-edits for a provider without auto", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "auto",
        providerSupportedModes: ACCEPT_AND_FULL,
      }),
    );
    expect(result.mode).toBe("accept-edits");
    expect(result.preferredMode).toBe("auto");
    expect(result.adapted).toBe(true);
  });

  it("accepts full unchanged for a provider that supports only full", () => {
    const result = expectResolved(
      resolve({ requestedMode: "full", providerSupportedModes: ONLY_FULL }),
    );
    expect(result.mode).toBe("full");
    expect(result.adapted).toBe(false);
  });

  it("accepts accept-edits unchanged for a provider that supports only accept-edits", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "accept-edits",
        providerSupportedModes: ONLY_ACCEPT,
      }),
    );
    expect(result.mode).toBe("accept-edits");
    expect(result.adapted).toBe(false);
  });

  it("refuses to raise accept-edits to full for a full-only provider", () => {
    const result = expectUnsupported(
      resolve({
        requestedMode: "accept-edits",
        providerSupportedModes: ONLY_FULL,
      }),
    );
    expect(result.reason).toBe("provider");
    expect(result.permittedModes).toEqual(["full"]);
  });

  it("refuses to raise auto to full for a full-only provider", () => {
    const result = expectUnsupported(
      resolve({ requestedMode: "auto", providerSupportedModes: ONLY_FULL }),
    );
    expect(result.reason).toBe("provider");
  });

  it("treats an unreported provider set as unconstrained", () => {
    const result = expectResolved(
      resolve({ requestedMode: "full", providerSupportedModes: null }),
    );
    expect(result.mode).toBe("full");
  });
});

describe("resolveEffectivePermissionMode — source precedence", () => {
  it("prefers an explicit request over every other source", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "accept-edits",
        recordedMode: "full",
        inheritedMode: "full",
        projectDefault: "full",
        providerSupportedModes: ALL,
      }),
    );
    expect(result).toMatchObject({ mode: "accept-edits", source: "explicit" });
  });

  it("lets a Mission Control role's forwarded permission outrank the thread's history", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "full",
        recordedMode: "accept-edits",
        inheritedMode: "auto",
        projectDefault: "auto",
        providerSupportedModes: ALL,
      }),
    );
    expect(result).toMatchObject({ mode: "full", source: "explicit" });
  });

  it("normalizes a legacy recorded mode before ranking it", () => {
    const result = expectResolved(
      resolve({ recordedMode: "workspace-write", providerSupportedModes: ALL }),
    );
    expect(result).toMatchObject({ mode: "accept-edits", source: "thread-last" });
  });

  it("prefers the thread's last execution over the parent's mode", () => {
    const result = expectResolved(
      resolve({
        recordedMode: "full",
        inheritedMode: "accept-edits",
        providerSupportedModes: ALL,
      }),
    );
    expect(result).toMatchObject({ mode: "full", source: "thread-last" });
  });

  it("treats the parent mode as an inherited default, not a ceiling", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "full",
        inheritedMode: "accept-edits",
        providerSupportedModes: ALL,
      }),
    );
    expect(result).toMatchObject({ mode: "full", source: "explicit" });
  });

  it("inherits the parent's mode when the child asks for nothing", () => {
    const result = expectResolved(
      resolve({
        inheritedMode: "accept-edits",
        providerSupportedModes: ALL,
      }),
    );
    expect(result).toMatchObject({ mode: "accept-edits", source: "parent" });
  });

  it("falls back to the project default, then the product default", () => {
    const project = expectResolved(
      resolve({ projectDefault: "accept-edits", providerSupportedModes: ALL }),
    );
    expect(project).toMatchObject({ mode: "accept-edits", source: "project" });

    const product = expectResolved(resolve({ providerSupportedModes: ALL }));
    expect(product).toMatchObject({
      mode: PRODUCT_DEFAULT_PERMISSION_MODE,
      source: "product",
    });
  });

  it("adapts an inherited mode to the child provider's set", () => {
    const result = expectResolved(
      resolve({
        inheritedMode: "auto",
        providerSupportedModes: ACCEPT_AND_FULL,
      }),
    );
    expect(result).toMatchObject({
      mode: "accept-edits",
      source: "parent",
      adapted: true,
    });
  });
});

describe("resolveEffectivePermissionMode — host ceiling is authoritative", () => {
  it("never resolves above the ceiling", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "full",
        hostPermissionCeiling: "auto",
        providerSupportedModes: ALL,
      }),
    );
    expect(result.mode).toBe("auto");
  });

  it("drops to the highest permitted mode when the ceiling excludes the request", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "full",
        hostPermissionCeiling: "accept-edits",
        providerSupportedModes: ALL,
      }),
    );
    expect(result.mode).toBe("accept-edits");
  });

  it("reports a ceiling conflict when the provider fits nowhere under it", () => {
    const result = expectUnsupported(
      resolve({
        requestedMode: "full",
        hostPermissionCeiling: "accept-edits",
        providerSupportedModes: ONLY_FULL,
      }),
    );
    expect(result.reason).toBe("ceiling");
    expect(result.permittedModes).toEqual([]);
  });

  it("adapts a provider's auto away even when the ceiling permits the request", () => {
    const result = expectResolved(
      resolve({
        requestedMode: "auto",
        hostPermissionCeiling: "full",
        providerSupportedModes: ACCEPT_AND_FULL,
      }),
    );
    expect(result.mode).toBe("accept-edits");
  });
});

describe("resolveEffectivePermissionMode — never escalates", () => {
  const shapes: readonly (readonly PermissionMode[])[] = [
    ALL,
    ACCEPT_AND_FULL,
    ONLY_FULL,
    ONLY_ACCEPT,
  ];
  const ceilings: readonly PermissionMode[] = ["accept-edits", "auto", "full"];

  it("holds the no-escalation invariant across every shape, ceiling and request", () => {
    for (const providerSupportedModes of shapes) {
      for (const hostPermissionCeiling of ceilings) {
        for (const requestedMode of permissionModeValues) {
          const result = resolve({
            requestedMode,
            providerSupportedModes,
            hostPermissionCeiling,
          });
          const bound = Math.min(
            permissionModeRank(requestedMode),
            permissionModeRank(hostPermissionCeiling),
          );
          if (result.kind === "unsupported") {
            if (result.reason === "ceiling") {
              expect(result.permittedModes).toEqual([]);
            } else {
              // Nothing the provider offers sits at or below the request.
              for (const mode of result.permittedModes) {
                expect(permissionModeRank(mode)).toBeGreaterThan(bound);
              }
            }
            continue;
          }
          expect(permissionModeRank(result.mode)).toBeLessThanOrEqual(bound);
          expect(result.mode).toBe(
            clampExpectation(providerSupportedModes, bound),
          );
        }
      }
    }
  });

  it("resolves every supported mode for the provider it was asked about", () => {
    for (const providerSupportedModes of shapes) {
      for (const requestedMode of permissionModeValues) {
        const result = resolve({
          requestedMode,
          providerSupportedModes,
          hostPermissionCeiling: "full",
        });
        if (result.kind === "resolved") {
          expect(providerSupportedModes).toContain(result.mode);
        }
      }
    }
  });
});

describe("permissionModesWithinCeiling", () => {
  it("lists the provider's modes within the ceiling, highest first", () => {
    expect(permissionModesWithinCeiling(ALL, "auto")).toEqual([
      "auto",
      "accept-edits",
    ]);
    expect(
      permissionModesWithinCeiling(ACCEPT_AND_FULL, "accept-edits"),
    ).toEqual(["accept-edits"]);
    expect(permissionModesWithinCeiling(ONLY_FULL, "auto")).toEqual([]);
  });

  it("treats an unreported provider set as the full ladder", () => {
    expect(permissionModesWithinCeiling(null, "full")).toEqual([
      "full",
      "auto",
      "accept-edits",
    ]);
  });
});

describe("describePermissionModeUnsupported", () => {
  it("names a full-only provider's requirement and tells the user to select it", () => {
    const message = describePermissionModeUnsupported(
      expectUnsupported(
        resolve({
          requestedMode: "auto",
          providerSupportedModes: ONLY_FULL,
        }),
      ),
    );

    // Names the provider, the mode it requires, and the fact that the user has
    // to choose it — a bare "unsupported" leaves the user with no way forward.
    expect(message).toContain('"acp-omp"');
    expect(message).toContain("Full Access");
    expect(message).toContain("This provider requires Full Access");
    expect(message).toContain("select Full Access to run it");
    expect(message).toContain("will not raise the permission level");
  });

  it("offers every permitted mode when the provider has more than one", () => {
    const message = describePermissionModeUnsupported(
      expectUnsupported(
        resolve({
          requestedMode: "accept-edits",
          providerSupportedModes: ["auto", "full"],
        }),
      ),
    );

    expect(message).toContain("choose one of Approve for me, Full Access");
    expect(message).not.toContain("This provider requires");
  });

  it("names the ceiling, in the same words the picker uses, when the machine is the blocker", () => {
    const message = describePermissionModeUnsupported(
      expectUnsupported(
        resolve({
          requestedMode: "full",
          hostPermissionCeiling: "accept-edits",
          providerSupportedModes: ONLY_FULL,
        }),
      ),
    );

    expect(message).toContain('"Accept Edits"');
    expect(message).toContain("none of Full Access within that limit");
    expect(message).toContain("This machine limits permission mode");
  });
});

function clampExpectation(
  supported: readonly PermissionMode[],
  bound: number,
): PermissionMode | null {
  let best: PermissionMode | null = null;
  for (const mode of supported) {
    if (permissionModeRank(mode) > bound) continue;
    if (best === null || permissionModeRank(mode) > permissionModeRank(best)) {
      best = mode;
    }
  }
  return best;
}
