---
name: adversarial-review
description: Run adversarial code review on a change using independent reviewer Claudes in fresh contexts whose only job is to find bugs, while a human stays the final judge of every finding. Use whenever the user asks for adversarial review, red-team review, independent review, "have another Claude check this", pre-merge review of a diff/branch/PR, or says things like "find bugs in this change", "poke holes in this", or "review this as if you didn't write it" — especially for AI-authored changes the user wants higher confidence in before merging.
---

# Adversarial Review

Author-review is biased review. The Claude that wrote a change wants the change to land, and that pull shows up as generous readings of its own code. This skill splits the roles: an implementer who never reviews its own work, and independent reviewers in fresh contexts whose only job is to find reasons the change is broken.

But automated review loops have their own failure mode. Left to run hands-off, they accrete defensive patches, blur the meaning of "done", and quietly remove the human's ability to explain the system they own. So this skill is deliberately bounded: reviewers surface problems, the implementer answers them, and a **human — never a model — decides which findings are valid and when the work is finished**. The output of this skill is a triage report for a person, not a merge.

## Roles — hard rules

- **Implementer** (usually the context that wrote the change): implements and fixes. Never reviews its own change. Never grades or filters the reviewers' findings beyond deduplication.
- **Reviewers** (2 or more, independent): only find problems. Never write patches. Never approve — nothing a reviewer writes should read as sign-off. They start from a clean context: no implementer reasoning, no sibling reviewer's findings.
- **Human**: the only party who accepts findings, rejects findings, or declares the change done. Never merge, land, push to main, or mark the task complete on the human's behalf.

If you (the current context) wrote or materially shaped the change under review, you are the implementer. Do not review it yourself. Your job is to package the change, dispatch reviewers, consolidate what comes back, and stop at the human gate.

## Workflow

### 1. Pin down the change and its intent

Identify exactly what is under review: staged changes, a branch diff against a base, a PR, or a named set of files. Then write a short **intent statement** (roughly 3–8 lines): what the change is supposed to do, and which existing invariants it must not break. If you cannot state the intent, ask the user before proceeding — a reviewer cannot judge "does not work" without knowing what "works" means, and a clean change that does the wrong thing is the worst kind of bug.

### 2. Build the review packet

The packet is everything a reviewer gets. Include:

- the intent statement
- the full diff
- the complete current contents of every changed file — a diff alone hides the context bugs live in
- closely coupled code: callers of changed functions, and any schema, persisted format, or protocol definition the change touches
- how to build and run the tests, when the reviewer's environment can execute code

Deliberately exclude:

- the implementer's reasoning, self-assessment, or claims like "tested, works" — these anchor reviewers toward approval, which defeats the point of splitting contexts
- findings from any previous round — each round's reviewers come in clean

### 3. Dispatch independent reviewers

Default to two reviewers, each in a fresh context, each given the packet plus the contents of `references/reviewer-prompt.md` with its lens section filled in:

- **Reviewer A — correctness & failure lens**: logic errors, edge cases, error paths, lifetimes, concurrency, caller mismatches, intent mismatches.
- **Reviewer B — invariants & integrity lens**: weakened invariants, newly representable bad states, fallbacks that mask corruption, duplication, dead defensive code, obscuring abstractions, compatibility breaks.

Add a third reviewer only when the change carries a specific domain risk (security-sensitive surface, persisted data formats, concurrency-heavy code), with that risk as its lens.

**With subagents** (Claude Code and similar): spawn each reviewer as its own subagent in parallel. Each subagent receives only the reviewer prompt and the packet — not the implementation conversation.

**Without subagents** (single-conversation environments like claude.ai): write each reviewer's complete prompt-plus-packet to a file and hand these to the user to run in fresh conversations, then consolidate the outputs they bring back. Do not play both implementer and reviewer inside one context and present the result as independent review — a self-review in costume is worse than an honest self-review, because it launders bias as independence. If the user explicitly accepts a same-context review anyway, do your best but label every output "same-context review — not independent".

### 4. Consolidate into a triage report for the human

Merge the reviewers' findings: deduplicate, keep the strongest evidence for each, and note where reviewers independently converged (agreement across clean contexts is the highest-signal indicator this skill produces). Use the template in "Report format" below. Order findings by severity, not by reviewer.

Keep the report legible to a person. Every finding must carry a falsifiable claim ("with input/state X, Y goes wrong because Z") and concrete evidence (file and line, a trace, or a failing reproduction). A report the human can't follow without asking a model to explain it has failed at its job.

### 5. Human gate — stop here

Present the report and stop. Do not start fixing. The human marks each finding **accept**, **reject**, or **defer**. Zero findings from all reviewers is a valid outcome and is reported as evidence, not as approval — "the reviewers found nothing" is information for the human's decision, not a verdict that replaces it.

### 6. Implementer response round

For accepted findings, the implementer fixes them — with a strong preference for **eliminating the bad state over handling it**. Reach for a tighter type, a stricter constructor, a validated boundary, a removed code path, before reaching for another branch, fallback, or try/except. Each fix's description should say which of the two it did.

The implementer may rebut a finding it believes is wrong, but only with evidence (a trace, a test, a pointer to the guarding invariant). Rebuttals go into the next report for the human to judge; the implementer never silently drops a finding.

### 7. Bounded re-review

If fixes were made, run at most one more review round (two rounds total by default; only exceed this if the human explicitly asks). Scope it to the delta since the last round, with fresh reviewer contexts. Then return to the human gate regardless of the outcome. The loop never decides it is finished — it runs out of budget and hands the state, clearly described, back to the person.

## Guardrails — read before every run

- **No approvals exist in this system.** Reviewers report findings or their absence. The implementer reports fixes and rebuttals. Only the human closes the loop.
- **Over-defensiveness is a bug class, not a virtue.** Reviewers flag it; fixes must not resolve findings by piling on handlers for states that should be impossible. If round two shows the change grew guard clauses instead of invariants, that is itself a finding.
- **Reachability or it doesn't count.** "This line could throw" is only a finding if a reachable state gets there. Speculation must be labeled as speculation.
- **An empty review is acceptable.** Reviewers who find nothing after genuine effort say so and describe what they probed. Manufacturing nitpicks to appear thorough destroys the signal the human depends on.
- **Respect the iteration cap.** More rounds feel productive while making the change less comprehensible. Two rounds, then a human.
- **Preserve comprehension.** The report's plain-language summary exists so the owner can still explain the change to another person without a model in between. Write it accordingly.

## Report format

```markdown
# Adversarial review: <change name> — round <N> of <cap>

## What this change does (plain language)
<5–10 lines the owner could repeat in a design discussion unaided>

## Summary
<counts by severity; which findings both reviewers hit independently;
whether reviewers executed code or reviewed statically>

## Findings
| # | Severity | Confidence | Found by | Claim (one line) |
|---|----------|------------|----------|------------------|

### F<n> — <title>   [severity, confidence, reviewer(s)]
**Claim:** with <input/state>, <what goes wrong> because <mechanism>.
**Evidence:** <file:line, trace, or failing repro>
**Suggested direction (not a patch):** <e.g. "make this state unrepresentable by …">
**Implementer rebuttal (round ≥ 2 only):** <evidence-backed, or omit>

## Reviewer disagreements
<where one reviewer's finding conflicts with the other's reading>

## Your decisions
Mark each finding: accept / reject / defer. The loop does not continue without this.
```

## Reference files

- `references/reviewer-prompt.md` — the verbatim role prompt handed to each reviewer context. Read it when dispatching reviewers; fill in the lens placeholder per reviewer.
