---
description: "Understand how Jazz stores credentials, scrubs shell environments, classifies disclosed data, and controls tools that send information over the network."
---

# Secrets, data disclosure, and network egress

Jazz treats reading data, revealing data, and sending data as different properties.

- **Secrets:** configuration writes use the system keyring when available. Do not place tokens in agent prompts, workflow files, or committed project configuration.
- **Shell environment:** variables with sensitive names are removed before `execute_command` unless an agent explicitly allowlists the variable name.
- **Disclosure:** tools label the class of information they may return, allowing a surface such as a webhook or peer to set a ceiling.
- **Egress:** tools that send data out of the process are marked separately. A locally read-only tool can still be dangerous if it transmits private content.
- **MCP:** server definitions and credentials are external input. Jazz tracks whether the user has trusted a server before exposing its tools broadly.

These controls do not replace operating-system permissions or network isolation. A shell tool running as your user can reach whatever that user can reach unless the environment constrains it.
