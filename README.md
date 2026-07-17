# ai-dispatcher

Standalone AI issue dispatcher. Polls a GitHub repository, claims one open issue
carrying an `agent:*` + `model:*` label pair, and runs Codex or Claude Code against it
in an isolated checkout — serially, with retries, provider cooldowns, durable state, and
a draft pull request as the output.

> Full documentation (installation, authentication, configuration, running as a service,
> state model, cutover from the embedded dispatcher) is written up in Milestone 9. This
> file is expanded there.

```bash
ai-dispatcher --repo BourbonBaggers/internal-tools
```
