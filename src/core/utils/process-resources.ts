/**
 * Snapshot Jazz's own process resources.
 *
 * These numbers are the harness process (Bun/Node): RSS, V8 heap, and CPU
 * time since process start. They are not the model server. A local LLM's GPU
 * and CPU live in Ollama, llama.cpp, or similar — Jazz is waiting on HTTP.
 */
import type { ProcessResourceSnapshot } from "@/core/interfaces/telemetry";

export function sampleProcessResources(): ProcessResourceSnapshot {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
  };
}
