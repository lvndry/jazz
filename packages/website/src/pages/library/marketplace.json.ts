/** Static unified marketplace index for website clients and future catalog consumers. */

import {
  getPersonaEntries,
  getPluginEntries,
  getSkillEntries,
  getWorkflowEntries,
  personaPath,
  pluginManifestPath,
  pluginPath,
  rawPersonaPath,
  rawSkillPath,
  rawWorkflowPath,
  skillPath,
  workflowPath,
} from "../../lib/library";

export async function GET(): Promise<Response> {
  const [personas, workflows, skills, plugins] = await Promise.all([
    getPersonaEntries(),
    getWorkflowEntries(),
    getSkillEntries(),
    getPluginEntries(),
  ]);

  const entries = [
    ...personas.map((entry) => ({
      kind: "persona" as const,
      name: entry.data.name,
      description: entry.data.description,
      page: personaPath(entry.data.name),
      source: rawPersonaPath(entry.data.name),
      ...(entry.data.tags.length > 0 ? { tags: entry.data.tags } : {}),
    })),
    ...workflows.map((entry) => ({
      kind: "workflow" as const,
      name: entry.data.name,
      description: entry.data.description,
      page: workflowPath(entry.data.name),
      source: rawWorkflowPath(entry.data.name),
      ...(entry.data.tags.length > 0 ? { tags: entry.data.tags } : {}),
    })),
    ...skills.map((entry) => ({
      kind: "skill" as const,
      name: entry.name,
      description: entry.description,
      page: skillPath(entry.id),
      source: rawSkillPath(entry.id),
      instructionOnly: true as const,
    })),
    ...plugins.map((entry) => ({
      kind: "plugin" as const,
      listingType: entry.sourceType,
      id: entry.id,
      name: entry.name,
      description:
        entry.sourceType === "community" && entry.description !== undefined
          ? entry.description
          : `${entry.name} (${entry.id})`,
      page: pluginPath(entry.id),
      source: entry.sourceType === "reviewed" ? pluginManifestPath(entry.id) : entry.manifestUrl,
      version: entry.version,
      executable: true as const,
      ...(entry.sourceType === "reviewed"
        ? { sha256: entry.sha256 }
        : {
            trustTier: entry.trustTier,
            repository: entry.repository,
            repositoryUrl: entry.repositoryUrl,
            defaultBranch: entry.defaultBranch,
            sourceSha: entry.sourceSha,
            manifestSha256: entry.manifestSha256,
            install: `jazz plugin add ${entry.repository}@${entry.sourceSha}`,
          }),
    })),
  ];

  return new Response(JSON.stringify({ schemaVersion: 1, entries }, null, 2), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
