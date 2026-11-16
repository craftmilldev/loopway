import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "./tui-theme.js";

/** Rows the header takes, so views can give the rest of the screen to their body. */
export const HEADER_ROWS = 3;

/** The sign: loopway and its version, always shown, and the poller's status a row below. */
export function Header({ version, status, children }: { version: string; status: string; children?: ReactNode }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.madder}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
    >
      <Text wrap="truncate-end">
        <Text backgroundColor={theme.red} color={theme.cream} bold>
          {" loopway "}
        </Text>
        <Text color={theme.land}> v{version}</Text>
        {children}
      </Text>
      <Text dimColor wrap="truncate-end">
        {status}
      </Text>
    </Box>
  );
}

/** The keys, pinned to the bottom of the screen. */
export function Footer({ keys }: { keys: [key: string, what: string][] }) {
  return (
    <Text wrap="truncate-end">
      {keys.map(([key, what], i) => (
        <Text key={key}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text color={theme.cream} bold>
            {key}
          </Text>
          <Text dimColor> {what}</Text>
        </Text>
      ))}
    </Text>
  );
}
