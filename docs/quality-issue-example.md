# Creating a quality issue for autonomous work

The dispatcher is only as effective as the issue it receives. A good issue does not need
to prescribe every line of code, but it must make the desired outcome and the meaning of
“done” clear enough that an agent can act without inventing requirements.

## Start in a GitHub-connected AI chat

Do not begin with a blank issue form if the request touches an existing repository. Start
with a GitHub-connected AI chat session that can inspect the repository and its current
behavior.

Use the conversation to:

1. Explain the user or business problem in ordinary language.
2. Ask the AI to inspect the relevant code, documentation, and existing behavior.
3. Answer its clarifying questions about scope, priorities, edge cases, and tradeoffs.
4. Ask it to identify what a person would be able to observe when the work is complete.
5. Ask it to draft the issue below, then refine the draft together until it is accurate.
6. Create the GitHub issue only after the request describes an outcome the team actually wants.

A useful prompt is:

> Help me turn this request into a high-quality issue for an autonomous coding agent. First
> inspect the relevant repository context. Then ask me focused questions until you can state
> the user problem, desired behavior, acceptance criteria, non-goals, and verification steps
> without guessing. Do not write the issue until I confirm the scope.

The chat is the refinement step. The GitHub issue is the durable agreement that enters the
queue.

## What a quality issue contains

- **A specific outcome:** what should be different for a user or operator?
- **Context:** why the change matters and where the current behavior falls short.
- **Observable acceptance criteria:** facts someone can check, not intentions such as
  “make it better.”
- **Boundaries:** what is explicitly out of scope, especially for risky or broad work.
- **Verification:** which tests, commands, screenshots, or other evidence demonstrate the
  criteria.
- **Useful constraints:** compatibility, performance, rollout, or design requirements that
  the agent could not safely infer from the repository.

Keep the issue focused. If it contains several independent outcomes, split it into several
issues so each one can be claimed, completed, and verified independently.

## Example issue

```markdown
# Add a visible “last updated” time to the status dashboard

## Why this matters

Operators checking the dashboard cannot tell whether the information is current. A visible
update time will make it easier to distinguish a quiet system from a stale dashboard.

## Desired behavior

Show the time of the most recent successful status refresh near the dashboard heading. Use
the operator’s local time and make the label understandable without reading the source code.

## Acceptance criteria

- The dashboard displays a label such as “Updated 2 minutes ago” after a successful refresh.
- The label changes after a later successful refresh.
- A failed refresh does not replace the last known successful update time with a newer time.
- The label remains readable in the compact dashboard view.
- Existing status information and live-stream behavior continue to work.

## Out of scope

- Redesigning the dashboard layout.
- Adding a database or a new runtime dependency.
- Changing the meaning of any existing status field.

## Verification

- Add or update automated tests for successful refreshes and failed refreshes.
- Run `npm test` and `npm run typecheck`.
- Check the normal and compact dashboard views in a browser.
```

After the issue is created, apply the repository’s approved intake labels. The dispatcher
uses those labels to decide which work is eligible; the issue body remains the source of
truth for the requested behavior.

## A quick quality check before approval

Ask:

- Could an agent explain the intended result in one sentence?
- Could two people independently agree whether each criterion passed?
- Is anything important left to guess?
- Is the scope small enough to finish as one change?
- Does the verification section prove the outcome rather than merely prove that a command ran?

If the answer to any of these is no, return to the connected AI chat and refine the issue
before placing it in the autonomous queue.
