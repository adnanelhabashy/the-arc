export interface ResolveArcPlatformIdentityArgs {
  platform: NodeJS.Platform;
  arch: string;
}

export function resolveArcPlatformIdentity(
  args: ResolveArcPlatformIdentityArgs,
): string {
  return `${args.platform}-${args.arch}`;
}
