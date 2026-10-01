/**
 * Renderer-independent facts shown in a conversation. These values contain source
 * text and outcomes, never terminal escapes, React nodes, geometry, continuations,
 * secret drafts, or viewport preferences. Surfaces project entries into their own
 * layout; history stores the same settled entries without reconstructing meaning
 * from formatted output.
 */
import type { TerminalReport } from "../interfaces/terminal";

export interface ReceiptDiffPreview {
  readonly lines: readonly string[];
  readonly hiddenLines: number;
}

export interface ToolReceiptFacts {
  readonly app: string;
  readonly summary: string;
  readonly status: "ok" | "failed" | "denied";
  readonly args?: string;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly notDone?: string;
  readonly remedyKey?: string;
  readonly detail?: string;
  readonly outputPreview?: string;
  readonly classifiedRisk?: string;
  readonly diffPreview?: ReceiptDiffPreview;
}

export interface PresentationStepStats {
  readonly durationMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly costUSD?: number;
  readonly tokensPerSecond?: number;
  /** First generated token through stream end, excluding prefill and tool time. */
  readonly generationDurationMs?: number;
}

export interface StoppedFacts {
  readonly elapsedMs: number;
  readonly done: readonly string[];
  readonly notDone: readonly string[];
}

export type PresentationContent =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "agent"; readonly markdown: string }
  | {
      readonly kind: "reasoning";
      readonly text: string;
      readonly label: string;
      readonly durationMs?: number;
      readonly steps?: number;
      readonly tokens?: number;
    }
  | { readonly kind: "tool"; readonly receipt: ToolReceiptFacts }
  | {
      readonly kind: "notice";
      readonly text: string;
      readonly tone: "info" | "success" | "warn" | "error" | "debug" | "log";
      readonly audience?: "classic";
    }
  | { readonly kind: "report"; readonly report: TerminalReport }
  | {
      readonly kind: "header";
      readonly name: string;
      readonly provider?: string;
      readonly model?: string;
    }
  | { readonly kind: "turn-receipt"; readonly steps: readonly PresentationStepStats[] }
  | { readonly kind: "stopped"; readonly summary: StoppedFacts }
  | { readonly kind: "expanded"; readonly text: string };

export interface PresentationEntry {
  readonly id: string;
  readonly content: PresentationContent;
  readonly timestamp: string;
}

export interface PresentationDocument {
  readonly id: string;
  readonly revision: number;
  readonly entries: readonly PresentationEntry[];
  /** Streaming is a lifecycle fact. Its entry keeps this identity when settled. */
  readonly streamingId?: string;
}
