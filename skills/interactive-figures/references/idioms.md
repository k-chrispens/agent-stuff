# Interaction idioms

Each idiom is described the same way. **Use when** names the question it answers, and the figure's brief must contain that question. **Contract** explains how the idiom maps onto `STATES`, `render` and `set`. **Exemplar** points to a good real-world example.

## Parameter slider with linked views

- **Use when** the reader asks "what happens as X changes?"
- **Contract:** the state holds one number, `oninput` calls `set({x})`, and `render` redraws every view that depends on X. Named states hold 2–4 telling values, with the default being the most telling one.
- **Exemplar:** Goh, "Why Momentum Really Works", https://distill.pub/2017/momentum/

## Comparison toggle (A/B in place)

- **Use when** the reader asks "which model or method fits?"
- **Contract:** the state holds a string such as `model: 'single' | 'ensemble'`, and a `role="group"` of buttons sets `aria-pressed`. Only the thing being compared changes; everything else stays still, so the difference pops out. Both templates do this.
- **Exemplar:** the flat-topped vs pointy-topped hexagon toggle, https://www.redblobgames.com/grids/hexagons/

## Stepper

- **Use when** the reader asks "how does this unfold, step by step?" (an algorithm, a pathway, a refinement).
- **Contract:** the state holds `step: 0..n`, the named states are the steps that matter, and the arrow keys already step through them. Each step is drawn from scratch, never as a diff from the previous step.
- **Exemplar:** https://www.redblobgames.com/pathfinding/a-star/introduction.html

## Direct manipulation

- **Use when** the reader asks "what if I move this?" and the thing itself is the natural handle: an atom, a point on a curve, a domain.
- **Contract:** drag sets state through `set()`. You must also provide a non-drag route to the same state, such as a slider or arrow-key nudges, to meet WCAG 2.5.7.
- **Exemplar:** Ciechanowski, "Mechanical Watch", https://ciechanow.ski/mechanical-watch/

## Predict, then reveal

- **Use when** the result is surprising and you want the reader to commit to a guess first. This has the best evidence of any idiom for recall and understanding.
- **Contract:** the state holds a `guess` (a sentinel such as `-1` until made, since state values can't be `null`) and `revealed: false | true`. Use the sentinel in the named states; values a named state uses are always accepted from the URL hash, so `LIMITS = { guess: [0, 1] }` still allows `-1`. The default state is the question; a named state shows the reveal next to a sample guess.
- **Exemplar:** "You Draw It", https://observablehq.com/@d3/you-draw-it

## Small multiples, then one detail

- **Use when** the reader needs the whole parameter space and one case together (moving up and down Victor's ladder of abstraction).
- **Contract:** `render` draws every case small, and the state holds `selected`; clicking a case sets it and shows that case large. This idiom also makes the best static still for papers.
- **Exemplar:** https://worrydream.com/LadderOfAbstraction/

## Linked hover or brush

- **Use when** the reader asks "which point here is which point there?" across two representations (sequence ↔ structure, embedding ↔ profile).
- **Contract:** the state holds `focus` (an id, or `''` for none; strings that no named state uses need `LIMITS = { focus: [...all ids, ''] }` to survive the URL hash). Hover, focus and tap all set it, and `render` highlights it in every view. Hover only reveals detail, never the claim.
- **Exemplar:** https://observablehq.com/@d3/brushable-scatterplot-matrix

## Contour or threshold slider (density)

- **Use when** the reader asks "is that density real, or just noise at this level?"
- **Contract:** the state holds `sigma`; `render` sets `relative_isovalue` (or σ × level as `absolute_isovalue`, see molstar.md). The named states cover the range: a level where the feature appears, a level where it is clean, and a level where it disappears.
- **Exemplar:** the `templates/molstar.html` `high_contour` state.

## Scroll-driven state

- **Use when** the figure sits inside an article and each paragraph should drive a step.
- **Contract:** each step calls `set(STATES[name])` from an IntersectionObserver. Because `render` is idempotent, scrolling backwards works.
- Usually this is an article-level concern; a single figure should prefer a stepper.
- **Exemplar (process write-up):** https://pudding.cool/process/responsive-scrollytelling/

## Avoid

- **Free-play sandboxes with no question.** The median reader never touches them; Conlen et al. measured this. Offer one only as the last state, after the guided ones (the martini-glass structure).
- **Tooltips that carry the claim.** Assume nobody sees them.
- **Animation that plays on its own.** Give the reader control of time.
- **More than three controls.** Split the figure, or cut controls.
