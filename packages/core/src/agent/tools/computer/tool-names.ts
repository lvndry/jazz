/**
 * The names of the computer tools, kept apart from their implementations so the code that
 * decides which tools a run gets can name them without loading the desktop driver.
 */

export const COMPUTER_APPS_TOOL_NAME = "computer_apps";
export const COMPUTER_OBSERVE_TOOL_NAME = "computer_observe";
export const COMPUTER_POINTER_TOOL_NAME = "computer_pointer";
export const COMPUTER_INPUT_TOOL_NAME = "computer_input";
export const COMPUTER_FOREGROUND_TOOL_NAME = "computer_foreground";
export const COMPUTER_HANDOFF_TOOL_NAME = "computer_handoff";
export const COMPUTER_END_TOOL_NAME = "computer_end";

/** Every name the computer tools register, including the hidden half of each approval pair. */
export const COMPUTER_TOOL_NAMES: readonly string[] = [
  COMPUTER_APPS_TOOL_NAME,
  COMPUTER_OBSERVE_TOOL_NAME,
  COMPUTER_POINTER_TOOL_NAME,
  COMPUTER_INPUT_TOOL_NAME,
  COMPUTER_FOREGROUND_TOOL_NAME,
  COMPUTER_HANDOFF_TOOL_NAME,
  COMPUTER_END_TOOL_NAME,
  `execute_${COMPUTER_POINTER_TOOL_NAME}`,
  `execute_${COMPUTER_INPUT_TOOL_NAME}`,
  `execute_${COMPUTER_FOREGROUND_TOOL_NAME}`,
  `execute_${COMPUTER_HANDOFF_TOOL_NAME}`,
];
