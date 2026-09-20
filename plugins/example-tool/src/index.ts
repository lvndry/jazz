/**
 * A minimal example plugin: contributes one read-only, offline, model-callable tool and one
 * user-invoked slash command. It shows the smallest complete shapes — declare each in the manifest,
 * register its handler here — with no network, secrets, hooks, or decision providers.
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

    api.commands.register({
      name: "greet",
      handler: ({ args }) => {
        const who = args.join(" ").trim();
        return Promise.resolve({
          message: who.length > 0 ? `Greet ${who} warmly.` : "Greet the user warmly.",
        });
      },
    });
  },
};

export default plugin;
