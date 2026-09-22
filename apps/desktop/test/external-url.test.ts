import { describe, expect, it } from "vitest";
import { parseExternalHttpUrl } from "../src/external-url.js";

describe("parseExternalHttpUrl", () => {
  it("allows http and https URLs", () => {
    expect(parseExternalHttpUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(parseExternalHttpUrl("http://127.0.0.1:4000")).toBe(
      "http://127.0.0.1:4000/",
    );
  });

  it("rejects non-http(s) schemes so they never reach shell.openExternal", () => {
    expect(parseExternalHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(
      parseExternalHttpUrl("x-apple.systempreferences:com.apple.preference"),
    ).toBeNull();
    expect(parseExternalHttpUrl("some-other-app://payload")).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(parseExternalHttpUrl("not a url")).toBeNull();
    expect(parseExternalHttpUrl("")).toBeNull();
  });
});
