import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'apps/web/out');
const templatePath = join(root, 'apps/web/public/_headers');
const inlineDir = join(outDir, '_next/static/inline');

async function htmlFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(child));
    else if (entry.name.endsWith('.html')) files.push(child);
  }
  return files;
}

await mkdir(inlineDir, { recursive: true });
const writes = new Map();
let extracted = 0;
for (const file of await htmlFiles(outDir)) {
  const html = await readFile(file, 'utf8');
  const rewritten = html.replace(
    /<script((?:(?!\ssrc=)[^>])*)>([\s\S]*?)<\/script>/giu,
    (tag, attributes, body) => {
      if (!body) return tag;
      const digest = createHash('sha256').update(body).digest('hex');
      const filename = `${digest}.js`;
      writes.set(filename, body);
      extracted += 1;
      return `<script${attributes} src="/_next/static/inline/${filename}"></script>`;
    },
  );
  if (
    [...rewritten.matchAll(/<script((?:(?!\ssrc=)[^>])*)>([\s\S]*?)<\/script>/giu)]
      .some((match) => Boolean(match[2]))
  ) {
    throw new Error(`Inline script remained after CSP extraction: ${file}`);
  }
  await writeFile(file, rewritten, 'utf8');
}

if (extracted === 0) {
  throw new Error('No inline scripts found; refusing to claim CSP extraction succeeded');
}
await Promise.all([...writes].map(([filename, body]) =>
  writeFile(join(inlineDir, filename), body, 'utf8')));

const template = await readFile(templatePath, 'utf8');
if (template.includes("script-src 'unsafe-inline'")) {
  throw new Error('CSP template must not allow inline scripts');
}
for (const [index, line] of template.split(/\r?\n/u).entries()) {
  if (line.length > 2_000) {
    throw new Error(`Cloudflare Pages _headers line ${index + 1} exceeds 2,000 characters`);
  }
}
await writeFile(join(outDir, '_headers'), template, 'utf8');
console.log(`Externalized ${extracted} inline scripts into ${writes.size} same-origin assets for CSP.`);
