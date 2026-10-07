// Markdown and SVG files are bundled as plain text (see scripts/client.ts).
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.svg" {
  const text: string;
  export default text;
}
