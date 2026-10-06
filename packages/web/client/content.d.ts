// Markdown files are bundled as plain text (see scripts/client.ts).
declare module "*.md" {
  const text: string;
  export default text;
}
