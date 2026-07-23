import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
const packagesStart = source.indexOf('\npackages:\n');
const snapshotsStart = source.indexOf('\nsnapshots:\n');
if (packagesStart < 0 || snapshotsStart < 0 || snapshotsStart <= packagesStart) {
  throw new Error('Unsupported pnpm lockfile: packages section not found');
}

const packagesSection = source.slice(packagesStart + '\npackages:\n'.length, snapshotsStart);
const packages = new Map();
for (const match of packagesSection.matchAll(/^  (?:'([^']+)'|([^:\n]+)):\s*$/gmu)) {
  const key = match[1] ?? match[2];
  const separator = key.lastIndexOf('@');
  if (separator <= 0) continue;
  const name = key.slice(0, separator);
  const version = key.slice(separator + 1);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) continue;
  packages.set(`${name}@${version}`, {
    package: { ecosystem: 'npm', name },
    version,
  });
}

const queries = [...packages.values()];
const response = await fetch('https://api.osv.dev/v1/querybatch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ queries }),
});
if (!response.ok) throw new Error(`OSV query failed with HTTP ${response.status}`);
const result = await response.json();
const findings = [];
for (const [index, item] of result.results.entries()) {
  for (const vulnerability of item.vulns ?? []) {
    findings.push({
      package: queries[index].package.name,
      version: queries[index].version,
      id: vulnerability.id,
    });
  }
}

if (findings.length > 0) {
  console.error(`OSV dependency scan failed (${findings.length}):`);
  for (const finding of findings) {
    console.error(`- ${finding.id}: ${finding.package}@${finding.version}`);
  }
  process.exitCode = 1;
} else {
  console.log(`OSV dependency scan passed for ${queries.length} locked packages.`);
}
