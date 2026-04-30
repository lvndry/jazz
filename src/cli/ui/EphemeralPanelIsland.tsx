import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { EphemeralPanel } from "./EphemeralPanel";
import { store, type EphemeralRegion } from "./store";

/** Maximum panels rendered simultaneously; overflow shown as a single hint. */
export const MAX_VISIBLE_PANELS = 4;

/**
 * Renders the live ephemeral panels (reasoning + subagents) as a stack
 * above the prompt. Capped at MAX_VISIBLE_PANELS; overflow appears as a
 * single dim line summarizing how many more are running.
 */
function EphemeralPanelIslandComponent(): React.ReactElement | null {
  const [regions, setRegions] = useState<readonly EphemeralRegion[]>([]);
  const initializedRef = useRef(false);

  if (!initializedRef.current) {
    // registerEphemeralRegionsSetter already hydrates the setter with the
    // current snapshot, so no separate setRegions(snapshot) call is needed.
    store.registerEphemeralRegionsSetter(setRegions);
    initializedRef.current = true;
  }

  useEffect(() => {
    return () => {
      store.registerEphemeralRegionsSetter(() => {});
    };
  }, []);

  if (regions.length === 0) return null;

  const visible = regions.slice(0, MAX_VISIBLE_PANELS);
  const hidden = regions.length - visible.length;

  return (
    <Box flexDirection="column">
      {visible.map((region) => (
        <EphemeralPanel
          key={region.id}
          region={region}
        />
      ))}
      {hidden > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            … +{hidden} more {hidden === 1 ? "activity" : "activities"} running
          </Text>
        </Box>
      )}
    </Box>
  );
}

export const EphemeralPanelIsland = React.memo(EphemeralPanelIslandComponent);
