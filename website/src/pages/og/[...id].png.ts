import { getCollection } from "astro:content";

import { titleOf } from "../../lib/docs";
import type { DocsEntry } from "../../lib/docs";
import { renderOgImage } from "../../lib/og";

interface OgProps {
  title: string;
  subtitle: string;
}

export async function getStaticPaths() {
  const entries = await getCollection("docs");
  const docPaths = entries.map((entry: DocsEntry) => ({
    params: { id: entry.id },
    props: {
      title: titleOf(entry),
      subtitle: "jazz docs · one agent · every surface",
    } satisfies OgProps,
  }));
  return [
    {
      params: { id: "home" },
      props: {
        title: "Your computer, finally useful.",
        subtitle: "one agent · every surface · your rules",
      } satisfies OgProps,
    },
    ...docPaths,
  ];
}

export function GET(context: { props: OgProps }): Response {
  const png = renderOgImage(context.props.title, context.props.subtitle);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
}
