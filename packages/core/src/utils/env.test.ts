import { describe, expect, it } from "bun:test";
import { AGENT_PROCESS_ENV, createSanitizedEnv } from "./env";

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

  it("passes PASSWORD_STORE_DIR through despite matching the sensitive-name scrub", () => {
    const originalValue = process.env["PASSWORD_STORE_DIR"];
    process.env["PASSWORD_STORE_DIR"] = "/data/password-store";

    try {
      const sanitized = createSanitizedEnv();
      expect(sanitized["PASSWORD_STORE_DIR"]).toBe("/data/password-store");
    } finally {
      if (originalValue === undefined) {
        delete process.env["PASSWORD_STORE_DIR"];
      } else {
        process.env["PASSWORD_STORE_DIR"] = originalValue;
      }
    }
  });

  it("withholds Jazz's own secret variables and secret-named ones, and passes ordinary names", () => {
    const variables: Record<string, string> = {
      JAZZ_NOTIFY_OPS_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
      JAZZ_PEER_TOKEN_SAM: "peer-token-value",
      JAZZ_WEBHOOK_SECRET_DEPLOY: "signing-secret",
      APP_KEY: "base64:abcdef",
      DB_PASS: "hunter2",
      NPM_AUTH: "npm-auth-value",
      KEYBOARD_LAYOUT: "us",
      TOKENIZER_PATH: "/models/tokenizer.json",
      MONKEY: "banana",
    };
    const originals = Object.fromEntries(
      Object.keys(variables).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, variables);

    try {
      const sanitized = createSanitizedEnv();
      for (const name of [
        "JAZZ_NOTIFY_OPS_WEBHOOK_URL",
        "JAZZ_PEER_TOKEN_SAM",
        "JAZZ_WEBHOOK_SECRET_DEPLOY",
        "APP_KEY",
        "DB_PASS",
        "NPM_AUTH",
      ]) {
        expect(sanitized[name]).toBeUndefined();
      }
      expect(sanitized["KEYBOARD_LAYOUT"]).toBe("us");
      expect(sanitized["TOKENIZER_PATH"]).toBe("/models/tokenizer.json");
      expect(sanitized["MONKEY"]).toBe("banana");
    } finally {
      for (const [name, original] of Object.entries(originals)) {
        if (original === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = original;
        }
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

describe("the agent-process marker", () => {
  it("is set on every environment Jazz builds for an agent's child process", () => {
    expect(createSanitizedEnv()[AGENT_PROCESS_ENV]).toBe("1");
  });
});
