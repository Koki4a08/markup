// Downloads the Google Fonts catalog and writes the compact shape the editor bundles.
// Run by hand: node scripts/gen-google-fonts.mjs   (output is committed)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://fonts.google.com/metadata/fonts';
const OUT = fileURLToPath(new URL('../apps/app/src/fonts/google-fonts.json', import.meta.url));

const res = await fetch(URL_);
if (!res.ok) throw new Error(`${URL_} responded ${res.status}`);
const text = (await res.text()).replace(/^\)\]\}'\s*/, '');
const list = JSON.parse(text).familyMetadataList;
if (!Array.isArray(list) || !list.length) throw new Error('familyMetadataList missing');

const out = list.map((f) => ({
  family: f.family,
  styles: Object.keys(f.fonts)
    .map((k) => ({ weight: parseInt(k, 10), italic: k.endsWith('i') }))
    .filter((s) => Number.isFinite(s.weight))
    .sort((a, b) => Number(a.italic) - Number(b.italic) || a.weight - b.weight),
  axes: (f.axes ?? []).map((a) => ({ tag: a.tag, min: a.min, max: a.max })),
}));
writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${out.length} families to ${OUT}`);
