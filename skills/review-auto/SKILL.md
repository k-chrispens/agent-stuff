---
name: review-auto
description: Toggle or set auto-trigger mode for the review loop.
---

Extract the argument from the user's message. Valid values: `on`, `off`, `toggle` (or no argument, which defaults to `toggle`).

If the user passes anything else (e.g., focus text like "focus on error handling"), respond with:
"Usage: /review-auto [on|off|toggle]. To start a review with focus text, use /review-start <focus>."

Otherwise run:

```bash
bash ~/.claude/hooks/review-loop.sh auto ARG
```

Replace ARG with `on`, `off`, or `toggle`. Relay the output to the user.
