---
name: interactive-textbook
description: "Use when building an interactive textbook from a source document with React components, nested tooltips, and interactive widgets. Covers faithful verbatim text reproduction, gears-level interactive widgets, Paradox-Interactive-style nested tooltip UX, and a multi-agent fan-out workflow."
---

# Interactive Textbook: Specs

## General, high-level requirements

- **Faithfulness, and same level-of-detail:** The interactive textbook should be entirely faithful to the original document (mostly verbatim), including same footnotes/reference, and the exact provided graphics (see also the "interactive widgets" section below).
- **Target audience:** Assume the target audience of this textbook to be an extremely curious first-year university student of the corresponding major. (For example, if the original text is about neuroscience, assume that the audience is a neuroscience major but only taken non-AP high-school biology.) For concepts too advanced for the student that are also not in the "exclusion list" (additional concepts that the student already understands), use "nested tooltips" (see below).

## Stylistic

- Emit React components for individual sections; use MathJax + Latex for equations if any.
- The main text's body should be mostly verbatim to the original text. 2 exceptions: nested tooltips and expanded readings.
    - **Nested tooltips:** render in-line for any concepts in the knowledge graph unknown to the student (see below).
    - **Expanded readings:** render right after key paragraphs, displayed as expandable accordion.

## Interactive widgets

Use interactive widgets for "gears-level models" that would be beneficial for the students to understand.

Use interactive widgets when:
- There's already a graphics in the provided text, and it might be helpful to reinforce understanding/expand upon: create an interactive widget in an expanded reading block after the original graphics.
- A "gears-level model" is introduced and it might be helpful to the student's understanding: create an interactive widget in an expanded reading block after the paragraph needed.
- Inside a (nested) tooltip: Use widgets more often (interactive or not), positioned after the explanation paragraph.

Since interactive widgets are displayed in (nested) tooltips/expanded readings and will generally not break the "happy path" flow, it is almost always better to create more of them if they help with understanding at all.

See also: https://www.lesswrong.com/posts/B7P97C27rvHPz3s9B/gears-in-understanding

## Nested tooltips

Nested tooltips are a great way to explain concepts with long dependency chains, with a similar UX to Paradox Interactive's grand strategy games.

### General UX

1.1. Cursor enters a tooltip-enabled element (UI widget, map object, or inline concept link in text).
    - 1.1.1. Start hover timer (300ms).
1.2. Timer fires → render tooltip.
    - 1.2.1. Position: default anchor offset from cursor, biased away from the element it describes so it never occludes it.

2.1. First-level tooltip is initially non-interactive (mouse passes through it).
2.2. Lock conditions:
    - 2.2.2. Hover-delay mode: player keeps cursor still over the source for N ms → tooltip becomes interactive automatically; show a subtle progress affordance (fill bar on tooltip edge) so the state change is predictable, not surprising.
    - 2.2.3. Edge: player moves cursor toward the tooltip during the transition → provide a "safe corridor" (triangle between cursor and tooltip bounds) so diagonal travel doesn't dismiss it en route. This is the single most common failure in naive implementations.
2.3. Locked visual state: border/pin icon change so the player knows clicks will now hit the tooltip, not the map behind it.

3.1. Inside a locked tooltip, concept links (highlighted terms) are hoverable.
    - 3.1.1. Hover link → same timer logic as 1.1 → spawn child tooltip.
    - 3.1.2. Child positions adjacent to parent, offset so parent's link text remains visible.
3.2. Depth management.
    - 3.2.1. Recommended soft cap on simultaneous open levels (e.g. 4–5); beyond that, spawning a new child collapses the oldest ancestor beyond the chain root.
    - 3.2.2. Edge: circular references → disallowed, and display them differently so that the player would know
3.3. Each child inherits the lock mechanism recursively (hover child → child locks → its links become hoverable).

4.1. Moving cursor off the entire chain (outside all tooltip bounds and safe corridors) → grace timer (~200–300ms), then dismiss the whole chain. Grace period prevents accidental teardown from a 2-pixel overshoot.
4.2. Moving cursor back to an ancestor tooltip → dismiss all descendants of that ancestor after the grace period (pruning, not full teardown).
4.3. Explicit dismissals:
    - 4.3.1. Esc → close entire chain (and only the chain; must not also close the underlying game window — input priority ordering matters here).

## Concepts exclusion list

*(note that this list might include concepts not related to the textbook subject in mind - ignore those in your subagent instructions)*

Concepts that the student already understands (defaults; adjust if the textbook's subject clearly warrants):
- Math: college linear algebra (1 course), multivariable calculus and numerical analysis (standard college level), some stochastic calculus from self-teaching diffusion models.
- Biology: bioengineering major background, including biochemistry, protein design, and some tissue engineering. Currently in a Biophysics PhD at UCSF, mostly computational structural biology research — so assume slightly less on the strict biology and chemistry front.
- Computer Science: CS minor, programming since age 10 (mostly Python and C++), familiar with machine learning and deep learning from coursework, self-teaching, and AI-for-biology PhD research.

Note: the target subject may be any textbook — the skill is subject-agnostic. The above are defaults for the knowledge baseline; if the textbook's subject is unrelated to one of these domains, ignore that domain in the subagent instructions (per the note at the top of this section).

## Implementation notes

- **Components library:** Use the simplest library that meets the need; defer the specific choice to the agent executing the skill.
- **Tooltip implementation:** Adapt an existing library (e.g. Floating UI, Radix Popover, Tippy.js) rather than building from scratch; patch in the Paradox-style behaviors described in the nested tooltips section. Defer the specific library choice to the agent.
- **Subagent orchestration:** Use subagents (or the harness's equivalent delegation mechanism) for both the top-level heading fan-out and the nested-tooltips worker pool. The adversarial review queued after each top-level heading should check for: faithfulness to the source text, correctness of concept definitions, and quality of interactive widgets.
- **Source format:** The original textbook/document will likely arrive as PDF or HTML. Adjust the verbatim extraction approach accordingly.

## Workflow setup

Lets first fan out with 1 agent for 1 top-level heading, with the agent generate the react components + provide report on prerequisite concepts, with adversarial review, queued after; then take the union of all prerequisite concepts, start the nested tooltips loop with a worker pool side of 4, each worker taking on at most 8 concepts, and iterate until there are no more unknown concepts. setup a repo with vite + react + ts + tailwind, plus a components library before you launch the workflow

## Future

- analytics, quizzes
