/**
 * Subset the Source Han Serif VF fonts down to only the glyphs actually used
 * by the simplified / traditional Chinese translation mods.
 *
 * Source fonts live in `resources/fonts/` (not packaged into the mod).
 * Subset outputs are written into `resources/static_chs/` and
 * `resources/static_cht/`, where the install step picks them up.
 *
 * Run with:   bun run scripts/subsetFonts.ts
 * (Make sure `npm run build` has been run first so build/ contains the final
 * lang.js files — those are the most authoritative source of glyphs.)
 *
 * Requires `pyftsubset` (from fontTools): `python3 -m pip install --user fonttools brotli`
 * We use pyftsubset instead of the JS `subset-font` package because the
 * harfbuzzjs WASM build that subset-font relies on cannot handle subsetting
 * large CJK variable fonts like Source Han Serif VF (~55MB OTF).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const FONTS_DIR = path.join(ROOT, 'resources', 'fonts');
const BUILD_DIR = path.join(ROOT, 'build');
const SCRIPT_DIR = path.join(ROOT, 'resources', 'script');
const GLYPHS_DIR = path.join(ROOT, 'resources', 'glyphs');

type Variant = {
  name: string;
  /** Base name without extension, e.g. "SourceHanSerifSC-VF". */
  sourceBase: string;
  outFont: string;
  /** Path to the persisted sorted-glyph list used for change detection. */
  glyphList: string;
  // Directories / files whose text contributes glyphs for this variant.
  sources: string[];
};

const variants: Variant[] = [
  {
    name: 'Simplified Chinese',
    sourceBase: 'SourceHanSerifSC-VF',
    outFont: path.join(ROOT, 'resources', 'static_chs', 'SourceHanSerifSC-VF.otf.woff2'),
    glyphList: path.join(GLYPHS_DIR, 'chs.txt'),
    sources: [
      path.join(BUILD_DIR, 'CookieClickerCNMod'),
      path.join(SCRIPT_DIR, 'main.js'),
      path.join(SCRIPT_DIR, 'chs.js'),
    ],
  },
  {
    name: 'Traditional Chinese',
    sourceBase: 'SourceHanSerifTC-VF',
    outFont: path.join(ROOT, 'resources', 'static_cht', 'SourceHanSerifTC-VF.otf.woff2'),
    glyphList: path.join(GLYPHS_DIR, 'cht.txt'),
    sources: [
      path.join(BUILD_DIR, 'CookieClickerTCNMod'),
      path.join(SCRIPT_DIR, 'main.js'),
      path.join(SCRIPT_DIR, 'cht.js'),
    ],
  },
];

function resolveSourceFont(base: string): string {
  // Prefer raw SFNT; pyftsubset reads .woff2 too via brotli but the raw OTF
  // is faster and avoids an extra decode step.
  const candidates = [`${base}.otf`, `${base}.ttf`, `${base}.otf.woff2`, `${base}.woff2`, `${base}.woff`];
  for (const c of candidates) {
    const full = path.join(FONTS_DIR, c);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(
    `No source font found for ${base} in ${path.relative(ROOT, FONTS_DIR)}. ` +
      `Tried: ${candidates.join(', ')}`
  );
}

function readAllText(target: string, out: string[]): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      readAllText(path.join(target, entry), out);
    }
  } else if (stat.isFile()) {
    out.push(fs.readFileSync(target, 'utf-8'));
  }
}

function collectGlyphs(sources: string[]): string[] {
  const chunks: string[] = [];
  for (const src of sources) {
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ Source not found, skipping: ${path.relative(ROOT, src)}`);
      continue;
    }
    readAllText(src, chunks);
  }
  const set = new Set<string>();
  for (const chunk of chunks) {
    for (const ch of chunk) set.add(ch);
  }
  // Sort by codepoint for stable, diff-friendly output.
  return [...set].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
}

function checkPyftsubset(): void {
  const r = spawnSync('pyftsubset', ['--help'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    throw new Error(
      `pyftsubset not found. Install with:\n` +
        `  python3 -m pip install --user fonttools brotli\n` +
        `and make sure ~/.local/bin is on your PATH.`
    );
  }
}

async function subsetVariant(v: Variant): Promise<void> {
  console.log(`\n[${v.name}]`);

  const glyphs = collectGlyphs(v.sources);
  const text = glyphs.join('');
  const cjk = glyphs.filter(ch => {
    const cp = ch.codePointAt(0)!;
    return (
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2ffff)
    );
  }).length;
  console.log(`  ✓ Collected ${glyphs.length} unique codepoints (${cjk} CJK)`);

  // One codepoint per line so it diffs nicely in git / pull requests.
  const listContent = glyphs.join('\n') + '\n';

  // Skip subsetting if the glyph set is unchanged AND the output font already exists.
  let previousList: string | null = null;
  try {
    previousList = fs.readFileSync(v.glyphList, 'utf-8');
  } catch {
    // first run or list missing
  }
  const outputExists = fs.existsSync(v.outFont);
  if (previousList === listContent && outputExists) {
    console.log(`  ⏭  Glyph set unchanged, keeping existing ${path.relative(ROOT, v.outFont)}`);
    return;
  }
  if (previousList !== null && previousList !== listContent) {
    const before = new Set(previousList.split('\n').filter(Boolean));
    const after = new Set(glyphs);
    const added = [...after].filter(c => !before.has(c));
    const removed = [...before].filter(c => !after.has(c));
    console.log(`  • Glyph diff: +${added.length} / -${removed.length}`);
    if (added.length && added.length <= 30) console.log(`    added:   ${added.join(' ')}`);
    if (removed.length && removed.length <= 30) console.log(`    removed: ${removed.join(' ')}`);
  }

  const sourceFont = resolveSourceFont(v.sourceBase);
  console.log(`  • Source: ${path.relative(ROOT, sourceFont)}`);

  // pyftsubset's --text=... is awkward with large CJK input; use --text-file instead.
  const tmpText = path.join(os.tmpdir(), `subset-${path.basename(v.sourceBase)}.txt`);
  fs.writeFileSync(tmpText, text, 'utf-8');

  fs.mkdirSync(path.dirname(v.outFont), { recursive: true });

  const srcBytes = fs.statSync(sourceFont).size;

  // Keep the wght variable axis intact so font-weight: 400 and 900 both work.
  // --layout-features=* preserves all OpenType layout features (kerning etc.).
  const args = [
    sourceFont,
    `--text-file=${tmpText}`,
    `--output-file=${v.outFont}`,
    '--flavor=woff2',
    '--layout-features=*',
    '--drop-tables+=DSIG',
    '--no-hinting',
  ];

  const t0 = Date.now();
  const proc = spawnSync('pyftsubset', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.unlinkSync(tmpText);

  if (proc.status !== 0) {
    throw new Error(`pyftsubset exited with status ${proc.status}`);
  }

  // Persist the glyph list only after a successful subset, so a failed run
  // doesn't poison the cache and skip subsequent attempts.
  fs.mkdirSync(path.dirname(v.glyphList), { recursive: true });
  fs.writeFileSync(v.glyphList, listContent, 'utf-8');

  const outBytes = fs.statSync(v.outFont).size;
  const ms = Date.now() - t0;
  console.log(
    `  ✓ Wrote ${path.relative(ROOT, v.outFont)}  ` +
      `(${(srcBytes / 1024 / 1024).toFixed(1)} MB → ${(outBytes / 1024).toFixed(1)} KB, ${ms} ms)`
  );
}

async function main(): Promise<void> {
  console.log('Subsetting Source Han Serif VF fonts…');
  checkPyftsubset();
  if (!fs.existsSync(BUILD_DIR)) {
    console.warn(
      '⚠ build/ directory not found. Run `npm run build` first for the most accurate glyph coverage.'
    );
  }
  for (const v of variants) {
    await subsetVariant(v);
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
