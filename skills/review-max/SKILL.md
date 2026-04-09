---
name: review-max
description: Set the maximum number of review iterations.
---

Extract a positive integer from the user's message. If no valid integer is found, tell the user: "Usage: /review-max <N> where N is a positive integer."

If a valid integer N is found, run:

```bash
bash ~/.claude/hooks/review-loop.sh max N
```

Replace N with the actual number. Relay the output to the user.
