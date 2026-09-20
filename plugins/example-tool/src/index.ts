/**
 * A minimal example plugin: contributes one read-only, offline, model-callable tool. It shows the
 * smallest complete shape of a tool plugin — declare the tool in the manifest, register its handler
 * here — with no network, secrets, hooks, or decision providers.
 */

import type { JazzPluginModule } from "@jazz/plugin-sdk";

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
    api.tools.register({
      name: "reverse_text",
      handler: (args) => {
        const text = typeof args["text"] === "string" ? args["text"] : "";
        return Promise.resolve({ content: [...text].reverse().join("") });
      },
    });
  },
};

export default plugin;
