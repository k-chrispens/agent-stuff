---
name: review-start
description: Activate the iterative code review loop. Claude will re-review its own work until no issues remain or the iteration cap is hit.
---

You are activating the review loop. Do this now:

1. Run this bash command:

   ```bash
   bash ~/.claude/hooks/review-loop.sh activate code
   ```

   You do NOT need to extract focus text from the user's prompt — the
   UserPromptSubmit hook has already parsed it and stored it in a pending
   file that `activate` will read automatically.

2. The command prints the review instructions on stdout. Read them carefully
   and perform the review as instructed. Do not summarize the prompt — follow
   its response format exactly, including ending with either "Fixed N issue(s).
   Ready for another review." or "No issues found." as appropriate.

3. If the command fails (non-zero exit), relay its stderr message to the user
   instead of starting the review.
