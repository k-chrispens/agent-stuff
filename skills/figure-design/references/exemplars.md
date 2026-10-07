# Exemplars

What to take from each source, phrased as moves an agent can make.

## Muir et al. 2025, Science, Fig. 1 and structured-abstract graphic

D. F. Muir et al., "Evolutionary-scale enzymology enables exploration of a rugged catalytic landscape," Science 388, eadu1058 (2025). doi:10.1126/science.adu1058

**Panel A, the fitness landscape.** A gray wireframe surface is the whole scaffold. The only hue is spent on the two mutational walks (blue, green) and their start dots, so the eye goes straight to the argument. A dashed circle lifted out of the surface, joined to its source patch by dotted leaders, holds radial arrows standing for local exploration (a deep mutational scan): a zoom lens that changes scale without a new panel.

**Panel C, three structures.** Identical viewpoint, scale and rendering; only the data differs (small multiples). Hue encodes category (Zn²⁺ lid blue, H-bond lid green, lidless purple), lightness within the hue encodes a continuous variable (sequence entropy). One shared grayscale bar explains all three.

**Abstract graphic.** A left-to-right pipeline of four steps. Zoom lenses chain scales twice (device → chamber array → single tethered molecule). The psychrophile-to-thermophile color scale on the tree tips reappears on the chamber dots and on the Michaelis–Menten curves, so color is a thread that lets the reader follow one ortholog through three representations. Dashed ellipses mark neighborhoods in the embedding without boxes or axes.

**Transcription of panel A** in the ASCII convention used for ideation:

```
                A*                                 .---.
               .A:.             B*               ( >+< )
             .:A:::.          .:B:.   . . . . . . '---'
           .::A:::::.       .::B::::.
     ...:::::A::::::::.....:::::B::::::...
    /     A A A         \  /          B B B o \
   /  o                  \/                    \
  /______________________________________________\
```

Key: `:` gray wireframe surface (two sequence axes, height = k_cat). `A` walk to the global maximum, good_darkblue. `B` walk to a local maximum, good_teal. `*` maxima. `o` walk origins. `( >+< )` zoom lens of radial mutation arrows (local exploration). `. . .` dotted leader to the lens's source patch. `\/` a pit.

## Edward Tufte

**Data-ink and erasing.** Every mark should carry information; remove frames, fills, gridlines and decoration that don't. During critique, try deleting each element and see whether anything is lost.

**Smallest effective difference.** Make visual distinctions as small as they can be while still being clearly seen. Hairline scaffold, light fills, one heavy stroke for the argument.

**Layering and separation.** Push the context back (gray, thin, light) so the subject comes forward. Watch for 1 + 1 = 3: two adjacent marks create an unintended third shape (the gap between two boxes reads as a channel). This is a common defect in agent-drawn schematics.

**Small multiples.** Repeat one frame and vary one thing. Comparison across the repeat does the explaining.

**Words and images together.** When labels are finally added, they go directly on or beside the thing, not in a legend. This belongs to the labeling pass, not to drafting.

## Bret Victor

**The ladder of abstraction.** Pair a concrete instance with its abstraction: one trajectory next to the ensemble, one molecule next to the population, one step next to the loop. A figure that shows only the abstraction asks the reader to build the concrete case in their head.

**Show the thing, not a description of it.** Prefer a picture of the mechanism (the lid opening, the chamber filling) to a box labeled with the mechanism's name. Boxes-and-arrows diagrams are the fallback, not the default.

**Multiple linked representations.** The same object shown in several encodings, visibly linked by color or alignment (see the abstract graphic's color thread).

## Distill.pub

**The figure is the explanation.** The figure carries the argument and the text annotates it. Design the figure first and the caption second.

**Color-matched prose.** Distill articles often color words in the text to match diagram elements. For static figures this solves the no-text tension: the caption carries the words, and color links them to unlabeled marks.

**Interactivity on demand.** A static figure shows the canonical state. Interaction reveals the space around it. If the idea needs that, ideate here and build with the interactive-figures skill.
