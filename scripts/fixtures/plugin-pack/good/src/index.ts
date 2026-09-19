/** Fixture that proves package dependencies are bundled into one artifact. */
import { z } from "zod";

export default {
  apiVersion: 1,
  register(api: {
    readonly hooks: {
      register(
        id: "route.skills",
        handler: (input: {
          readonly skills: readonly { readonly name: string; readonly description: string }[];
        }) => Promise<unknown>,
      ): void;
    };
  }) {
    z.string().parse("bundled");
    api.hooks.register("route.skills", (input) =>
      Promise.resolve({
        status: "answered",
        distribution: {
          skills: input.skills.map((skill, index) => ({
            name: skill.name,
            probability: index === 0 ? 1 : 0,
          })),
          noSkillProbability: 0,
        },
      }),
    );
  },
};
