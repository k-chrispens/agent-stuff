# Interactive textbook: gotchas

These are pitfalls hit while building a real book with this skill. Read them before scaffolding, and paste the relevant sections into every subagent brief. Items marked **(verified)** were reproduced with mystmd 1.12 and Jupyter Book 2.1.7.

## Sources

- **The arXiv e-print can be unavailable,** for example when network tools are blocked. If so, work from the PDF:
  - Extract text with pymupdf (`uv run --with pymupdf`).
  - Render page images.
  - Crop the figures. Paper figures are usually vector drawings, not images, so take the union of `page.get_drawings()` rectangles above each "Figure N:" caption and render that clip at 200 dpi.
- **Extracted text garbles equations and drops symbols.** One case lost the "1/" in $r_c = 1/\sqrt{\alpha(2-\alpha)}$. Retype every equation from the page images, and have the reviewer check each one symbol by symbol.
- **Keep printed errors and typos as printed.** Explain each in a labelled `Note:` dropdown (see Conventions).

## Conventions to fix in the brief before the fan-out

Parallel agents invent incompatible conventions unless the brief fixes them:

- **Labels:** `eqN` and `figN` for source equations and figures; `note-<slug>` for Note dropdowns, so summary chapters can link a Note rather than a whole chapter.
- **Chapter references:** pick one style. File numbers and source section numbers differ (file `03` might be §2), and three styles appeared in one book.
- **Math conventions:**
  - Indexing, for example $t = 1..n$ versus $0..n-1$.
  - Sign conventions, for example circulant indexed by first row with $\sum_l c_l\omega^l$, versus first column with $\omega^{-l}$.
  - Notation clashes, for example $\Sigma$ used for singular values and for a noise covariance.
- **Canonical glossary names:** seed a shared list. Otherwise agents coin near-duplicates such as "Toeplitz Matrix" and "Banded Toeplitz Matrix", or "Karhunen-Loève" and "Karhunen-Loeve".
- **Dark mode:** use `currentColor` for text, axes and strokes; transparent backgrounds; mid-tone accents `#3b82f6` and `#ea580c`; `background:transparent; color:inherit` on inputs, selects and buttons. See Widgets for why.
- **Attribution:** allow one italic source-attribution line per chapter. Otherwise "additions only in dropdowns or terms" leaves it no home.

## Numbering (verified, major)

- **Equation and figure numbers restart at 1 on every page.** A source split across chapters renders its Eq. 26 as "(1)".
- **Recipe:**
  - Write every source equation as `{math}` with `:label: eqN` and `:enumerator: N`.
  - Give every source figure `:enumerator: N`.
  - Put `numbering: {equation: false}` in the chapter frontmatter. Explicit enumerators survive it; added, unlabelled math stays unnumbered.
- **Caveat:** a labelled `$$ … $$ (eqN)` without an explicit enumerator *loses* its number under `equation: false`. On such a page, keep auto-numbering and give every added equation `{math}` with `:enumerated: false`.
- **Unlabelled `$$ … $$` is numbered.** Two added equations in a dropdown shifted a paper's Eqs. 13–16 to 15–18.
- **Supplement figures shown out of order need explicit enumerators.** Without them, a Fig. 5 placed in a dropdown before Fig. 1 became "Figure 1" and pushed Fig. 1 to "Figure 2".

## MyST syntax

- **Nested directives:** the outer fence needs more colons than the inner one, as in `::::{dropdown}` around `:::{figure}`. A backtick `{anywidget}` fence inside a colon dropdown is fine.
- **No dropdowns inside list items.** A dropdown about one bullet goes after the whole list.
- **Empty glossary:** an empty `{glossary}` directive is a hard error (`required body not provided`). Scaffold `glossary.md` as `# Glossary` only; `tools/merge_glossary.py` adds the directive once entries exist.
- **KaTeX:** no `\bm`; use `\boldsymbol` or `\mathbf`. In table cells, write absolute values with `\lvert … \rvert` so `|` doesn't split the row.
- **Footnotes:** symbols (∗, †) are renumbered. A numeric `[^4]` keeps its number.
- **Unresolved terms:** `{term}` links warn until the tooltip loop merges their entries. That's expected mid-run.

## Widgets

- **Shadow DOM:**
  - Page CSS classes don't reach `el`, but inherited properties (`color`, `font`) do. So `currentColor` follows the theme's light and dark modes.
  - The theme's `html.dark` class and `prefers-color-scheme` don't. Hard-coded light cards glared in dark mode in three of five chapters.
  - Native `<option>` popups may need `option{background:Canvas;color:CanvasText}`.
  - Each widget gets its own shadow root, so SVG ids are scoped per widget.
- **Mount cost:** widgets in closed dropdowns mount on page load, and glossary widgets mount every time a card opens.
  - Keep first render under about 50 ms; `tools/check.py widget --max-ms 50` enforces it.
  - Precompute noise once per seed, rather than on every slider event.
  - Listen to `change` rather than `input` for expensive solves.
- **Tall hover cards open off-screen.** A card about 500 px tall, triggered mid-viewport, opened at y = −69 px, with its title and first links under the sticky nav.
  - Cap glossary widgets at about 180 px.
  - Keep card prose short.
- **Numerics:** use cancellation-free forms, such as $\sin^2$ instead of $1-\cos$. One printed formula lost all precision at large n and went negative at n = 10⁵.
- **Testing:**
  - `npm install` (jsdom and similar) is usually blocked, and hand-written DOM stubs miss real bugs. Use `tools/check.py widget`.
  - Export pure compute functions by name so `node` can check the math; anywidget uses only the default export.
- **Content:**
  - Default to the source's actual setup. One widget defaulted to a 1/t schedule the paper never used; the paper's was exponential.
  - Label any invented preset "Illustrative".
  - Put a widget's caption inside the widget or in the dropdown text.
  - A row of presets counts as one control.

## Glossary

- **Tiers block natural links.** Restricting links to strictly lower tiers prevents cycles, but blocks links such as Circulant → Fourier Mode. Allow any link and let `tools/merge_glossary.py` reject cycles and depth over 5.
- **Word budget:** about 120 words is tight for math-heavy entries. Count prose, not LaTeX tokens.

## Live code

- **A `{code-cell}` inside a dropdown never runs (verified).** It builds, but "Run cell" logs `no cell found on execute {cellId: undefined}`. Keep cells top-level, with their explanation in a dropdown just above.
- **Keep cells under about 10 s in Pyodide.** n = 300, d = 3000 ran in about 10 s, including the first matplotlib load. Code cells have no stored output in a static build.
- **Expected 404s:** `pypi/all.json` and `api/contents/all.json` return 404 when JupyterLite starts. They're harmless.

## Orchestration

- **No builds in the shared directory.** Parallel builds collide.
  - To validate, an agent can build a private copy in its own scratch directory.
  - `jupyter-book build --html` briefly binds port 3000, so stagger those builds.
- **Prefix scratch files** with the agent's chapter or worker id. Agents overwrote each other's `t.mjs`.
- **Briefs can be wrong.** An orchestrator brief claimed curvature steepens a spectrum; it flattens it. Verified chapter Notes win over brief wording, and agents should report the conflict instead of complying.
- **Original chapters inherit source errors.** A refresher repeated three claims the verbatim chapter's Notes refuted. Original-chapter agents read the verbatim chapters' Notes first and state facts independently.
- **Cross-chapter fixes:** a reviewer of one chapter often finds errors in another's span. Route them to that chapter's author.

## Verification

- **Use `tools/check.py book`.** It encodes these lessons:
  - Full-page screenshots fail on long pages ("Unable to capture screenshot"), so it takes viewport shots.
  - Hover tests must jump the pointer directly. Intermediate steps leave both trigger and card, which closes the card.
  - Child links in a tall card can sit under the sticky nav, so it places the nesting trigger near the top of the viewport.
