#!/usr/bin/env node
'use strict';
// Usage: node cli.js <reportFolder> [output.pdf] [--title "My Test"] [--format A4|A3|Letter|Legal] [--portrait] [--no-cover]
const fs = require('fs');
const path = require('path');
const { convertReport } = require('./src/converter');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };

const title = flag('--title');
const format = flag('--format');
const portrait = bool('--portrait');
const noCover = bool('--no-cover');
const [input, outputArg] = args;
if (!input) {
  console.log('Usage: node cli.js <reportFolder> [output.pdf] [--title "My Test"] [--format A4|A3|Letter|Legal] [--portrait] [--no-cover]');
  process.exit(1);
}
const output = path.resolve(outputArg || path.join(path.dirname(path.resolve(input)), `${path.basename(path.resolve(input))}.pdf`));

convertReport(path.resolve(input), { title, format, landscape: !portrait, cover: !noCover, log: console.log })
  .then((r) => { fs.writeFileSync(output, r.pdf); console.log(`PDF saved: ${output} (${r.pages} pages)`); })
  .catch((e) => { console.error(`Error: ${e.message}`); process.exit(2); });
