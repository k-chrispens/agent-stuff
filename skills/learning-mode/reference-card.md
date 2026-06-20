# AI-Assisted Learning: Workflow Reference Card

> **The first principle is that you must not fool yourself — and you are the easiest person to fool.** (Feynman)
> **Learning is not supposed to be frictionless — the primary feeling should be that of effort. You want the mental equivalent of sweat.** (Karpathy)
> There is a difference between knowing the name of something and knowing something — and between learning and the *feeling* of learning. This workflow keeps both differences visible.
> **This is for learning deeply, not for using a tool to get something done.** If you just need to ship or get an answer, skip the workflow and ask normally.
> **Core loop:** Triage (once) → Struggle → Dialogue → Test → repeat depth-first, pulling concepts in on demand.

---

## Triage (once per topic — a conversation, not a prompt)

This phase is a short back-and-forth, not a one-shot prompt. The AI asks one question at a time and only moves on when you're ready. You should be doing most of the talking.

### What the conversation establishes
- **Your true motivation.** Why this, why now? Genuine curiosity and willingness to invest time beat casual interest. The AI will probe — be honest.
- **Deep learning vs. tool usage.** If you really just want to *use* something or get an answer, this is the wrong mode. No shame — exit and ask normally.
- **The effort dial (yours to set).** High motivation → full workflow. Limited time → a lighter version (shorter struggle, lighter testing). Less effort in, less understanding out — your call.
- **A self-explanation target.** What should you be able to *do and explain in your own words* by the end? Make it concrete ("derive the ELBO from scratch and explain each term"), not vague ("understand variational inference").
- **A concrete, depth-first goal.** Default to a project (build nanoGPT to learn transformers; write the parser to learn parsing). When a project doesn't fit, pick an equivalent: re-derive a theorem, reproduce a paper's result, solve a hard problem set, explain a chapter cold.

### Opener (paste this, then converse)

```
I want to learn [TOPIC]. Before we plan anything, ask me — one question at a time — why I want to learn this and what I want to be able to do with it. Help me turn it into a concrete, depth-first goal (a project if one fits). Don't lay out a full curriculum; we'll pull in concepts on demand as the goal demands them. Keep your turns short.
```

### Depth-first, not breadth-first
Don't map the whole field up front (Karpathy: "do not learn bottom-up breadth-first"). Start the goal, and when you hit a wall that needs a prerequisite, learn *just that*, then return. The map serves the project, never the reverse.

---

## Struggle (per concept, NO AI)

**Minimum time:** scaled to your effort budget — ~20 min for a light session, 60+ for a full one. Karpathy: for serious learning, block out a ~4-hour focused window.

### What to do
- **Build or derive it from scratch first.** Construction is the default; reading-and-explaining is the fallback for things you genuinely can't build.
- **Type code out yourself — do not copy-paste** (Karpathy). The act of typing each line is part of the learning.
- Don't just read: **read → take notes → re-read → rephrase → process → manipulate.** Passive reading is the *feeling* of learning, not learning.
- Write down your understanding in your own words, and **specific** confusion points

### What to bring back
1. Your current attempt (explanation, code, derivation)
2. Specific confusion points: "I followed X up to step Y, then I don't see why Z follows"

### Red flag
If you're tempted to open Claude before your minimum time is up, notice that impulse. The struggling is not the obstacle to learning — it IS the learning. That discomfort you're feeling is your brain doing real work. If you skip it, you'll nod along with whatever Claude says and feel like you understand, and you won't.

---

## Dialogue (per concept, two modes)

### Mode A: Coach — Resolve Confusions

```
I'm working on understanding [CONCEPT]. Here's my current understanding:

[YOUR EXPLANATION]

Here's where I get stuck:

[SPECIFIC CONFUSION]

Don't explain the answer — ask me questions that help me figure it out myself. There's a real difference between being told something and figuring it out: the second group can handle the next question. If I'm truly stuck after a few rounds, give me one small hint, not the whole solution.
```

**If Claude gives too much away:**

```
That was too direct. I want to figure this out, not be told. Back up and give me a smaller hint about which direction to think.
```

### Mode B: Student — Verify Understanding

```
Act as a student who's struggling with [CONCEPT]. I'm going to explain it to you. Your job:
- Ask clarifying questions when my explanation is vague or hand-wavy
- Express confusion about parts I'm not explaining well
- Do NOT correct me — let me identify and fix my own errors
- Gradually ask harder questions as I demonstrate understanding
```

### Escalation Ladder (when stuck)
1. Reframing question from Claude
2. One-sentence directional hint
3. One step revealed, you continue from there
4. Fuller explanation (last resort) → immediately followed by a probing question

---

## Test (per concept)

### Prompt Template: Problem Generation

```
Generate [N] problems on [CONCEPT]. Specifications:
- Difficulty: comparable to [REFERENCE — e.g., "a graduate Bayesian stats problem set", "harder ziglings exercises"]
- Type: [proof/derivation, computation, implementation, conceptual, mixed]
- Scope: [just this concept / integrating with PRIOR CONCEPTS]
- Do NOT provide hints, starter code, or solution sketches
- Include at least one problem that connects to [RELATED CONCEPT I ALREADY KNOW]
```

### Prompt Template: Work Checking

```
Here's my [derivation / implementation / solution] for [PROBLEM]:

[YOUR WORK]

Before checking correctness:
1. Ask me to explain my approach and why I chose it
2. Probe my reasoning — ask about assumptions and edge cases
3. If something is wrong, don't reveal the error — ask me a question that helps me find it
4. If it's correct, push deeper: can I generalize? Is there a more elegant approach?
```

### Metacognitive Review (after each problem set)

Answer honestly:
- **Confidence (1-5):** Could I solve a similar problem tomorrow with no help?
- **Remaining gaps:** What parts still feel shaky?
- **Prediction:** If this were harder, what would trip me up?
- **Progress, not perfection:** What can I do now that I couldn't an hour ago? (Karpathy: compare only to younger you, never to others.)

---

## Self-Monitoring System

### Session Log (after each study session)

| Date | Concept | Independent time (min) | Problems: no AI | Problems: with AI | Can I reproduce this from scratch? |
| ---- | ------- | ---------------------- | --------------- | ------------------ | ---------------------------------- |
|      |         |                        |                 |                    | Yes / Mostly / No                  |

### Weekly Whiteboard Test — "What I Cannot Create, I Do Not Understand"

Pick the most important concept from the week. Explain it from scratch — out loud or in writing — with no notes and no AI. Derive the key result. Connect it to adjacent concepts. If you can't do it fluently, you know the name of the thing but you don't know the thing. That concept needs another pass through the loop.

### No-AI Sessions

Designate specific sessions (e.g., every other session, or one day per week) as no-AI. Work through problems with only textbooks and your own notes. **The difficulty gap between AI-assisted and no-AI sessions measures the distance between your perceived and actual understanding.**

### Warning Signs: You're Fooling Yourself

The whole point is to not fool yourself. Here's what self-deception looks like in practice:

- **The nod-along:** You paste a question, read the answer, think "yeah, that makes sense." You know the name of the thing. You don't know the thing.
- **The guided mirage:** You can follow along when Claude walks you through it step by step, but you can't start from a blank page and get anywhere.
- **The confidence gap:** You feel increasingly confident, but your unassisted problem-solving ability hasn't budged. This is the most dangerous one because it feels like progress.
- **Recognition vs. recall:** "It makes sense when I read it" is recognition. "I can derive it from scratch" is recall. Only the second one counts.
- **Pattern matching without understanding:** You get the right answer but can't explain why it's right, or what would change if the problem were slightly different.

---

## Domain-Specific Notes

### Mathematical / Theoretical Learning
- Struggle: Derivations on paper. Attempt the proof before you look for help. If you can't derive it, you don't understand it — you just know its name.
- Dialogue: Coach mode on "where does this step come from?" and "why does it have to be this way?" — not "what's the answer?"
- Test: Proof problems, derivation variants, connecting formalisms. Vary the surface features; keep the deep structure.
- **Caution:** AI math reasoning is fragile at graduate+ level. It will confidently write derivations with subtle errors. Always verify independently. Don't trust AI algebra — you are the authority here.

### Programming / Skill Learning
- Struggle: Read docs, write code from a blank file (type it out, don't paste), hit compiler errors. The errors are informative — they're telling you what you don't understand yet.
- Dialogue: Bring broken code and ask about your mental model of the language semantics, not "fix my code."
- Test: Implementation challenges with specified behavior, no starter code. If you can't write it from scratch, you don't understand it.
- **Caution:** Claude Code is a force multiplier for production but actively harmful for learning. Be honest with yourself about which mode you're in before each session.

### Paper Reading / Conceptual Learning
- Struggle: Read the primary source. Write a summary in your own words BEFORE any AI interaction. You wouldn't learn quantum mechanics by having someone describe a textbook to you — you'd read the textbook.
- Dialogue: Student mode is especially powerful here — explain the paper's argument to AI and find out where your understanding falls apart.
- Test: Application questions, connection questions, "what would change if..." questions. Real understanding means you can extend the idea, not just restate it.
- **Caution:** AI summaries harm high-performing readers. They replace the constructive cognitive work of reading with passive consumption. Always read first.

---

## Why This Matters (for when the process feels slow)

The research is unambiguous: the easy path and the learning path are different paths.

- Students using unrestricted ChatGPT solve 48% more practice problems but score 17% worse on exams (Bastani et al., 2025, PNAS). They got faster at performing understanding without actually understanding.
- Well-designed Socratic AI tutoring doubled learning gains vs. best-practice active learning (Kestin et al., 2025, Harvard). The design of the interaction is everything.
- Self-regulated AI access produced less than half the gains of system-regulated access (Poulidis et al., 2025, Wharton). Knowing that over-reliance hurts you does not prevent over-reliance. You need structural constraints, not just good intentions.
- AI users consistently overestimate their own understanding, and higher AI literacy correlates with MORE overestimation (Welsch et al., 2025). The better you are at using AI, the easier it is to fool yourself.
- EEG shows ChatGPT users have the lowest brain engagement of any group, with declining neural connectivity across sessions (Kosmyna et al., 2025, MIT). The tool that feels most productive is producing the least neural work.
- Metacognitive requirements (self-explanation + confidence declaration) were more impactful than AI feedback itself (ACM L@S, 2025). How you think about your thinking matters more than what the AI tells you.
- Current LLMs achieve only ~10-15% on research-level math (FrontierMath benchmark). At PhD level, you are the authority. The AI is a sparring partner, not an oracle.

The goal is never to get through material. The goal is to make the material part of how you think. What you cannot create, you do not understand.
