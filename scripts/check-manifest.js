// Checks that manifest.json is valid, its version matches package.json, and
// every file it points to exists.
import { readFileSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const errors = [];

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (manifest.version !== pkg.version) errors.push(`manifest version ${manifest.version} != package.json ${pkg.version}`);

const files = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])])
];
for (const f of files) if (f && !existsSync(f)) errors.push(`missing file: ${f}`);

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const tag = process.env.GITHUB_REF_NAME.replace(/^v/, '');
  if (tag !== manifest.version) errors.push(`tag v${tag} does not match manifest version ${manifest.version}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`manifest OK (v${manifest.version}, ${files.length} files)`);
