import { describe, expect, it } from "bun:test";
import { declinedOutcome, failureOutcome } from "./failure";

describe("failureOutcome", () => {
  it("says a refused send sent nothing and names the reconnect for an expired sign-in", () => {
    expect(failureOutcome("mcp_slack_post_message", "401 token expired")).toEqual({
      notDone: "nothing was sent",
      remedy: "/mcp reconnect slack",
    });
  });

  it("offers a reconnect when the server behind a tool is not there", () => {
    expect(failureOutcome("mcp_notion_search", "connect ECONNREFUSED 127.0.0.1:3000")).toEqual({
      remedy: "/mcp reconnect notion",
    });
  });

  it("says an atomic file write left the file as it was", () => {
    expect(failureOutcome("write_file", "EACCES: permission denied")).toEqual({
      notDone: "the file was not changed",
    });
  });

  it("claims nothing for calls that can fail part-way", () => {
    expect(failureOutcome("rm", "EBUSY")).toEqual({});
    expect(failureOutcome("execute_command", "exit code 1")).toEqual({});
  });

  it("offers no remedy it cannot back up", () => {
    expect(failureOutcome("mcp_slack_post_message", "channel_not_found")).toEqual({
      notDone: "nothing was sent",
    });
  });
});

describe("declinedOutcome", () => {
  it("says what a declined call did not do, for every kind of call", () => {
    expect(declinedOutcome("rm")).toBe("nothing was deleted");
    expect(declinedOutcome("mcp_gmail_send_email")).toBe("nothing was sent");
    expect(declinedOutcome("execute_command")).toBe("the command did not run");
    expect(declinedOutcome("web_search")).toBe("it did not run");
  });
});
