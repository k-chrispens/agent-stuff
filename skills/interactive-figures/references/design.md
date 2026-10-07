# Design evidence

This file explains why the rules in SKILL.md are what they are. Each claim has a source, and the sources often pull against each other.

## The central tension

On one side, interaction makes text "an environment to think in" (Victor, *Explorable Explanations*, https://worrydream.com/ExplorableExplanations/).

On the other side, there are three strong objections:

- **Victor himself:** "Unless it is enjoyable or educational in and of itself, interaction is an essentially *negative* aspect of information software" (*Magic Ink*, http://worrydream.com/MagicInk/).
- **The NYT:** Archie Tse said "readers just want to scroll", and "if you make a tooltip or rollover, assume no one will ever see it" (Malofiej 2016, reported at https://garciamedia.com/blog/interactive_graphics_less_is_best_at_ft/).
- **Lab studies:**
  - Adding interaction to a static Bayesian-reasoning visualization did not improve accuracy, and sometimes hurt it (Mosca et al., CHI 2021, https://arxiv.org/abs/2103.01701).
  - Static small multiples beat animation for accurate analysis (Robertson et al., TVCG 2008, https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tvcg2008-trendvis.pdf).

Real reading data resolves the tension. Across about 50,000 sessions, 85% of readers used an interaction that was central to the article, while the median reader used an optional slider or button zero times (Conlen et al., EuroVis 2019, https://idl.cs.washington.edu/files/2019-IdyllAnalytics-EuroVis.pdf). Readers interact with what the argument needs, and with nothing else. This gives:

- the gate
- rule 1: the default state carries the claim
- rule 2: every control answers a question

## Rules and their sources

- **The default state carries the claim.** Static first (Magic Ink). Readers aren't forced to interact (Victor). Never hide essential information behind interaction (Aisch, https://www.vis4.net/blog/in-defense-of-interactive-graphics/). This rule is also in moonshine: "figures show the concept on load before interaction".
- **Each control answers a question.** Start with a question (Case, https://blog.ncase.me/how-i-make-an-explorable-explanation/). Central interactions get used and peripheral ones don't (Conlen 2019). "Interaction is a cost center" (Matuschak, https://notes.andymatuschak.org/z179DabP631i5Mjf2DBMwoS).
- **Tell the reader what to try.** Ciechanowski introduces each demo with an instruction ("drag the slider to peek inside"). Without a story, readers don't know "where do you start?" (Grant Sanderson, Lex Fridman podcast #118).
- **Show inputs and internal state.** Bostock's "white box" exposes the algorithm's internal state (https://bost.ocks.org/mike/algorithms/). Patel: change the inputs, show the outputs (https://www.redblobgames.com/making-of/line-drawing/). Victor's Learnable Programming adds "show the data" and "eliminate hidden state".
- **Link the representations.** Show several representations at once and propagate changes between them (Victor, *Media for Thinking the Unthinkable*). Patel's hexagons page links hover across diagrams.
- **Concrete, then varying, then everything.** See Victor's *Up and Down the Ladder of Abstraction* (https://worrydream.com/LadderOfAbstraction/) and Case ("give the reader a concrete experience" first).
- **Predict before revealing.** Asking readers to predict improved recall and comprehension over a control group (Kim, Reinecke & Hullman, CHI 2017, https://mucollective.northwestern.edu/?p=213). Hohman et al. survey this and the other affordances of interactive articles (Distill 2020, https://distill.pub/2020/communicating-with-interactive-articles/).
- **The reader controls time.** "We must not be slaves to real time" (Victor). Animation running longer than 2 s needs a pause control (Chartability, https://chartability.github.io/POUR-CAF/). Reduced-motion preferences must be respected (WCAG 2.3.3).
- **Animate the model, not the pixels.** Animated transitions help when objects keep their identity across states (Heer & Robertson 2007, https://idl.uw.edu/papers/animated-transitions). Wittens: every frame should be "a continuous stream of valid examples" (https://acko.net/blog/mathbox2/).
- **Mobile.** Hover doesn't exist on mobile. Mobile readers spend 23–52% of the desktop reading time (Conlen 2019). Stack the content unless the transitions themselves carry meaning (Pudding, https://pudding.cool/process/responsive-scrollytelling/).
- **Accessibility.**
  - Keyboard access to every control.
  - A non-drag alternative for every drag (WCAG 2.5.7).
  - At least 3:1 contrast for marks and 4.5:1 for text.
  - Text alternatives: a short description plus a long one (W3C complex images).

## When not to make it interactive

- The claim is one takeaway that small multiples can show.
- The task is precise comparison: small multiples beat toggles and animation (Robertson 2008).
- There is no model or process to manipulate, so the only interaction would be filtering.
- The audience will skim: social media, a poster, a printed page.
- You can't give the figure keyboard access plus a static fallback.

In these cases build the interactive version for yourself, explore, and publish the best stills. Sanderson: a video, or a still, captures "most of the benefits of the interactive… as long as you make the interactive for yourself." `check.py --stills` is built for exactly this.

## Credits

This file adapts ideas, but no code, from moonshine by enjalot and syntagmatic (MIT License, https://github.com/syntagmatic/moonshine):

- show the concept on load
- idempotent steps
- the accessibility floor
- computed rather than hand-typed claims
