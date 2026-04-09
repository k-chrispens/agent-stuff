---
name: review-interrupt
description: Set what happens when you send a message during an active review loop (pause or stop).
---

Extract the argument from the user's message. Valid values: `pause` or `stop`.

If no valid argument is found, tell the user: "Usage: /review-interrupt <pause|stop>. Controls what happens when you send a message while the review loop is active."

Otherwise run:

```bash
bash ~/.claude/hooks/review-loop.sh interrupt ARG
```

Replace ARG with `pause` or `stop`. Relay the output to the user.
