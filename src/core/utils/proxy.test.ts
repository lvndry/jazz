import { describe, expect, test } from "bun:test";
import { findUnsupportedProxy, installProxyFromEnvironment, readProxySettings } from "./proxy";

describe("readProxySettings", () => {
  test("returns null when nothing is configured", () => {
    expect(readProxySettings({})).toBeNull();
  });

  test("returns null when the variables are empty or whitespace", () => {
    expect(readProxySettings({ HTTP_PROXY: "", HTTPS_PROXY: "   " })).toBeNull();
  });

  test("reads uppercase variables", () => {
    expect(
      readProxySettings({
        HTTP_PROXY: "http://proxy.corp:3128",
        HTTPS_PROXY: "http://secure.corp:3129",
        NO_PROXY: "localhost,.corp",
      }),
    ).toEqual({
      httpProxy: "http://proxy.corp:3128",
      httpsProxy: "http://secure.corp:3129",
      noProxy: "localhost,.corp",
    });
  });

  test("prefers lowercase over uppercase", () => {
    expect(
      readProxySettings({
        http_proxy: "http://lower:3128",
        HTTP_PROXY: "http://upper:3128",
      }),
    ).toEqual({ httpProxy: "http://lower:3128" });
  });

  test("falls back to ALL_PROXY for the protocol that has no value of its own", () => {
    expect(
      readProxySettings({
        ALL_PROXY: "http://all:3128",
        HTTPS_PROXY: "http://secure:3129",
      }),
    ).toEqual({ httpProxy: "http://all:3128", httpsProxy: "http://secure:3129" });
  });

  test("trims surrounding whitespace", () => {
    expect(readProxySettings({ HTTPS_PROXY: "  http://proxy.corp:3128  " })).toEqual({
      httpsProxy: "http://proxy.corp:3128",
    });
  });
});

describe("findUnsupportedProxy", () => {
  test("accepts http and https proxies", () => {
    expect(
      findUnsupportedProxy({
        httpProxy: "http://proxy.corp:3128",
        httpsProxy: "https://proxy.corp:3129",
      }),
    ).toBeNull();
  });

  test("rejects socks proxies", () => {
    expect(findUnsupportedProxy({ httpProxy: "socks5://proxy.corp:1080" })).toContain("socks5://");
  });

  test("rejects host-only values, which are not URLs undici can dial", () => {
    expect(findUnsupportedProxy({ httpsProxy: "proxy.corp:3128" })).toContain("not supported");
  });

  test("rejects unparseable values", () => {
    expect(findUnsupportedProxy({ httpsProxy: "http://[" })).toContain("not a valid URL");
  });
});

describe("installProxyFromEnvironment", () => {
  test("does nothing when no proxy is configured", async () => {
    expect(await installProxyFromEnvironment({})).toEqual({ status: "not-configured" });
  });

  test("reports unsupported proxies instead of installing them", async () => {
    const result = await installProxyFromEnvironment({ ALL_PROXY: "socks5://proxy.corp:1080" });
    expect(result.status).toBe("unsupported");
  });

  test("defers to the runtime under Bun", async () => {
    const result = await installProxyFromEnvironment({ HTTPS_PROXY: "http://proxy.corp:3128" });
    expect(result.status).toBe("runtime-native");
    expect(result).toMatchObject({ settings: { httpsProxy: "http://proxy.corp:3128" } });
  });
});
