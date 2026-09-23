import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "../src/digest.js";
import {
  probeArcVoiceboxRelease,
  stageArcVoiceboxComponentFromBundle,
  stageArcVoiceboxComponentFromFile,
  type ArcVoiceboxProbe,
} from "../src/acquire.js";
import { ARC_VOICEBOX_RELEASE } from "../src/release.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-acquire-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const COMPONENT_BYTES = "voicebox-server-fixture";

const probeReporting =
  (stdout: string): ArcVoiceboxProbe =>
  () =>
    Promise.resolve({ kind: "ok", stdout });

const failingProbe: ArcVoiceboxProbe = () =>
  Promise.resolve({ kind: "failed", reason: "exec format error" });

async function createFixtureBundle(root: string): Promise<{
  bundlePath: string;
  release: typeof ARC_VOICEBOX_RELEASE;
}> {
  const bundlePath = join(root, "Voicebox.app");
  const macosDir = join(bundlePath, "Contents", "MacOS");
  await mkdir(macosDir, { recursive: true });
  const componentPath = join(macosDir, "voicebox-server");
  await writeFile(componentPath, COMPONENT_BYTES, "utf8");
  await writeFile(join(macosDir, "voicebox"), "gui-fixture", "utf8");
  await writeFile(join(macosDir, "voicebox-mcp"), "mcp-fixture", "utf8");
  return {
    bundlePath,
    release: {
      ...ARC_VOICEBOX_RELEASE,
      componentSha256: await sha256File(componentPath),
    },
  };
}

describe("probeArcVoiceboxRelease", () => {
  it("accepts the pinned version output", async () => {
    expect(
      await probeArcVoiceboxRelease({
        release: ARC_VOICEBOX_RELEASE,
        executablePath: "/unused",
        probe: probeReporting("voicebox-server 0.5.0\n"),
      }),
    ).toEqual({ kind: "ok", output: "voicebox-server 0.5.0" });
  });

  it("rejects a binary that reports a different version", async () => {
    expect(
      await probeArcVoiceboxRelease({
        release: ARC_VOICEBOX_RELEASE,
        executablePath: "/unused",
        probe: probeReporting("voicebox-server 0.4.9"),
      }),
    ).toEqual({
      kind: "failed",
      reason:
        'version probe reported "voicebox-server 0.4.9", expected "voicebox-server 0.5.0"',
    });
  });

  it("surfaces a probe that could not start the binary", async () => {
    expect(
      await probeArcVoiceboxRelease({
        release: ARC_VOICEBOX_RELEASE,
        executablePath: "/unused",
        probe: failingProbe,
      }),
    ).toEqual({ kind: "failed", reason: "exec format error" });
  });
});

describe("stageArcVoiceboxComponentFromBundle", () => {
  it("stages only the component, verified and executable", async () => {
    const root = await createRoot();
    const { bundlePath, release } = await createFixtureBundle(root);
    const stagingDir = join(root, "staging", "0.5.0");

    const staged = await stageArcVoiceboxComponentFromBundle({
      release,
      bundlePath,
      stagingDir,
      probe: probeReporting(ARC_VOICEBOX_RELEASE.expectedVersionOutput),
    });

    expect(staged).toEqual({
      kind: "ok",
      executablePath: join(stagingDir, "voicebox-server"),
      digest: release.componentSha256,
      version: release.version,
    });
    expect(await readFile(join(stagingDir, "voicebox-server"), "utf8")).toBe(
      COMPONENT_BYTES,
    );
    const mode = (await stat(join(stagingDir, "voicebox-server"))).mode;
    expect(mode & 0o111).not.toBe(0);
    expect(
      await stat(join(stagingDir, "voicebox")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(join(stagingDir, "voicebox-mcp")).catch(() => null),
    ).toBeNull();
  });

  it("rejects a bundle whose component digest does not match the pin", async () => {
    const root = await createRoot();
    const { bundlePath, release } = await createFixtureBundle(root);

    const staged = await stageArcVoiceboxComponentFromBundle({
      release: {
        ...release,
        componentSha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      bundlePath,
      stagingDir: join(root, "staging", "0.5.0"),
      probe: probeReporting(ARC_VOICEBOX_RELEASE.expectedVersionOutput),
    });

    expect(staged.kind).toBe("rejected");
    expect(staged.kind === "rejected" ? staged.reason : "").toContain(
      "digest mismatch",
    );
  });

  it("rejects a component whose version output is not the pinned one", async () => {
    const root = await createRoot();
    const { bundlePath, release } = await createFixtureBundle(root);

    const staged = await stageArcVoiceboxComponentFromBundle({
      release,
      bundlePath,
      stagingDir: join(root, "staging", "0.5.0"),
      probe: probeReporting("voicebox-server 0.6.0"),
    });

    expect(staged.kind).toBe("rejected");
    expect(staged.kind === "rejected" ? staged.reason : "").toContain(
      "version probe reported",
    );
  });

  it("rejects a bundle path that is not a bundle directory", async () => {
    const root = await createRoot();
    const { release } = await createFixtureBundle(root);

    const staged = await stageArcVoiceboxComponentFromBundle({
      release,
      bundlePath: join(root, "missing", "Voicebox.app"),
      stagingDir: join(root, "staging", "0.5.0"),
    });

    expect(staged).toEqual({
      kind: "rejected",
      reason: `${release.assetName} bundle ${join(root, "missing", "Voicebox.app")} is not a directory`,
    });
  });

  it("replaces a stale staged component from an earlier attempt", async () => {
    const root = await createRoot();
    const { bundlePath, release } = await createFixtureBundle(root);
    const stagingDir = join(root, "staging", "0.5.0");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "stale-file"), "leftover", "utf8");

    await stageArcVoiceboxComponentFromBundle({
      release,
      bundlePath,
      stagingDir,
      probe: probeReporting(ARC_VOICEBOX_RELEASE.expectedVersionOutput),
    });

    expect(
      await stat(join(stagingDir, "stale-file")).catch(() => null),
    ).toBeNull();
  });
});

describe("stageArcVoiceboxComponentFromFile", () => {
  it("stages a component the release pipeline already extracted", async () => {
    const root = await createRoot();
    const { release } = await createFixtureBundle(root);
    const componentPath = join(root, "voicebox-server");
    await writeFile(componentPath, COMPONENT_BYTES, "utf8");
    const pinned = {
      ...release,
      componentSha256: await sha256File(componentPath),
    };

    const staged = await stageArcVoiceboxComponentFromFile({
      release: pinned,
      componentPath,
      stagingDir: join(root, "staging", "0.5.0"),
      probe: probeReporting(ARC_VOICEBOX_RELEASE.expectedVersionOutput),
    });

    expect(staged.kind).toBe("ok");
  });

  it("rejects a source that is not a file", async () => {
    const root = await createRoot();
    const { release } = await createFixtureBundle(root);

    const staged = await stageArcVoiceboxComponentFromFile({
      release,
      componentPath: root,
      stagingDir: join(root, "staging", "0.5.0"),
    });

    expect(staged).toEqual({
      kind: "rejected",
      reason: `component source ${root} is not a regular file`,
    });
  });

  it("rejects a source that does not exist", async () => {
    const root = await createRoot();
    const { release } = await createFixtureBundle(root);
    const missing = join(root, "absent");

    const staged = await stageArcVoiceboxComponentFromFile({
      release,
      componentPath: missing,
      stagingDir: join(root, "staging", "0.5.0"),
    });

    expect(staged.kind).toBe("rejected");
    expect(staged.kind === "rejected" ? staged.reason : "").toContain(
      `component source ${missing} is unreadable`,
    );
  });
});
