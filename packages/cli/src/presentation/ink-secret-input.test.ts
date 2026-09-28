import { beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { InkPresentationService } from "./ink-presentation-service";
import { store } from "../ui/store";

const SECRET = "typed-in-the-prompt-42";

function presentation(): InkPresentationService {
  return new InkPresentationService(
    { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
    null,
  );
}

function transcriptText(): string {
  store.flushOutputBatchNow();
  return JSON.stringify(store.getOutputSnapshot().entries.map((entry) => entry.message));
}

describe("InkPresentationService.requestSecretInput", () => {
  beforeEach(() => {
    store.clearOutputs();
    store.setPrompt(null);
  });

  it("opens a concealed prompt and keeps only the placeholder in the transcript", async () => {
    const pending = Effect.runPromise(
      presentation().requestSecretInput({ prompt: "Password for a.pdf", name: "pdf-password" }),
    );
    const prompt = store.getPromptSlice().prompt;
    expect(prompt?.type).toBe("password");
    expect(prompt?.options?.["conceal"]).toBe(true);
    expect(prompt?.message).toBe("Password for a.pdf");

    prompt?.resolve(SECRET);
    expect(await pending).toEqual({ kind: "provided", value: SECRET });
    expect(store.getPromptSlice().prompt).toBeNull();
    const transcript = transcriptText();
    expect(transcript).toContain("[redacted:pdf-password]");
    expect(transcript).not.toContain(SECRET);
  });

  it("reads Esc as the person declining", async () => {
    const pending = Effect.runPromise(
      presentation().requestSecretInput({ prompt: "Token", name: "token" }),
    );
    store.getPromptSlice().prompt?.reject?.();
    expect(await pending).toEqual({ kind: "declined" });
    expect(store.getPromptSlice().prompt).toBeNull();
  });

  it("reads an empty submit as the person declining", async () => {
    const pending = Effect.runPromise(
      presentation().requestSecretInput({ prompt: "Token", name: "token" }),
    );
    store.getPromptSlice().prompt?.resolve("");
    expect(await pending).toEqual({ kind: "declined" });
  });
});
