import { copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = join(__dirname, '../node_modules/emoji-datasource-apple/img/apple/64');
const dest = join(__dirname, '../public/emoji/apple/64');

mkdirSync(dest, { recursive: true });
const files = readdirSync(src);
files.forEach(f => copyFileSync(join(src, f), join(dest, f)));
console.log(`✓ Copied ${files.length} Apple emoji images → public/emoji/apple/64/`);
