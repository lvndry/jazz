import { Box, Text, useInput } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import SelectInput from "ink-select-input";
import React, { useState, useEffect } from "react";
import { THEME } from "./theme";
import packageJson from "../../../package.json";

/**
 * Menu option for the wizard
 */
export interface WizardMenuOption {
  label: string;
  value: string;
}

interface WizardHomeProps {
  options: WizardMenuOption[];
  onSelect: (value: string) => void;
  onExit: () => void;
  title?: string;
}

const TIPS = [
  // CLI Shortcuts
  "Type '/help' in chat to see special commands like /clear and /debug",
  // "Use 'Arrow Up' in chat to recall your previous messages",
  "Run 'jazz agent list' to see all your active agents",

  // Agent Management
  "Agents work best with specific, focused descriptions",
  "Delete unused agents to keep your workspace clean",

  // Integrations & Tools
  "Use the email skill (Himalaya) to let agents read, send, and manage your inbox",
  "Use the calendar skill (khal) to let agents view and manage your schedule",
  "The 'fs' tools allow agents to read and write files in your project",
  "Enable Web Search to give your agent up-to-date knowledge",
  "Agents can use 'grep' to search your codebase instantly",
  "Use /tools to see which tools are available",

  // Advanced Features
  "Jazz supports MCP! Connect to Notion, GitHub, and 100+ other services",
  "Use Agent Skills to teach complex workflows to your agents",
  "Switch LLM models mid-chat if you need more intelligence or speed",
  "Local models via Ollama are supported for offline privacy",

  // Workflow Tips
  "Ask agents to 'plan first' for complex coding tasks",
  // "You can paste images into the terminal for multimodal analysis",
  "Agents can read PDFs! Just give them the file path",
  "Ask an agent to 'summarize this conversation' to catch up",
  "Chain commands: 'Find TODOs then create a summary file'",

  // Troubleshooting
  "Use '/new' to clear the context and start a new conversation",
  "Use 'jazz config show' to see your configuration",
  "Check 'jazz update' regularly for new features",

  // Fun/Power User
  "You can have multiple agents running in different terminal tabs",
  "Agents can write their own tests before writing code",
  "Try asking an agent to 'optimize your system prompt'",
  "Jazz agents never execute dangerous commands without approval",
  "The 'shell' tool is sandboxed but powerful - use with care!",
];

/**
 * WizardHome - The main interactive home screen for Jazz CLI
 */
export function WizardHome({
  options,
  onSelect,
  onExit,
  title,
}: WizardHomeProps): React.ReactElement {
  const [tipIndex, setTipIndex] = useState(0);

  // Rotate tips occasionally or just on mount
  useEffect(() => {
    setTipIndex(Math.floor(Math.random() * TIPS.length));
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onExit();
    }
    if (input === "q") {
      onExit();
    }
  });

  const items = options.map((option) => ({
    label: option.label,
    value: option.value,
  }));

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      {/* Logo */}
      <Box
        flexDirection="column"
        alignItems="center"
        marginBottom={1}
      >
        <Gradient name="morning">
          <BigText
            text="Jazz"
            font="block"
          />
        </Gradient>
        <Text dimColor>v{packageJson.version} • Agentic CLI 🎷</Text>
      </Box>

      {/* Menu */}
      <Box
        flexDirection="column"
        marginTop={1}
        paddingX={1}
        paddingY={0}
      >
        <Box marginBottom={1}>
          <Text
            bold
            color="white"
          >
            {title || "What would you like to do?"}
          </Text>
        </Box>

        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value)}
          indicatorComponent={IndicatorComponent}
          itemComponent={ItemComponent}
        />
      </Box>

      {/* Tip — below menu, subtle */}
      <Box
        marginTop={1}
        flexDirection="column"
      >
        <Text dimColor>{"─".repeat(40)}</Text>
        <Box marginTop={1}>
          <Text color={THEME.primary}>💡 </Text>
          <Text
            dimColor
            wrap="wrap"
          >
            {TIPS[tipIndex]}
          </Text>
        </Box>
      </Box>

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color={THEME.primary}>↑/↓</Text> navigate · <Text color={THEME.primary}>Enter</Text>{" "}
          select · <Text color={THEME.primary}>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}

function IndicatorComponent({ isSelected = false }: { isSelected?: boolean }): React.ReactElement {
  return (
    <Box marginRight={1}>
      {isSelected ? (
        <Text
          color={THEME.primary}
          bold
        >
          ❯
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

function ItemComponent({
  isSelected = false,
  label,
}: {
  isSelected?: boolean;
  label: string;
}): React.ReactElement {
  return (
    <Box>
      <Text
        color={isSelected ? THEME.selected : "white"}
        bold={isSelected}
      >
        {label}
      </Text>
    </Box>
  );
}

export default WizardHome;
