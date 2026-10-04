import { describe, expect, test } from "bun:test";
import {
  ALLOW_READING_SECRETS_ENV_VAR,
  planUserSecrets,
  secretUseNeedsPerson,
  substituteUserSecrets,
  unheldUserSecretNamesIn,
  UserSecretStore,
} from "@/core/secrets/user-secrets";

function storeHolding(name: string, value: string): UserSecretStore {
  const store = new UserSecretStore();
  store.hold(name, value);
  return store;
}

describe("typed-secret argument paths", () => {
  test("treats a top-level name as that argument's string", () => {
    const store = storeHolding("pdf-password", "hunter2");
    const args = { password: "[redacted:pdf-password]", path: "a.pdf" };

    expect(planUserSecrets(args, ["password"], store)).toEqual({
      kind: "substitute",
      names: ["pdf-password"],
    });
    expect(substituteUserSecrets(args, ["password"], store)).toEqual({
      password: "hunter2",
      path: "a.pdf",
    });
  });

  test("reaches a field of each array element when the path names it", () => {
    const store = storeHolding("site-password", "hunter2");
    const args = {
      actions: [
        { action: "type", ref: "e1", text: "ada" },
        { action: "type", ref: "e2", text: "[redacted:site-password]" },
      ],
    };

    expect(planUserSecrets(args, ["actions[].text"], store)).toEqual({
      kind: "substitute",
      names: ["site-password"],
    });
    expect(substituteUserSecrets(args, ["actions[].text"], store)).toEqual({
      actions: [
        { action: "type", ref: "e1", text: "ada" },
        { action: "type", ref: "e2", text: "hunter2" },
      ],
    });
  });

  test("refuses a placeholder in an array field the path does not name", () => {
    const store = storeHolding("site-password", "hunter2");
    const args = { actions: [{ action: "press", key: "[redacted:site-password]" }] };

    expect(planUserSecrets(args, ["actions[].text"], store)).toEqual({
      kind: "refuse",
      names: ["site-password"],
      toolAccepts: true,
    });
  });

  test("refuses a placeholder in a sibling argument next to an accepted array field", () => {
    const store = storeHolding("site-password", "hunter2");
    const args = {
      note: "[redacted:site-password]",
      actions: [{ action: "type", ref: "e1", text: "[redacted:site-password]" }],
    };

    expect(planUserSecrets(args, ["actions[].text"], store).kind).toBe("refuse");
  });

  test("refuses a placeholder nested deeper than the accepted string", () => {
    const store = storeHolding("site-password", "hunter2");
    const args = { text: { inner: "[redacted:site-password]" } };

    expect(planUserSecrets(args, ["text"], store).kind).toBe("refuse");
  });

  test("refuses every placeholder when the tool accepts none", () => {
    const store = storeHolding("site-password", "hunter2");

    expect(planUserSecrets({ text: "[redacted:site-password]" }, [], store)).toEqual({
      kind: "refuse",
      names: ["site-password"],
      toolAccepts: false,
    });
  });

  test("leaves a call without a typed-secret placeholder as written", () => {
    const store = storeHolding("site-password", "hunter2");
    const args = { actions: [{ action: "type", ref: "e1", text: "ada" }] };

    expect(planUserSecrets(args, ["actions[].text"], store)).toEqual({ kind: "none" });
  });

  test("keeps a placeholder this run holds no value for", () => {
    const store = storeHolding("site-password", "hunter2");
    const args = { actions: [{ action: "type", ref: "e1", text: "[redacted:other-name]" }] };

    expect(substituteUserSecrets(args, ["actions[].text"], store)).toEqual(args);
  });
});

describe("unheldUserSecretNamesIn", () => {
  test("names a user-secret placeholder the run does not hold, only in accepted arguments", () => {
    const store = storeHolding("pdf-password", "hunter2");
    const args = {
      command: "curl -H 'X: [redacted:cloudflare-token]' -u '[redacted:pdf-password]'",
      description: "uses [redacted:github-token]",
    };
    expect(unheldUserSecretNamesIn(args, ["command"], store)).toEqual(["cloudflare-token"]);
  });

  test("ignores config and environment placeholders", () => {
    const args = { command: "echo [redacted:llm.openai.api_key] [redacted:API_TOKEN]" };
    expect(unheldUserSecretNamesIn(args, ["command"], new UserSecretStore())).toEqual([]);
  });
});

describe("secretUseNeedsPerson", () => {
  test("asks a person unless the run explicitly allows reading secrets", () => {
    expect(secretUseNeedsPerson({})).toBe(true);
    expect(secretUseNeedsPerson({ [ALLOW_READING_SECRETS_ENV_VAR]: "0" })).toBe(true);
    expect(secretUseNeedsPerson({ [ALLOW_READING_SECRETS_ENV_VAR]: "false" })).toBe(true);
    expect(secretUseNeedsPerson({ [ALLOW_READING_SECRETS_ENV_VAR]: "1" })).toBe(false);
  });
});
