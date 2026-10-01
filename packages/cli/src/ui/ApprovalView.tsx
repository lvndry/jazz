/**
 * The classic terminal's active approval card. Approval facts are read from the
 * pending interaction, never appended to the document or serialized as output.
 * Prompt owns deny-first timing and controls; this view only displays the request.
 */
import { Box, Text } from "ink";
import React from "react";
import { approvalAccount, approvalFacts } from "./models/approval";
import type { PendingApproval } from "./store";
import { clipTerminalCells } from "./text/terminal-cells";
import { THEME, PADDING } from "./theme";

export function ApprovalView({
  request,
}: {
  readonly request: PendingApproval;
}): React.ReactElement {
  const facts = approvalFacts(request);
  const fields = [
    { label: "Account", value: approvalAccount(facts.account, facts.app) },
    ...facts.fields,
    ...(facts.intent.impact === undefined ? [] : [facts.intent.impact]),
  ];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.warning}
      paddingX={PADDING.content}
    >
      <Text bold>
        {facts.title}
        {facts.consequence.length === 0 ? "" : ` · ${facts.consequence}`}
      </Text>
      {fields.map((field, index) => (
        <Text key={`${String(index)}:${field.label}`}>
          {field.label}: {clipTerminalCells(field.value.replace(/\s+/g, " "), 120)}
        </Text>
      ))}
      {facts.intent.command === undefined ? null : (
        <Text>$ {clipTerminalCells(facts.intent.command.text.replace(/\s+/g, " "), 120)}</Text>
      )}
      {facts.intent.diff === undefined ? null : (
        <Text>
          +{String(facts.intent.diff.added)} −{String(facts.intent.diff.removed)} · Ctrl+O to view
          the diff
        </Text>
      )}
      {facts.warning === undefined ? null : <Text color={THEME.warning}>{facts.warning}</Text>}
    </Box>
  );
}
