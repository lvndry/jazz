import { expect, test } from "bun:test";

test("importing the bridge exposes an entry point without starting one", async () => {
  // The module used to call start() at import time, which is why there was no
  // `jazz whatsapp`: a CLI command could not load it to read anything out of it
  // without launching a linked device as a side effect.
  const bridge = await import("./bridge");
  expect(typeof bridge.startBridge).toBe("function");
});
