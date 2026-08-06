# Security Policy

## Reporting a vulnerability

If you find a security issue, report it privately to the BourbonBaggers maintainers.
Use the repository issue tracker only for low-risk coordination once a fix is already
underway and no sensitive details need to be shared.

Include:

- a short description of the issue;
- the affected command, page, or file path;
- the impact you observed or expect;
- any reproduction steps that do not require sharing secrets.

## Threat model

This repository intentionally runs automation against untrusted issue text and code.
The main security boundaries are:

- issue content, labels, and branch names are treated as data, not shell input;
- the dashboard is read-only but exposes live issue metadata and run output;
- autoship can merge, deploy, and verify health only after dispatcher-owned recovery
  has succeeded;
- credentials stay in the operator's GitHub, OpenAI, Anthropic, or shell environment
  rather than in the repository;
- local `.env` files, state, and agent output are considered sensitive runtime data and
  must not be committed.

If you are testing the dashboard or autoship flows locally, keep the service on loopback
unless you intentionally place it behind an authenticated proxy.
