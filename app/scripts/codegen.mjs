// Generates a typed @solana/kit client for the perps program from the Anchor IDL.
// Run `anchor build` first, then `npm run codegen`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const idlPath = path.join(appDir, '..', 'target', 'idl', 'my_defi_dapp.json');
const idl = JSON.parse(readFileSync(idlPath, 'utf8'));

const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(appDir, {
    generatedFolder: 'src/generated',
    syncPackageJson: false,
    erasableSyntax: true,
  }),
);
console.log('Generated client in src/generated');
