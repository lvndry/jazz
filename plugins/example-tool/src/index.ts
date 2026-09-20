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

    // A real notifier plugin (e.g. Warp) would raise a desktop notification here — this example
    // just demonstrates the shape. The handler is fire-and-forget: its result is ignored and a
    // throw or timeout can never affect the run.
    api.lifecycle.register({
      event: "run-complete",
      handler: (event) => {
        void event.data?.["summary"]; // e.g. Bun.spawn(["osascript","-e", ...]) to notify
        return Promise.resolve();
      },
    });
  },
};

export default plugin;
