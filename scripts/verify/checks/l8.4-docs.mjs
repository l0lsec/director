import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, sh, root } from '../lib.mjs';

export default async function () {
  // Regenerating from the catalog must reproduce the committed file exactly.
  const r = sh('npx', ['tsx', 'scripts/docs/agents-doc.ts', '--check'], { allowFail: true });
  assert(r.status === 0 && /AGENTS\.md is current/.test(r.stdout), `docs/AGENTS.md is stale: ${r.stderr || r.stdout}`);
  const doc = readFileSync(join(root, 'docs', 'AGENTS.md'), 'utf8');
  // Every tool has a section; every argument has a description; no em dashes.
  const names = JSON.parse(sh('npx', ['tsx', '-e', "import {tools, jsonSchema} from './packages/agent/src/index.ts'; const out = [...tools().values()].map((t) => ({ name: t.name, undocumented: Object.entries(jsonSchema(t).properties ?? {}).filter(([, p]) => !p.description).map(([k]) => k) })); console.log(JSON.stringify(out));"]).stdout.trim());
  const missing = names.filter((t) => !doc.includes(`### \`${t.name}\``));
  const undocumented = names.flatMap((t) => t.undocumented.map((k) => `${t.name}.${k}`));
  assert(!missing.length && !undocumented.length, `missing sections ${missing}; undocumented arguments ${undocumented}`);
  assert(!doc.includes(String.fromCharCode(0x2014)), 'em dash in AGENTS.md');
  for (const h of ['## Connect', '## Safety', '## How to work', '## MCP resources and prompts', '## Creative vocabulary', '## What stays with the person']) assert(doc.includes(h), `missing ${h}`);
  return `${r.stdout.trim()}; ${names.length} tool sections, every argument described, no em dashes`;
}
