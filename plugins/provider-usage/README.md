# Provider usage

Aggregates the usage published by enabled usage-source plugins, keeps it cached,
and serves it to the surfaces that ask: this plugin's own usage settings page,
`provider-usage.v1.*` RPC consumers (Arc's Mission Control and sidebar read
pooled usage through `listResources`/`getResource`), and any other reader that
wants a machine's or a pool's subscription usage. Nothing has to be on screen
for a source plugin to publish its usage.

A content script keeps the cache warm: a safety refresh on a 30-minute interval,
plus one after the window has been hidden or blurred for five minutes. This tree
registers no sidebar footer card for the plugin — see
`docs/bb-upstream-sync.md`.

An unconfigured shared source remains selectable and shows setup guidance.
Failed refreshes retain the last available measurements with a retry notice.
Account authentication failures and plans without reported limits have separate
states; unavailable usage is never represented as zero consumption.

Settings → Installed plugins → Provider usage contains the usage page, using its
full-size provider groups with email-labeled accounts and fetching only resources in the selected pool or machine.

Use `bb plugin rpc list --method provider-usage.v1.listResources --json` to find sources
and `bb plugin rpc inspect <plugin-id> provider-usage.v1.listResources --json`
to inspect their published contracts. RPC calls accept JSON through
`--input-file`. See the Plugin Guide for the contract API.

`bb settings usage --json` and `bb.sdk.system.usageLimits()` remain the
host-local provider-maintenance view; they do not aggregate shared pool accounts.

Codex, Claude Code, and ACP provider plugins explicitly implement the usage contract
for their own providers. Account Pooler implements it for shared accounts. The
contract is owned here and copied into each source; no additional adapter plugin,
provider-kit helper, or core runtime convention is required. Other providers must
explicitly implement the contract to appear in these displays.

Known provider-issued account identities are deduplicated within the selected
location. Unknown identities are never merged by email. Structured plan and quota
window metadata give every display consistent labels.

Provider Usage is enabled by default for newly registered installations. Existing
explicit enable/disable choices are preserved. Its usage settings page is the
plugin's own surface; the footer it used to contribute is not registered here.
