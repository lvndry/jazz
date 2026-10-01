import { describe, expect, it } from "bun:test";
import {
  isLocalServerProvider,
  isZeroCostLocalModel,
  LOCAL_MODEL_PROVIDERS,
  localServerAddress,
} from "./local-providers";

describe("LOCAL_MODEL_PROVIDERS", () => {
  it("lists exactly the local model servers", () => {
    expect(LOCAL_MODEL_PROVIDERS).toEqual(["llamacpp", "ollama", "sglang", "vllm"]);
    expect(isLocalServerProvider("llamacpp")).toBe(true);
    expect(isLocalServerProvider("vllm")).toBe(true);
    expect(isLocalServerProvider("sglang")).toBe(true);
    expect(isLocalServerProvider("openai")).toBe(false);
  });
});

describe("isZeroCostLocalModel", () => {
  it("treats local servers as zero-cost", () => {
    expect(isZeroCostLocalModel("llamacpp", "local.gguf")).toBe(true);
    expect(isZeroCostLocalModel("ollama", "qwen3:8b")).toBe(true);
    expect(isZeroCostLocalModel("vllm", "org/model")).toBe(true);
    expect(isZeroCostLocalModel("sglang", "org/model")).toBe(true);
  });

  it("excludes Ollama Cloud models, which bill remotely", () => {
    expect(isZeroCostLocalModel("ollama", "kimi-k3:cloud")).toBe(false);
  });

  it("never claims zero cost for remote providers", () => {
    expect(isZeroCostLocalModel("openai", "gpt-anything")).toBe(false);
    expect(isZeroCostLocalModel("", "")).toBe(false);
  });
});

describe("localServerAddress", () => {
  it("drops the REST path a stored base URL carries", () => {
    expect(localServerAddress("http://127.0.0.1:8090/v1")).toBe("http://127.0.0.1:8090");
    expect(localServerAddress("http://gpu.example:11434/api/")).toBe("http://gpu.example:11434");
  });

  it("keeps a custom reverse-proxy path", () => {
    expect(localServerAddress("https://proxy.example/llama")).toBe("https://proxy.example/llama");
  });

  it("drops userinfo, a query token, and a fragment, which can carry credentials", () => {
    expect(localServerAddress("http://user:sekrit@172.17.0.1:8090/v1")).toBe(
      "http://172.17.0.1:8090",
    );
    expect(localServerAddress("http://172.17.0.1:8090/v1?token=sekrit")).toBe(
      "http://172.17.0.1:8090",
    );
    expect(localServerAddress("http://172.17.0.1:8090/v1#key")).toBe("http://172.17.0.1:8090");
    expect(localServerAddress("https://u:t@proxy.example/llama?api_key=k1")).toBe(
      "https://proxy.example/llama",
    );
  });

  it("still drops the REST path on a loopback URL", () => {
    expect(localServerAddress("http://localhost:8090/v1")).toBe("http://localhost:8090");
  });

  it("degrades to plain stripping when the URL does not parse", () => {
    expect(localServerAddress("not a url")).toBe("not a url");
    expect(localServerAddress("/v1")).toBe("");
  });
});
