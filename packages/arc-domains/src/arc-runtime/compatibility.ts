import { compare, valid } from "semver";
import type {
  ArcRuntimeCompatibility,
  ArcRuntimeId,
} from "./types.js";

export interface ArcRuntimeCompatibilityRule {
  minimum?: string;
  maximumTested?: string;
  blockedVersions?: readonly string[];
  // Versions below this are "untested" rather than "blocked" — used when no
  // verified minimum exists and older versions are merely unproven, not known
  // bad (the plan's rule: unknown is never silently supported).
  untestedBelow?: string;
}

export type ArcRuntimeCompatibilityPolicy = Partial<
  Record<ArcRuntimeId, ArcRuntimeCompatibilityRule>
>;

export interface ArcRuntimeCompatibilityEvaluation {
  compatibility: ArcRuntimeCompatibility;
  reason: string;
}

export interface EvaluateArcRuntimeCompatibilityArgs {
  runtimeId: ArcRuntimeId;
  version: string;
  policy: ArcRuntimeCompatibilityPolicy;
}

const openaiCodexMinimumVersion = "0.136.0";
const arcCodexTestedMaximumVersion = "0.155.1";

// No verified minimum OMP version exists in the BB ACP integration, so the
// first Arc-tested pin (18.2.6) is recorded as both minimum and tested
// maximum: exactly 18.2.6 is "supported", newer is "untested", older is
// "blocked" from auto-activation until compatibility evidence exists.
const arcOmpFirstTestedVersion = "18.2.6";

// The BB Claude provider records no minimum supported version (verified in the
// prebuilt provider artifact: minimumSupportedVersion is null), so per the
// plan's conservative rule exactly the tested pin is "supported", newer is
// "untested", and older is "untested" — never silently supported, never
// blocked without evidence.
const arcClaudeCodeTestedVersion = "2.1.276";

export const ARC_RUNTIME_COMPATIBILITY_POLICY: ArcRuntimeCompatibilityPolicy =
  {
    codex: {
      minimum: openaiCodexMinimumVersion,
      maximumTested: arcCodexTestedMaximumVersion,
    },
    omp: {
      minimum: arcOmpFirstTestedVersion,
      maximumTested: arcOmpFirstTestedVersion,
    },
    "claude-code": {
      maximumTested: arcClaudeCodeTestedVersion,
      untestedBelow: arcClaudeCodeTestedVersion,
    },
  };

export function evaluateArcRuntimeCompatibility(
  args: EvaluateArcRuntimeCompatibilityArgs,
): ArcRuntimeCompatibilityEvaluation {
  const parsedVersion = valid(args.version);
  if (parsedVersion === null) {
    return {
      compatibility: "untested",
      reason: `version "${args.version}" is not valid semver`,
    };
  }

  const rule = args.policy[args.runtimeId];
  if (rule === undefined) {
    return {
      compatibility: "untested",
      reason: "no compatibility policy recorded for this runtime",
    };
  }

  if (
    rule.blockedVersions?.some(
      (blocked) => valid(blocked) === parsedVersion,
    ) === true
  ) {
    return {
      compatibility: "blocked",
      reason: `version ${parsedVersion} is a known-bad release`,
    };
  }

  if (rule.minimum !== undefined) {
    const minimum = valid(rule.minimum);
    if (minimum !== null && compare(parsedVersion, minimum) < 0) {
      return {
        compatibility: "blocked",
        reason: `version ${parsedVersion} is below the minimum supported version ${minimum}`,
      };
    }
  }

  if (rule.maximumTested === undefined) {
    return {
      compatibility: "untested",
      reason:
        "this Arc release has not recorded a tested maximum for this runtime",
    };
  }

  const maximumTested = valid(rule.maximumTested);
  if (maximumTested === null) {
    return {
      compatibility: "untested",
      reason: "recorded tested maximum is not valid semver",
    };
  }

  if (compare(parsedVersion, maximumTested) > 0) {
    return {
      compatibility: "untested",
      reason: `version ${parsedVersion} is newer than the tested maximum ${maximumTested}`,
    };
  }

  if (rule.untestedBelow !== undefined) {
    const untestedBelow = valid(rule.untestedBelow);
    if (
      untestedBelow !== null &&
      compare(parsedVersion, untestedBelow) < 0
    ) {
      return {
        compatibility: "untested",
        reason: `version ${parsedVersion} is older than the first tested version ${untestedBelow}`,
      };
    }
  }

  return {
    compatibility: "supported",
    reason: `version ${parsedVersion} is within the tested range for this Arc release`,
  };
}
