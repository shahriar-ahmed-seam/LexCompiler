import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG 2.x AA: 4.5:1 for normal-size text (most UI text here is 10–12 px).
const AA = 4.5;

/** Tailwind v4 palette from its own theme.css (OKLCH or hex), as linear sRGB. */
function loadPalette(): Map<string, [number, number, number]> {
  const css = fs.readFileSync(path.join(process.cwd(), 'node_modules/tailwindcss/theme.css'), 'utf8');
  const out = new Map<string, [number, number, number]>();
  for (const m of css.matchAll(/--color-([a-z]+(?:-\d+)?):\s*([^;]+);/g)) {
    const v = m[2].trim();
    const ok = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/.exec(v);
    if (ok) out.set(m[1], oklchToLinearSrgb(Number(ok[1]) / 100, Number(ok[2]), Number(ok[3])));
    else if (/^#[0-9a-f]{3,6}$/i.test(v)) out.set(m[1], hexToLinear(v));
  }
  return out;
}

function oklchToLinearSrgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function hexToLinear(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c).slice(1) : hex.slice(1);
  return [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function contrast(x: [number, number, number], y: [number, number, number]) {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []
  );
}

const palette = loadPalette();
const files = sourceFiles(path.join(process.cwd(), 'src')).map((f) => ({ file: path.relative(process.cwd(), f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
// The engine console (/lab) is dark; the product app (src/product) is light, apart from src/product/dark.
const isLight = (file: string) => file.startsWith('src/product/') && !file.startsWith('src/product/dark/');
const darkFiles = files.filter((f) => !isLight(f.file));
const lightFiles = files.filter((f) => isLight(f.file));
// Dark panel backgrounds the UI paints (arbitrary hex classes plus the body colour).
const panels = [...new Set(darkFiles.flatMap((f) => [...f.text.matchAll(/bg-\[(#[0-9A-Fa-f]{6})\]/g)].map((m) => m[1].toLowerCase())))].concat('#050609');
const lightestPanel = panels.map((hex) => [hex, hexToLinear(hex)] as const).sort((a, b) => luminance(b[1]) - luminance(a[1]))[0];

describe('colour contrast (WCAG AA)', () => {
  it('reads the Tailwind palette', () => {
    expect(palette.size).toBeGreaterThan(200);
    // Sanity check of the OKLCH conversion against Tailwind's published sRGB for zinc-400 (#9f9fa9).
    expect(contrast(palette.get('zinc-400')!, hexToLinear('#9f9fa9'))).toBeLessThan(1.02);
  });

  it('every text colour used reaches 4.5:1 on the lightest dark panel', () => {
    const failures: string[] = [];
    for (const f of darkFiles) {
      for (const m of f.text.matchAll(/(?<![\w:-])(hover:)?text-([a-z]+-\d{2,3})(?![\w/-])/g)) {
        const colour = palette.get(m[2]);
        if (!colour) continue;
        const ratio = contrast(colour, lightestPanel[1]);
        if (ratio < AA) failures.push(`${f.file}: ${m[0]} = ${ratio.toFixed(2)}:1 on ${lightestPanel[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every text colour in the light product app reaches 4.5:1 on its page background', () => {
    // #fafafa (zinc-50) is the page and table-header colour; cards are white, which contrasts more.
    const page = hexToLinear('#fafafa');
    const failures: string[] = [];
    for (const f of lightFiles) {
      // Icons are graphics, not text: lucide-react components are skipped (WCAG 1.4.3 covers text).
      const icons = [...f.text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'lucide-react'/g)].flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean));
      const iconRanges = icons.length
        ? [...f.text.matchAll(new RegExp(`<(?:${icons.join('|')})\\b[^>]*?/>`, 'g'))].map((m) => [m.index!, m.index! + m[0].length] as const)
        : [];
      for (const m of f.text.matchAll(/(?<![\w:-])(hover:)?text-([a-z]+-\d{2,3})(?![\w/-])/g)) {
        if (iconRanges.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
        const colour = palette.get(m[2]);
        if (!colour) continue;
        const ratio = contrast(colour, page);
        if (ratio < AA) failures.push(`${f.file}: ${m[0]} = ${ratio.toFixed(2)}:1 on #fafafa`);
      }
    }
    expect(failures).toEqual([]);
  });
  it('white or black text on a solid colour reaches 4.5:1, hover state included', () => {
    const failures: string[] = [];
    for (const f of files) {
      for (const lit of f.text.matchAll(/["'`]([^"'`]*\btext-(white|black)\b[^"'`]*)["'`]/g)) {
        const fg = palette.get(lit[2])!;
        for (const bg of lit[1].matchAll(/(?<![\w:-])(hover:)?bg-([a-z]+-\d{2,3})(?![\w/-])/g)) {
          const colour = palette.get(bg[2]);
          if (!colour) continue;
          const ratio = contrast(fg, colour);
          if (ratio < AA) failures.push(`${f.file}: text-${lit[2]} on ${bg[0]} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
