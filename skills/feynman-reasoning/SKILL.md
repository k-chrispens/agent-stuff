---
name: feynman-reasoning
description: "Reason and explain the way the Feynman Lectures and 'Cargo Cult Science' do: start from a question or an anomaly, check what was actually measured, test the simplest suspicion first, find a picture that predicts the numbers, fix success criteria before looking, and keep measured apart from guessed. Use for write-ups of investigations, debugging, experiments, design decisions, postmortems and teaching explanations; when asked for 'first principles' or 'like Feynman'; and as a working discipline while investigating a surprising result. Not for status updates, commit messages, quick answers or pure code changes."
---

# Feynman Reasoning

An explanation is an investigation the reader can rerun in their head. Show what was seen, what it really measured, the simplest picture that predicts it, and how each result chose the next step. Keep the reader able to tell, at every sentence, whether it was measured or guessed.

Borrow the method, not the persona. Don't imitate Feynman's voice, jokes or anecdotes, and don't name him in the output unless asked.

## What the method rests on

Quoted only from sources checked; keep it that way if you extend this list.

- **Don't fool yourself.** "The first principle is that you must not fool yourself—and you are the easiest person to fool." You should "report everything that you think might make it invalid—not only what you think is right about it." ([Cargo Cult Science, Caltech 1974](https://calteches.library.caltech.edu/51/2/CargoCult.htm))
- **Find what is really being measured.** In the same address he praises a rat-maze experiment because "it uncovers the clues that the rat is really using—not what you think it's using." (same source)
- **Lead with the picture that does the most work.** Lecture 1 of the Lectures opens by asking which one sentence "would contain the most information in the fewest words", and answers with the atomic hypothesis. From it follows "an enormous amount of information about the world, if just a little imagination and thinking are applied." He also says "the test of all knowledge is experiment." ([FLP Vol. I ch. 1](https://www.feynmanlectures.caltech.edu/I_01.html))
- **Make the guess sharp enough to fail.** "You cannot prove a vague theory wrong." And "if it disagrees with experiment, it's wrong," but only after the experiment and the calculation have both been checked. ([Seeking New Laws, Cornell 1964, transcript](https://jamesclear.com/great-speeches/seeking-new-laws-by-richard-feynman))

## Workflow

Use these steps both while investigating and as the outline of the write-up. The starting point is always a question. An anomaly is a question in disguise: "how did this number come about?" In a short reply, keep steps 2, 3 and 8 and the claim-status markers; drop the narrative, the appendix and the self-review.

0. **What is the question, and why does it matter?** State it in a paragraph a newcomer can follow: what we want to know or decide, and what hangs on the answer. Readers can't judge a result if they don't know what it was supposed to show.
1. **The starting point.** If an anomaly started this, state it with a scale that makes it surprising: a job that took 45 minutes when it has taken 5 every night for a year. If a question started it, state what is currently believed or done, and what observation would settle it.
2. **What is it actually measuring?** Before you explain a result, check that the measurement means what you think. Do the inputs match? Are the labels, units and frames the same on both sides? Does the timer start where you assume?
3. **Test the simplest suspicion first.** Start with the boring causes: bookkeeping, naming, units, mismatched inputs. Report how much each fix explained, not just that it helped ("about an order of magnitude of it; the rest was something else").
4. **Find a picture that predicts a number.** Use a toy model, a formula or a back-of-envelope estimate, and put its predictions next to the measured values in a table. An idea that predicts no number isn't an explanation yet.
5. **Let each result choose the next step.** When something surprises you, say what you expected and what happened, then ask the question the surprise raises. A fix that made things worse is the most informative result you have.
6. **At a fork, weigh the options.** List the sensible options with one line each. Name the one you chose and the hypothesis it tests, phrased so that the next result can refute it.
7. **Decide what counts as success before looking.** Write the criteria down, then report the result against each one, including a plain "it failed".
8. **Close with known vs guessed.** Separate what was measured, what was inferred, what was guessed or not investigated, and the next step. Say which result would change that next step.

## Writing rules

- **Define before use.** Explain every term, acronym and label in plain words at its first appearance. Once a thing has a name, keep that name. If an outside source uses another name, give both once.
- **Give numbers with units and scale.** Compare each one to something the reader knows: a baseline, the previous run, a familiar size.
- **One idea per paragraph.** Make headings carry the story as claims or questions ("The surprise: the path got worse"), not as topics ("Results").
- **Use pictures over jargon.** Describe a stick rotated by θ, beads on a string, a rope held at one end. Give the technical name after the picture, with a citation.
- **Mark the status of claims.** Use *measured*, *checked*, *inferred*, *guessed* and *did not investigate* as you mean them. When two explanations fit, say "We did not measure why. Two explanations fit:" rather than quietly picking one.
- **Claim no more than the evidence shows.** Words like "proves", "fixes", "causes" and "always" need evidence of that strength. One run supports a hypothesis; it doesn't settle a conclusion.
- **Cite prior observations in plain words.** Say what they saw ("saw the cache hit rate fall to 20% after the upgrade"), then give the link. Quote sparingly and never invent a quote.
- **Put logistics in an appendix.** Memory limits, batch sizes, retries and timings go in a step log (`# | what we ran | what we saw | what we changed`), with the commands to reproduce it. The main text keeps only what changes the argument.
- **Hide nothing that cuts against you.** Report failures, contradicting data, and what you ruled out and how.

## Example

**Before**

> The nightly export suddenly took about 45 minutes instead of 5. We found the queue was backed up and the database had failed over, which explained most of it. Bigger batches fixed the rest.

**After**

> The nightly export has taken about 5 minutes every night for a year. On Tuesday it took 45, with no change to the exporter. Before explaining a nine-fold slowdown, check what the 45 minutes measures. The job timer starts when the scheduler enqueues the job, not when it starts running, and on Tuesday the queue was backed up. Measured from first log line to last, the job itself took 18 minutes. So queueing was about two thirds of the extra time. The remaining 13 minutes are inside the job. The export writes 2 million rows in batches of 100, so 20,000 round trips to the database. Tuesday night the database failed over to a replica in another region, and a round trip rose from 3 ms to 40 ms. That predicts 20,000 × 37 ms ≈ 12 minutes of extra time; we measured 13.
>
> …We tried larger batches first, *on the hypothesis* that the number of round trips, not the replica, was the part we could control. We would call it a success if the job ran under 8 minutes against the replica, the row count matched the previous export, and memory stayed under the pod limit. The first two held. Memory did not, at batches of 10,000. So batching is most of the answer, and the batch size is bounded by memory.

The after version gives the number a scale and checks the measurement before explaining it. It says how much the first finding explained. Its picture predicts the measured 13 minutes. And its claim is a hypothesis with criteria fixed in advance, then reported against each one, including the one that failed.

## Self-review before handing over

These are the points independent reviewers raised on the exemplar write-up. Check each one. If subagents are available, give two or three fresh reviewers this list and the draft, and ask them to find violations, not to praise.

- [ ] **Terms.** Is every term, acronym, label and figure ID defined at or before its first use? Search for each one.
- [ ] **Motivation.** Does the opening state the question and why it matters, before any method?
- [ ] **Consistency.** Does every number in the text match the tables, the appendix and the source logs (same run, same iteration, same units)? Recompute every derived claim ("40,000 times lower", "fewer than half") from the table.
- [ ] **No overclaiming.** Is each claim at the strength of its evidence, with untested explanations labelled as guesses?
- [ ] **Prediction.** Does the picture or formula actually reproduce the numbers shown, not merely gesture at them?
- [ ] **Criteria first.** Were the success criteria stated before the result, and is the result reported against each one?
- [ ] **Leaning over backwards.** Are the contradicting results, the alternatives considered, and how each was ruled out all on the page?
- [ ] **Appendix.** Is the main text readable without the engineering details, and is every engineering detail in the step log?
- [ ] **Newcomer test.** Could someone new to the project follow the argument and re-derive the key number?
