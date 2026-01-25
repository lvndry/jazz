import { Box, Text } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import React from "react";
import packageJson from "../../../package.json";

interface LayoutProps {
  children: React.ReactNode;
  sidebar?: React.ReactNode | undefined;
  title?: string | undefined;
  footer?: string | undefined;
}

/**
 * Global Layout Component
 *
 * Provides the "Claude-like" framed shell for the entire application.
 * Features:
 * - Cyan rounded border
 * - Gradient Logo Header
 * - Split content area (Main + Sidebar)
 * - Footer area
 */
export function Layout({ children, sidebar, title, footer }: LayoutProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      width="100%"
      // height="100%" // Let content drive height for now, or fixed? Ink usually manages height.
    >
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={1}>
        <Box flexDirection="column">
            <Gradient name="morning">
                <BigText text="Jazz" font="tiny" />
            </Gradient>
            <Text dimColor>v{packageJson.version} • {title || "Your AI Agent Framework"}</Text>
        </Box>
        <Box>
           <Text>🎷</Text>
        </Box>
      </Box>

      {/* Main Content Area */}
      <Box flexDirection="row" marginTop={1}>
        {/* Main Column */}
        <Box flexDirection="column" width={sidebar ? "60%" : "100%"} paddingRight={sidebar ? 2 : 0}>
          {children}
        </Box>

        {/* Optional Sidebar */}
        {sidebar && (
          <>
            {/* Vertical Separator */}
            <Box marginRight={2}>
                <Text dimColor>│</Text>
            </Box>

            {/* Sidebar Column */}
            <Box flexDirection="column" width="35%">
              {sidebar}
            </Box>
          </>
        )}
      </Box>

      {/* Footer */}
      {(footer) && (
        <Box marginTop={2} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderBottom={false}>
          <Text dimColor>{footer}</Text>
        </Box>
      )}
    </Box>
  );
}
