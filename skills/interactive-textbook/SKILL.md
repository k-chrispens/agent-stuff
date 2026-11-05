---
name: interactive-textbook
description: "Use when building an interactive textbook from a source document as a MyST / Jupyter Book 2 site with nested glossary tooltips, anywidget interactive widgets, optional live Python (JupyterLite), and one Thinking-Physics-style exercise per chapter. Covers faithful verbatim text reproduction, explanation in the spirit of the Feynman Lectures, 3Blue1Brown and Nielsen's discovery fiction, gears-level widgets, nested hover-card tooltips, and a multi-agent fan-out workflow."
---

# Interactive Textbook: Specs

Before scaffolding, read `gotchas.md` in this skill's folder. It lists the pitfalls of MyST, the theme and parallel agents that a real build hit, with fixes. Put its relevant sections into every subagent brief. Helper tools are in `tools/`.

## General, high-level requirements

- **Faithfulness, and same level-of-detail:** The interactive textbook should be entirely faithful to the original document (mostly verbatim), including same footnotes/reference, and the exact provided graphics (see also the "interactive widgets" section below).
- **Errors in the source:** when the source has an error or typo, keep the text as printed. Explain the problem in a labelled `Note:` dropdown (`:label: note-<slug>`); never fix it silently.
- **Target audience:** Assume the target audience of this textbook to be an extremely curious first-year university student of the corresponding major. (For example, if the original text is about neuroscience, assume that the audience is a neuroscience major but only taken non-AP high-school biology.) For concepts too advanced for the student that are also not in the "exclusion list" (additional concepts that the student already understands), use "nested tooltips" (see below).
- **Several sources and original chapters:** a book may combine sources, for example a paper read through a short framing text. It may also add original chapters (a refresher, a "lens", takeaways) when the triage calls for them. Tag every claim the book makes as the source's or *(book)*. Original chapters must agree with the verbatim chapters' Notes.

## Pedagogy and voice

The verbatim text is the spine. Everything the book *adds* has one job: helping the reader understand it. That covers dropdowns, glossary cards, original chapters, widget captions and the exercise. Load the `feynman-reasoning` and `learning-mode` skills before writing additions, and name both in every chapter and glossary brief.

Write additions with the perspective of three models:

- **The Feynman Lectures on Physics** (via `feynman-reasoning`):
  - Start from a question or an anomaly.
  - Find the simplest picture that predicts the numbers.
  - Keep what was measured or derived apart from what is guessed.
- **3Blue1Brown:**
  - Visual and concrete before formal. The widget *is* the picture.
  - Build up so the reader feels they could have invented the idea.
- **Michael Nielsen's discovery fiction:** tell how you would have discovered the result. Give the natural next question, the obvious idea and why it fails, then what fixes it.

Their personas may come through: they are great educators, so warmth, playfulness and the occasional aside in their spirit are welcome. Keep the method first: a voice without the question-first, picture-first reasoning is just decoration. Concretely:

- **Every addition opens with the question it answers.** "Why does a random walk put 61% of its variance in one direction?", not "PCA of random walks".
- **Protect the reader's effort** (`learning-mode`). Before a widget or derivation, add a one-line **Predict first** prompt, and put the answer in a nested collapsed dropdown. The answer never comes before the question.
- **Connect to the reader's goal.** The triage's self-explanation target (Workflow step 0) is the spine every addition ties back to.

## Stylistic

- The book is a MyST project built with Jupyter Book 2. Each top-level heading of the source becomes one chapter file, `chapters/NN-slug.md`.
- Map the source onto MyST's own features. Don't hand-roll any of these:
    - Math: `$...$` inline. Source equations go in `{math}` blocks with `:label: eqN` and `:enumerator: N` so they keep the source's numbers (see "Numbering" in `gotchas.md`). Rendering is KaTeX, so stick to KaTeX-supported LaTeX. Shared macros go under `math:` in the page or project frontmatter.
    - Footnotes: `[^n]` with the footnote text at the bottom of the chapter.
    - Figures: `:::{figure} path` with `:label: figN`, `:enumerator: N`, `:alt:`, and the original caption as the body.
    - Citations: `@key` or `[@a; @b]`, with the entries in `references.bib`.
- The main text's body should be mostly verbatim to the original text. 2 exceptions: nested tooltips and expanded readings.
    - **Nested tooltips:** inline `{term}` links for any concepts in the knowledge graph unknown to the student (see below).
    - **Expanded readings:** right after key paragraphs, as a collapsed `:::{dropdown} Title` block. Title them by the question they answer.

## Interactive widgets

Use interactive widgets for "gears-level models" that would be beneficial for the students to understand.

Use interactive widgets when:
- There's already a graphics in the provided text, and it might be helpful to reinforce understanding/expand upon: create an interactive widget in an expanded reading block after the original graphics.
- A "gears-level model" is introduced and it might be helpful to the student's understanding: create an interactive widget in an expanded reading block after the paragraph needed.
- Inside a (nested) tooltip: Use widgets more often (interactive or not), positioned after the explanation paragraph.

Since interactive widgets are displayed in (nested) tooltips/expanded readings and will generally not break the "happy path" flow, it is almost always better to create more of them if they help with understanding at all.

See also: https://www.lesswrong.com/posts/B7P97C27rvHPz3s9B/gears-in-understanding

To design each widget, apply the `interactive-figures` skill's interaction rules (SKILL.md, "Interaction rules"), with the evidence in its `references/design.md` and patterns in `references/idioms.md`:

- the default state shows the point, using the source's actual setup;
- each control answers a question;
- at most three controls;
- keyboard access and no hover-only content.

Its gate ("should this be interactive at all?") is written for figures in the main reading flow. Widgets here sit in opt-in expanded readings and tooltips, so the "more is better" guidance above still holds. Take its design rules, not its templates or tools: those target standalone HTML files, not anywidget modules. For molecules or density maps inside a widget, its `references/molstar.md` covers Mol\* and MolViewSpec.

### Widget mechanics (anywidget)

Each widget is a single ES module, `widgets/<name>.mjs`, embedded with the `anywidget` directive. The fence body is JSON5 and gives the initial model state:

````markdown
```{anywidget} ../widgets/noise-schedule.mjs
:css: ../widgets/noise-schedule.css
{ "steps": 50, "beta": 0.02 }
```
````

```js
import * as d3 from "https://esm.sh/d3@7.9.0";

export default {
  render({ model, el }) {
    const draw = () => { el.replaceChildren(); /* ...build the figure from model.get("steps") ... */ };
    model.on("change:steps", draw);
    draw();
  },
};
```

The build and the theme impose these rules:

- **One file per widget.** The build copies only the `.mjs` file (and the `:css:` file). Relative imports between local files break.
- **Libraries come from absolute CDN imports** inside the module, with the version pinned, for example `https://esm.sh/d3@7.9.0`. Never give a CDN URL as the directive argument, because the build re-hosts it and its internal imports then break.
- **Styles go inline or through `:css:`.** `el` lives in a Shadow DOM, so the book's page CSS doesn't reach it. Inherited `color` does, so draw with `currentColor` to follow light and dark mode.
- **The model is a small JS-only shim.** Use only `model.get`, `model.set` and `model.on("change:x", ...)`. `save_changes`, `send` and `off` throw. State isn't shared between widgets and isn't saved.
- Widgets work inside `:::{dropdown}` blocks and inside glossary definitions, so they show up in hover cards. Widgets in closed dropdowns mount immediately, so keep the initial render cheap.
- **Return a cleanup function from `render`** when the widget holds resources such as WebGL contexts or timers. Each time a hover card opens, it mounts a new copy of the widget.
- **Check every widget** with `uv run tools/check.py widget widgets/<name>.mjs '<json state>'`. It mounts the widget in a real browser DOM, drives every control, and fails on exceptions or NaN output. It also saves light and dark screenshots.

### Mol\* widgets

Start from `templates/molstar.mjs`, a working anywidget that shows a structure with a cartoon/surface toggle. It uses the same Mol\* 5.13.0 viewer build and MolViewSpec scene tree as the `interactive-figures` template, so that skill's `references/molstar.md` tree recipes apply unchanged. Keep the template's glue:

- **Loading:** the viewer build is UMD, so it loads once through an injected `<script>` tag, not `import`.
- **Styles:** `molstar.css` is linked inside `el` because of the Shadow DOM.
- **Container:** the viewer goes into a child `div` that has an explicit height.
- **Cleanup:** `render` returns `() => viewer.dispose()`. Without it, every hover card leaks a WebGL context.
- **Data:** load structures from a URL (wwPDB, RCSB, or your own host). The build copies only the `.mjs` file, so local data files have to be hosted somewhere or embedded in the module.

### Live Python (opt-in)

Where changing the code itself is the lesson, for example editing an update rule and rerunning it, use an executable `{code-cell} python` block. Readers run it in the browser with JupyterLite (Pyodide), so no server is needed. Rules:

- Enable it with `project.jupyter.lite: true` in `myst.yml`. A chapter with code cells needs a `kernelspec` in its frontmatter (`name: python3`, `display_name: Python 3`).
- **Code cells must be top-level.** A cell inside a dropdown builds but never runs. Put its explanation in a dropdown just above it.
- Use only Pyodide-compatible code: pure Python, numpy, scipy, matplotlib, pandas. Keep a cell under about 10 s in the browser.
- anywidget stays the default. A widget beats a code cell whenever the reader only needs to change parameters.

## Exercise

Each chapter ends with **one** exercise in the style of Lewis Carroll Epstein's *Thinking Physics*. It's a single well-aimed question, learning-mode's Test phase cut down to one item:

- **The question:** a short, concrete puzzle with three or four plausible answers, (a)–(d). The tempting intuition is wrong.
- **What it needs:** the chapter's key idea. It can't be answered without it, and it calls for reasoning, not calculation.
- **The answer:** in a collapsed dropdown, explained through the chapter's picture. It says why the tempting option fails. Check any number in it numerically.

````markdown
## Exercise

You run PCA on a random walk in $10^6$ dimensions and on one in $10$ dimensions, both for 1000 steps. Which puts more of its variance in the first principal component?
(a) the $10^6$-dimensional walk, (b) the $10$-dimensional walk, (c) about the same, (d) it depends on the noise distribution.

:::{dropdown} Answer
(c). It is tempting to think more dimensions spread the variance thinner. But the PCA spectrum is the eigensystem of an operator on *time* (n × n), and d never enters it. Both walks put about 61% in PC1 on average. Dimension only sets how much one run fluctuates around that: about ±9% at d = 10 and ±0.2% at d = 20,000 (checked by simulation).
:::
````

## Nested tooltips

Nested tooltips explain concepts with long dependency chains, in the spirit of the tooltips in Paradox Interactive's grand strategy games. They use MyST's native glossary hover cards:

- Every concept is one entry in the `{glossary}` directive in `glossary.md`. The chapters link to it inline with ``{term}`surface text <Concept Name>` ``.
- A definition is written for the target audience, with the same pedagogy as other additions. It is a short explanation that opens with the question the concept answers, then optionally a small widget (indented under the definition), then `{term}` links to its own prerequisites.
- Hovering a term inside a hover card opens a child card next to it. This nests at least 4 levels deep. The 400 ms delay, the open and close behaviour, and the positioning come from the theme and can't be configured. Don't try to add locking, progress bars, safe corridors or Esc handling.
- **Circular references are disallowed, and chains stop at about 5 levels.** Definitions may link any other entry. `tools/merge_glossary.py` rejects cycles and chains deeper than 5. To fix a violation, explain the concept inline in a clause instead of linking it.

````markdown
:::{glossary}
Diffusion model
: A generative model that learns to reverse a {term}`noising process <Noising process>`.

  ```{anywidget} ./widgets/denoise-steps.mjs
  { "t": 0.5 }
  ```

Noising process
: Adds a little Gaussian noise at every step until only noise is left.
:::
````

## Concepts exclusion list

*(note that this list might include concepts not related to the textbook subject in mind - ignore those in your subagent instructions)*

Concepts that the student already understands (defaults; adjust if the textbook's subject clearly warrants):
- Math: college linear algebra (1 course), multivariable calculus and numerical analysis (standard college level), some stochastic calculus from self-teaching diffusion models.
- Biology: bioengineering major background, including biochemistry, protein design, and some tissue engineering. Currently in a Biophysics PhD at UCSF, mostly computational structural biology research — so assume slightly less on the strict biology and chemistry front.
- Computer Science: CS minor, programming since age 10 (mostly Python and C++), familiar with machine learning and deep learning from coursework, self-teaching, and AI-for-biology PhD research.

Note: the target subject may be any textbook — the skill is subject-agnostic. The above are defaults for the knowledge baseline; if the textbook's subject is unrelated to one of these domains, ignore that domain in the subagent instructions (per the note at the top of this section).

## Implementation notes

- **Subagent orchestration:** Use subagents (or the harness's equivalent delegation mechanism) for both the top-level heading fan-out and the nested-tooltips worker pool. The adversarial review queued after each top-level heading should check for:
  - faithfulness to the source text;
  - correctness of concept definitions and additions, at the strength of their evidence;
  - quality of interactive widgets;
  - pedagogy: additions open with a question, predict-first prompts, method before voice;
  - the exercise: needs the chapter's idea, the answer is right.
- **Source format:** The original textbook/document will likely arrive as PDF or HTML. Adjust the verbatim extraction approach accordingly (`gotchas.md`, "Sources").
- **Tooling:** run Jupyter Book with `uv tool run --from "jupyter-book>=2" jupyter-book <cmd>` (or `pixi exec`), not pip. It needs Node, and the first build downloads the book theme.

## Workflow setup

0. **Triage.** Run `learning-mode`'s triage with the user as a short conversation, one question at a time:
   - why they're reading this source;
   - what they want to be able to explain afterwards (the self-explanation target);
   - how much effort they want to spend.

   Write the answers into the book brief. They decide:
   - the spine the additions tie back to;
   - which original chapters to add;
   - how hard the exercises are.
1. **Scaffold** before launching any agents.
   - Create `myst.yml`, an `intro.md`, `glossary.md` (just `# Glossary`, because an empty `{glossary}` is an error), `references.bib`, and empty `chapters/`, `widgets/` and `glossary-parts/` folders.
   - Write the book brief: the triage answers, the exclusion list, and the conventions in `gotchas.md` ("Conventions to fix in the brief"): labels, math conventions, canonical term names, dark-mode colours.

   ```yaml
   version: 1
   project:
     title: <Book title>
     bibliography: [references.bib]
     jupyter:
       lite: true          # only if any chapter uses live Python
     toc:
       - file: intro.md
       - file: chapters/01-slug.md
       - file: glossary.md
   site:
     template: book-theme
     options:
       logo_text: <Short title>
   ```

2. **Fan-out:** start one agent per top-level heading.
   - Each agent writes its `chapters/NN-slug.md` (ending with its exercise) and its `widgets/*.mjs`.
   - It reports the prerequisite concepts it linked with `{term}` (name plus a one-line gloss).
   - Queue an adversarial review after each chapter, and send its fixes back to the author.
   - Original chapters (a refresher, takeaways) go after the verbatim ones they summarize.
3. **Tooltip loop:**
   - Take the union of all prerequisite concepts that don't have a glossary entry yet.
   - Run a worker pool of 4, with each worker handling at most 8 concepts.
   - Each worker writes its entries to `glossary-parts/<worker>.md` (definition-list items only) and any widgets to `widgets/`.
   - Run `python3 tools/merge_glossary.py <book>`. It merges the parts into `glossary.md`, lists entries that are missing, and rejects cycles and over-deep chains. Send the violations back.
   - Repeat until it exits cleanly.
4. **Build and check:**
   - `jupyter-book build --html` must finish with no warnings.
   - Then run `uv run tools/check.py book <book>/_build/html`. In a real browser it checks that every widget renders, that there are no console errors, that every `{term}` opens a card, that cards nest, and that live cells run. It also saves dark-mode screenshots of every widget, so look at a few.
   - For live editing, use `jupyter-book start`, which runs a dev server on :3000.

## Future

- analytics
