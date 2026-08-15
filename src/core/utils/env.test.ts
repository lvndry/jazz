import { describe, expect, it } from "bun:test";
import { createSanitizedEnv } from "./env";

describe("createSanitizedEnv", () => {
  it("scrubs sensitive-looking env vars by default", () => {
    const originalValue = process.env["MY_SECRET_TOKEN"];
    process.env["MY_SECRET_TOKEN"] = "super-secret-value";

    try {
      const sanitized = createSanitizedEnv();
      expect(sanitized["MY_SECRET_TOKEN"]).toBeUndefined();
    } finally {
      if (originalValue === undefined) {
        delete process.env["MY_SECRET_TOKEN"];
      } else {
        process.env["MY_SECRET_TOKEN"] = originalValue;
      }
    }
  });

  it("copies an allowlisted var through even though it matches the scrub regex", () => {
    const originalValue = process.env["MY_SECRET_TOKEN"];
    process.env["MY_SECRET_TOKEN"] = "super-secret-value";

    try {
      const sanitized = createSanitizedEnv({}, ["MY_SECRET_TOKEN"]);
      expect(sanitized["MY_SECRET_TOKEN"]).toBe("super-secret-value");
    } finally {
      if (originalValue === undefined) {
        delete process.env["MY_SECRET_TOKEN"];
      } else {
        process.env["MY_SECRET_TOKEN"] = originalValue;
      }
    }
  });

  it("does not invent an allowlisted var that is absent from process.env", () => {
    const originalValue = process.env["MY_ABSENT_TOKEN"];
    delete process.env["MY_ABSENT_TOKEN"];

    try {
      const sanitized = createSanitizedEnv({}, ["MY_ABSENT_TOKEN"]);
      expect(sanitized["MY_ABSENT_TOKEN"]).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(sanitized, "MY_ABSENT_TOKEN")).toBe(false);
    } finally {
      if (originalValue !== undefined) {
        process.env["MY_ABSENT_TOKEN"] = originalValue;
      }
    }
  });

  it("still scrubs non-allowlisted sensitive vars when an allowlist is provided", () => {
    const originalSecret = process.env["OTHER_SECRET_KEY"];
    const originalAllowed = process.env["MY_SECRET_TOKEN"];
    process.env["OTHER_SECRET_KEY"] = "should-be-scrubbed";
    process.env["MY_SECRET_TOKEN"] = "should-pass";

    try {
      const sanitized = createSanitizedEnv({}, ["MY_SECRET_TOKEN"]);
      expect(sanitized["OTHER_SECRET_KEY"]).toBeUndefined();
      expect(sanitized["MY_SECRET_TOKEN"]).toBe("should-pass");
    } finally {
      if (originalSecret === undefined) {
        delete process.env["OTHER_SECRET_KEY"];
      } else {
        process.env["OTHER_SECRET_KEY"] = originalSecret;
      }
      if (originalAllowed === undefined) {
        delete process.env["MY_SECRET_TOKEN"];
      } else {
        process.env["MY_SECRET_TOKEN"] = originalAllowed;
      }
    }
  });

  it("still blocks SSH_* vars even when allowlisted", () => {
    const originalValue = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = "/tmp/ssh-agent.sock";

    try {
      const sanitized = createSanitizedEnv({}, ["SSH_AUTH_SOCK"]);
      expect(sanitized["SSH_AUTH_SOCK"]).toBeUndefined();
    } finally {
      if (originalValue === undefined) {
        delete process.env["SSH_AUTH_SOCK"];
      } else {
        process.env["SSH_AUTH_SOCK"] = originalValue;
      }
    }
  });
});
