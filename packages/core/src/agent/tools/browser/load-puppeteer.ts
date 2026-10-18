import type { PuppeteerNode } from "puppeteer-core";

/** `puppeteer-core`, loaded when a tool first drives a browser instead of when the tools register. */
export async function loadPuppeteer(): Promise<PuppeteerNode> {
  return (await import("puppeteer-core")).default;
}
