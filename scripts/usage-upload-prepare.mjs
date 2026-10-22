// Prepare the minimal upload file from the local display file (dashboard-usage.json). Reads one file, writes one file, prints counts and times only.
// usage: node scripts/usage-upload-prepare.mjs <dashboard-usage.json> <output.json>
// Keep the output outside the repository; it is real quota data and must not be committed.
import { readFileSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectUsage } from '../cloud/usage-project.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: usage-upload-prepare.mjs <input.json> <output.json>'); process.exit(2); }
const info = lstatSync(input);
if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) { console.error('Invalid usage source'); process.exit(1); }
if (existsSync(output)) { console.error('Refusing to overwrite an existing output file'); process.exit(1); }
const projected = projectUsage(JSON.parse(readFileSync(input, 'utf8').replace(/^﻿/, '')));
const text = JSON.stringify(projected);
if (Buffer.byteLength(text) > 100000) { console.error('Output exceeds the 100KB upload limit'); process.exit(1); }
writeFileSync(output, text, { flag: 'wx' });
console.log(JSON.stringify({ output: resolve(output), bytes: Buffer.byteLength(text), cards: projected.cards.map(card => ({ provider: card.provider, status: card.status, collected_at: card.collected_at, argon: Boolean(card.argon_weekly) })) }));
