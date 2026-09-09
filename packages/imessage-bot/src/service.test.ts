import { describe, expect, test } from "bun:test";
import {
  carriedEnvironment,
  renderServicePlist,
  runningUnderLaunchd,
  SERVICE_LABEL,
  type ServiceSpec,
} from "./service";

const SPEC: ServiceSpec = {
  runtime: "/Users/me/.local/bin/jazz",
  args: ["imessage"],
  workingDirectory: "/Users/me/jazz",
  jazzHome: "/Users/me/.jazz-imessage",
  environment: { IMESSAGE_SELF_TRIGGER: "jazz" },
};

describe("renderServicePlist", () => {
  test("names the binary launchd starts, which is what the grant must match", () => {
    expect(renderServicePlist(SPEC)).toContain("<string>/Users/me/.local/bin/jazz</string>");
  });

  test("runs the same command a person would, so there is one way in", () => {
    expect(renderServicePlist(SPEC)).toContain("<string>imessage</string>");
  });

  test("carries several arguments through in order", () => {
    const plist = renderServicePlist({ ...SPEC, args: ["run", "--flag", "value"] });
    const order = ["run", "--flag", "value"].map((arg) => plist.indexOf(`<string>${arg}</string>`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  test("spells out a PATH, since launchd's own reaches none of the usual places", () => {
    // The agent shells out through execute_command, so this is its PATH too.
    expect(renderServicePlist(SPEC)).toContain("/opt/homebrew/bin");
  });

  test("carries the bridge's settings through", () => {
    const plist = renderServicePlist(SPEC);
    expect(plist).toContain("<key>IMESSAGE_SELF_TRIGGER</key>");
    expect(plist).toContain("<string>jazz</string>");
  });

  test("restarts if it dies, well above launchd's default throttle", () => {
    const plist = renderServicePlist(SPEC);
    expect(plist).toContain("<key>KeepAlive</key>");
    // A misconfigured bridge exits at once; 10s would rewrite the same error
    // into the log six times a minute forever.
    expect(plist).toContain("<integer>30</integer>");
  });

  test("escapes a path that would otherwise break the XML", () => {
    const plist = renderServicePlist({
      ...SPEC,
      workingDirectory: "/Users/me/rock & roll/<jazz>",
    });
    expect(plist).toContain("/Users/me/rock &amp; roll/&lt;jazz&gt;");
    expect(plist).not.toContain("rock & roll");
  });

  test("labels the job so launchctl can address it", () => {
    expect(renderServicePlist(SPEC)).toContain(`<string>${SERVICE_LABEL}</string>`);
  });
});

describe("carriedEnvironment", () => {
  test("carries the bridge's own settings", () => {
    expect(carriedEnvironment({ IMESSAGE_ALLOWED_HANDLES: "+15551234567" })).toEqual({
      IMESSAGE_ALLOWED_HANDLES: "+15551234567",
    });
  });

  test("never carries a provider key into a plist, which is not built to hold one", () => {
    const carried = carriedEnvironment({
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      IMESSAGE_SELF_TRIGGER: "jazz",
    });
    expect(carried).toEqual({ IMESSAGE_SELF_TRIGGER: "jazz" });
  });

  test("skips a variable that is set but empty", () => {
    expect(carriedEnvironment({ IMESSAGE_ALLOWED_HANDLES: "" })).toEqual({});
  });
});

describe("runningUnderLaunchd", () => {
  test("recognises a launchd job, so it does not offer to install a second one", () => {
    expect(runningUnderLaunchd({ XPC_SERVICE_NAME: SERVICE_LABEL })).toBe(true);
  });

  test("treats a shell as the foreground, including launchd's placeholder", () => {
    expect(runningUnderLaunchd({})).toBe(false);
    expect(runningUnderLaunchd({ XPC_SERVICE_NAME: "0" })).toBe(false);
  });
});
