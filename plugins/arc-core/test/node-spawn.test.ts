import { describe, expect, it } from "vitest";
import { createNodeOmpSpawn } from "../src/node-spawn.js";

describe("createNodeOmpSpawn", () => {
  it("spawns a child, streams stdout chunks, and resolves its exit", async () => {
    const spawn = createNodeOmpSpawn();
    const child = spawn({
      executablePath: process.execPath,
      env: { ...process.env },
      argv: ["-e", 'process.stdout.write("hello"); process.exit(7)'],
    });

    const chunks: string[] = [];
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    child.onStdoutData((chunk) => chunks.push(chunk));
    const waitPromise = child.wait().then((result) => {
      exit = result;
    });

    // Interactive-style partial writes (no trailing newline) must arrive.
    child.writeLine("ignored input");
    await waitPromise;

    expect(chunks.join("")).toBe("hello");
    const exitResult: { code: number | null; signal: NodeJS.Signals | null } =
      exit as unknown as {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
    expect(exitResult.code).toBe(7);
  });

  it("captures stderr separately from stdout", async () => {
    const spawn = createNodeOmpSpawn();
    const child = spawn({
      executablePath: process.execPath,
      env: { ...process.env },
      argv: ["-e", 'process.stderr.write("err-out")'],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    child.onStdoutData((chunk) => stdout.push(chunk));
    child.onStderrData((chunk) => stderr.push(chunk));
    await child.wait();

    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe("err-out");
  });
});
