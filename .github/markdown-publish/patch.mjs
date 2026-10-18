// Patches the markdown-publish generator's source before it builds the site.
// The upstream GitHub Action has no options for canvas behaviour or custom CSS,
// so the workflow installs the CLI, runs this script, then builds.
//
// Usage: node patch.mjs <markdown-publish package dir> [custom.css]
//
// Every patch matches exact upstream text and fails the build if it is missing,
// so an upstream change can't silently drop a fix. Pinned to v1.0.6 in
// .github/workflows/publish.yml — re-check these anchors when bumping it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Zoom a canvas opens at when the whole board can't fit on screen at this size
// or larger (1 = same size as in Obsidian).
const READABLE_ZOOM = 1;

const [pkgDir, customCss] = process.argv.slice(2);
if (!pkgDir) {
  console.error('Usage: node patch.mjs <markdown-publish package dir> [custom.css]');
  process.exit(1);
}

function patch(rel, find, replace, what) {
  const file = join(pkgDir, rel);
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const matches = typeof find === 'string' ? src.split(find).length - 1 : (src.match(find) ?? []).length;
  if (matches !== 1) {
    throw new Error(`patch "${what}": expected 1 match in ${rel}, found ${matches}`);
  }
  writeFileSync(file, src.replace(find, () => replace));
  console.log(`patched: ${what}`);
}

// 1. Edges: 90-degree elbows (like Advanced Canvas "square" paths) instead of
//    bezier curves. curvature is the corner radius for SmoothStep; 0 = sharp.
patch(
  'src/app/app.config.ts',
  "import { DfArrowhead, ",
  "import { DfArrowhead, DfConnectionType, ",
  'import DfConnectionType',
);
patch(
  'src/app/app.config.ts',
  'arrowhead: { type: DfArrowhead.Arrow },',
  'arrowhead: { type: DfArrowhead.Arrow },\n        type: DfConnectionType.SmoothStep,\n        curvature: 0,',
  'elbow connections',
);

// 2. Initial zoom: upstream always zooms out to fit the whole board, which makes
//    big canvases unreadable. Keep that only when the fit is already readable;
//    otherwise open at READABLE_ZOOM with the left edge of the board in view,
//    vertically centred on the left-most card (the root of a left-to-right map).
patch(
  'src/app/views/canvas-view.ts',
  /const zoom = Math\.min\(\n\s*MAX_ZOOM,[\s\S]*?flow\.setPosition\(\{ x: -cx \* zoom, y: -cy \* zoom, zoom \}\);/,
  `const fitZoom = Math.min(vw / cw, vh / ch) * FIT_PADDING;
    if (fitZoom >= ${READABLE_ZOOM}) {
      const zoom = Math.min(MAX_ZOOM, fitZoom);
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      flow.setPosition({ x: -cx * zoom, y: -cy * zoom, zoom });
      return;
    }
    const zoom = ${READABLE_ZOOM};
    const cards = (this.canvas.value()?.nodes ?? []).filter((n) => n.kind !== 'group');
    const root = cards.reduce<(typeof cards)[number] | undefined>(
      (best, n) => (!best || n.x < best.x ? n : best),
      undefined,
    );
    const cy = root ? root.y + root.height / 2 : (bounds.minY + bounds.maxY) / 2;
    const margin = 40;
    flow.setPosition({ x: -bounds.minX * zoom - vw / 2 + margin, y: -cy * zoom, zoom });`,
  'readable initial zoom',
);

// 3. Cards: grow any text card whose content doesn't fit, so all text shows
//    without resizing by hand. Grows equally up and down (node positions are
//    centres, so the position stays put): the arrows attach to the middle of
//    each side, so they keep the alignment set up in Obsidian. Waits until
//    every node is in the DOM and its images have loaded (a big board takes
//    more than a frame or two to render), then repeats until nothing
//    overflows: a taller card gets slightly taller spacers (see custom.css),
//    so one pass can leave a pixel or so still overflowing.
patch(
  'src/app/views/canvas-view.ts',
  `      if (model) {
        this.ctrl.setValue(model);
      }`,
  `      if (model) {
        this.ctrl.setValue(model);
        if (this.isBrowser) {
          void document.fonts.ready.then(() => this.growWhenRendered(model.nodes.length));
        }
      }`,
  'schedule card auto-grow',
);
patch(
  'src/app/views/canvas-view.ts',
  '  private fit(): void {',
  `  private growWhenRendered(expected: number, frames = 0): void {
    const root = this.flowEl()?.nativeElement as HTMLElement | undefined;
    const rendered = root?.querySelectorAll('[data-draw-flow-node]').length ?? 0;
    if (!root || rendered < expected) {
      // Give up after ~10s rather than polling forever.
      if (frames < 600) {
        requestAnimationFrame(() => this.growWhenRendered(expected, frames + 1));
      }
      return;
    }
    const pending = [...root.querySelectorAll<HTMLImageElement>('app-markdown-node img')]
      .filter((img) => !img.complete)
      .map((img) => new Promise((done) => {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }));
    const pass = (left: number): void => {
      requestAnimationFrame(() => {
        if (this.growToFit() && left > 1) {
          pass(left - 1);
        }
      });
    };
    void Promise.all(pending).then(() => pass(10));
  }

  /** Grows overflowing text cards; returns whether any card grew. */
  private growToFit(): boolean {
    const root = this.flowEl()?.nativeElement as HTMLElement | undefined;
    if (!root) {
      return false;
    }
    const heights = new Map<string, number>();
    root.querySelectorAll<HTMLElement>('app-markdown-node').forEach((card) => {
      const id = card.closest<HTMLElement>('[data-draw-flow-node]')?.dataset['nodeId'];
      const border = card.offsetHeight - card.clientHeight;
      if (id && card.scrollHeight > card.clientHeight) {
        heights.set(id, Math.ceil(card.scrollHeight + border));
      }
    });
    if (!heights.size) {
      return false;
    }
    const value = this.ctrl.value;
    this.ctrl.setValue({
      ...value,
      nodes: value.nodes.map((n) => {
        const h = heights.get(n.id);
        if (h === undefined || !('position' in n)) {
          return n;
        }
        return { ...n, data: { ...n.data, height: h } };
      }),
    });
    return true;
  }

  private fit(): void {`,
  'card auto-grow',
);

// 4. Single line breaks render as line breaks, as in Obsidian (with its default
//    "Strict line breaks" off), e.g. "A Physical God\\n(the Old Testament)".
patch(
  'tools/vault-parser/markdown.ts',
  'html: false,\n    linkify: true,',
  'html: false,\n    breaks: true,\n    linkify: true,',
  'markdown line breaks',
);

// 5. Append the repo's custom CSS to the global stylesheet.
if (customCss) {
  const css = readFileSync(customCss, 'utf8');
  const styles = join(pkgDir, 'src/styles.scss');
  writeFileSync(styles, `${readFileSync(styles, 'utf8')}\n\n/* ---- ${customCss} ---- */\n${css}\n`);
  console.log(`appended: ${customCss}`);
}
