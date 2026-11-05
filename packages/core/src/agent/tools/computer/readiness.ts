import { Effect } from "effect";
import type { ToolReadiness } from "@/core/interfaces/tool-registry";
import { computerUseSupported } from "./driver-pin";

/** Computer use is offered only where the desktop driver can run: macOS on Apple Silicon. */
export function computerUseReadiness(): Effect.Effect<ToolReadiness> {
  if (computerUseSupported()) {
    return Effect.succeed({ ready: true });
  }
  return Effect.succeed({
    ready: false,
    reason: "unsupported_platform",
    remedy: "Computer use runs on macOS with Apple Silicon only.",
  });
}
