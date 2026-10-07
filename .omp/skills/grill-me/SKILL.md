---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

**Ask via the `ask` tool (or OpenCode `question` tool) only** — one question per turn. Do not ask in markdown (`Reply with 1, 2, or 3`, numbered lists in prose, or "If you want, I can…" menus). After I answer, call the question/ask tool again for the next decision.

When you have a recommendation, put it in the picker's option labels/descriptions (e.g. short label with `*` or "(Recommended)" within the 30-character label limit). Do not state the recommendation in chat prose instead of using the tool.

If a question can be answered by exploring the codebase, use `read` / `grep` / `glob` / `list` first — then `question` if I still need to choose.
