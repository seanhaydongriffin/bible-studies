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

// 5. Always check content (notes, canvases, the page list) for changes.
//    GitHub Pages lets browsers reuse files for 10 minutes, and these JSON
//    files are fetched by script, which a hard refresh doesn't always
//    re-fetch: a just-published canvas could show its old version. no-cache
//    asks GitHub each time; an unchanged file costs a tiny "not modified".
patch(
  'src/app/content/content.service.ts',
  'const res = await fetch(url);',
  "const res = await fetch(url, { cache: 'no-cache' });",
  'revalidate content on every load',
);

// 6. Card links: [[Canvas.canvas#card-id]] (Advanced Canvas "Copy wikilink to
//    node") glides to that card and flashes it, as Obsidian zooms to it.
//    Links inside cards route in-app instead of reloading the page, and the
//    #card-id is handled on every navigation, so Back/Forward step between
//    cards and a shared URL ending in #card-id opens the canvas on that card.
patch(
  'src/app/views/canvas-view.ts',
  "import { isPlatformBrowser } from '@angular/common';",
  "import { isPlatformBrowser } from '@angular/common';\nimport { NavigationEnd, Router } from '@angular/router';",
  'card links: import router',
);
patch(
  'src/app/views/canvas-view.ts',
  '  protected readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));',
  `  protected readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly router = inject(Router);
  private panTimer?: ReturnType<typeof setTimeout>;`,
  'card links: router field',
);
patch(
  'src/app/views/canvas-view.ts',
  "      document.addEventListener('mp-resize-start', onResizeStart);",
  `      // A link inside a card: route in-app (no page reload). The pointerdown
      // position tells a click from a drag that happened to end on a link.
      let linkDownX = 0;
      let linkDownY = 0;
      const onLinkDown = (event: PointerEvent) => {
        linkDownX = event.clientX;
        linkDownY = event.clientY;
      };
      const onLinkClick = (event: MouseEvent) => {
        const a = (event.target as Element).closest<HTMLAnchorElement>('ng-draw-flow a.wikilink');
        if (!a || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        if (a.classList.contains('broken') || Math.hypot(event.clientX - linkDownX, event.clientY - linkDownY) > 4) {
          return;
        }
        const url = new URL(a.getAttribute('href') ?? '', document.baseURI);
        const base = new URL(document.baseURI).pathname;
        void this.router.navigateByUrl('/' + url.pathname.slice(base.length) + url.hash);
      };
      document.addEventListener('pointerdown', onLinkDown, true);
      document.addEventListener('click', onLinkClick, true);
      // Every navigation (link, Back, Forward): #card-id glides to the card;
      // no fragment returns to the canvas's opening view.
      const navigations = this.router.events.subscribe((event) => {
        if (event instanceof NavigationEnd) {
          const id = this.router.parseUrl(event.urlAfterRedirects).fragment;
          if (!id || !this.focusCard(id, true)) {
            this.fit();
          }
        }
      });
      inject(DestroyRef).onDestroy(() => {
        navigations.unsubscribe();
        clearTimeout(this.panTimer);
        document.removeEventListener('pointerdown', onLinkDown, true);
        document.removeEventListener('click', onLinkClick, true);
      });
      document.addEventListener('mp-resize-start', onResizeStart);`,
  'card links: click + navigation handling',
);
patch(
  'src/app/views/canvas-view.ts',
  '    const bounds = this.canvas.value()?.bounds;',
  `    const bounds = this.canvas.value()?.bounds;
    // Opened at #card-id: start on that card instead of the usual view.
    if (location.hash.length > 1 && this.focusCard(decodeURIComponent(location.hash.slice(1)), false)) {
      return;
    }`,
  'card links: open on #card-id',
);
patch(
  'src/app/views/canvas-view.ts',
  '  private fit(): void {',
  `  /** Centres card \`id\` at the readable zoom (smaller if the card would not
   *  fit) and flashes it. False when this canvas has no such card yet. */
  private focusCard(id: string, animate: boolean): boolean {
    const flow = this.flow();
    const el = this.flowEl()?.nativeElement as HTMLElement | undefined;
    const node = this.ctrl.value.nodes.find((n) => n.id === id);
    if (!flow || !el || !node || !('position' in node) || el.clientWidth <= 0 || el.clientHeight <= 0) {
      return false;
    }
    const w = node.data['width'] as number;
    const h = node.data['height'] as number;
    const zoom = Math.min(${READABLE_ZOOM}, (el.clientWidth / w) * FIT_PADDING, (el.clientHeight / h) * FIT_PADDING);
    // ng-draw-flow moves the camera instantly; a short CSS transition on the
    // pan layer makes it a glide (skipped for reduced-motion users).
    const pan = el.querySelector<HTMLElement>('.pan-zoom');
    if (animate && pan && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pan.style.transition = 'transform 450ms ease-in-out';
      clearTimeout(this.panTimer);
      this.panTimer = setTimeout(() => (pan.style.transition = ''), 500);
    }
    flow.setPosition({ x: -node.position.x * zoom, y: -node.position.y * zoom, zoom });
    const card = el.querySelector<HTMLElement>(\`[data-draw-flow-node][data-node-id="\${CSS.escape(id)}"]\`);
    if (card) {
      card.classList.remove('mp-card-flash');
      void card.offsetWidth; // restart the animation when the same card is linked again
      card.classList.add('mp-card-flash');
    }
    return true;
  }

  private fit(): void {`,
  'card links: focus card',
);

// 7. Read-only canvas: cards can't be dragged, so a drag anywhere (on a card
//    too) pans the board. Keyboard: arrows pan (Shift = further), + / - zoom
//    about the centre, 0 returns to the opening view. Ignored while typing.
patch(
  'src/app/app.config.ts',
  'nodesDraggable: true,',
  'nodesDraggable: false,',
  'cards not draggable',
);
patch(
  'src/app/views/canvas-view.ts',
  "      document.addEventListener('mp-resize-start', onResizeStart);",
  `      const onKey = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (
          event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented ||
          (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
        ) {
          return;
        }
        const step = event.shiftKey ? 400 : 100;
        const pans: Record<string, [number, number]> = {
          ArrowLeft: [step, 0],
          ArrowRight: [-step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        };
        if (event.key in pans) {
          this.nudge(pans[event.key][0], pans[event.key][1], 1);
        } else if (event.key === '+' || event.key === '=') {
          this.nudge(0, 0, 1.25);
        } else if (event.key === '-' || event.key === '_') {
          this.nudge(0, 0, 0.8);
        } else if (event.key === '0') {
          this.fit();
        } else {
          return;
        }
        event.preventDefault();
      };
      document.addEventListener('keydown', onKey);
      inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', onKey));
      document.addEventListener('mp-resize-start', onResizeStart);`,
  'keyboard pan and zoom',
);
patch(
  'src/app/views/canvas-view.ts',
  '  private fit(): void {',
  `  /** Pans by (dx, dy) screen px and zooms by \`factor\` about the view centre. */
  private nudge(dx: number, dy: number, factor: number): void {
    const flow = this.flow();
    const el = this.flowEl()?.nativeElement as HTMLElement | undefined;
    const pan = el?.querySelector<HTMLElement>('.pan-zoom');
    const m = pan?.style.transform.match(/translate3d\\((-?[\\d.]+)px, (-?[\\d.]+)px.*scale\\(([\\d.]+)\\)/);
    if (!flow || !el || !pan || !m) {
      return;
    }
    // ng-draw-flow draws its camera at translate = camera + view centre.
    const current = Number(m[3]);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor));
    const x = (Number(m[1]) - el.clientWidth / 2) * (zoom / current) + dx;
    const y = (Number(m[2]) - el.clientHeight / 2) * (zoom / current) + dy;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pan.style.transition = 'transform 150ms ease-out';
      clearTimeout(this.panTimer);
      this.panTimer = setTimeout(() => (pan.style.transition = ''), 200);
    }
    flow.setPosition({ x, y, zoom });
  }

  private fit(): void {`,
  'keyboard nudge',
);

// The flash itself (an accent ring that fades out).
const FLASH_CSS = `
/* ---- card link flash (patch.mjs) ---- */
@keyframes mp-card-flash {
  0%, 55% { box-shadow: 0 0 0 4px var(--interactive-accent); }
  100% { box-shadow: 0 0 0 4px transparent; }
}
ng-draw-flow.canvas [data-draw-flow-node].mp-card-flash {
  border-radius: 0.5rem;
  animation: mp-card-flash 1.8s ease-out;
}
`;
{
  const styles = join(pkgDir, 'src/styles.scss');
  writeFileSync(styles, readFileSync(styles, 'utf8') + FLASH_CSS);
  console.log('patched: card link flash css');
}

// 7. Append the repo's custom CSS to the global stylesheet.
if (customCss) {
  const css = readFileSync(customCss, 'utf8');
  const styles = join(pkgDir, 'src/styles.scss');
  writeFileSync(styles, `${readFileSync(styles, 'utf8')}\n\n/* ---- ${customCss} ---- */\n${css}\n`);
  console.log(`appended: ${customCss}`);
}
