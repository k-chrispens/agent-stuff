---
name: review-resume
description: Resume a paused review loop.
---

Run this bash command:

```bash
bash ~/.claude/hooks/review-loop.sh resume
```

- If the command prints review instructions (a long prompt starting with "Great, now I want you to carefully read over..."), follow them and perform the review as instructed. Do not summarize — follow the response format exactly.
- If the command prints a short status message (e.g., "not active" or "already running"), relay that to the user instead.
