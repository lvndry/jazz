/** Native source assets embedded by Bun when building a standalone executable. */
declare module "*.c" {
  const source: string;
  export default source;
}
