/**
 * OpenTUI's measured transcript surface without native navigation ownership.
 * ScrollBox provides the clipping/content layout required by selectable text,
 * but scrollY=false only bounds its content: it still handles wheel, keys and
 * selection-edge scrolling. This adapter keeps that layout and selection tree
 * while every navigation event bubbles to App's viewport controller. Register
 * the transcript_surface intrinsic once and use it only for selected row windows.
 */
import {
  ScrollBoxRenderable,
  type KeyEvent,
  type MouseEvent,
  type RenderContext,
  type ScrollBoxOptions,
} from "@opentui/core";
import { extend } from "@opentui/react";

interface TranscriptSurfaceOptions extends ScrollBoxOptions {
  readonly focused?: boolean;
}

export class TranscriptSurfaceRenderable extends ScrollBoxRenderable {
  constructor(context: RenderContext, options: TranscriptSurfaceOptions) {
    super(context, { ...options, stickyScroll: false, scrollX: false, scrollY: false });
  }

  protected override onMouseEvent(_event: MouseEvent): void {}

  override handleKeyPress(_key: KeyEvent): boolean {
    return false;
  }

  override startAutoScroll(_mouseX: number, _mouseY: number): void {}

  override updateAutoScroll(_mouseX: number, _mouseY: number): void {}
}

extend({ transcript_surface: TranscriptSurfaceRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    transcript_surface: typeof TranscriptSurfaceRenderable;
  }
}
