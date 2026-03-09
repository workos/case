# Playbooks

Step-by-step guides for recurring operations across WorkOS OSS repos. Each playbook is designed to be executed by an agent given a corresponding task template.

## Index

| Playbook | Use When | Task Template |
|----------|----------|---------------|
| [Add CLI Command](add-cli-command.md) | Adding a new resource command to the WorkOS CLI | `tasks/templates/cli-command.md` |
| [Add AuthKit Framework](add-authkit-framework.md) | Creating a new AuthKit integration for a framework | `tasks/templates/authkit-framework.md` |
| [Add a Feature](add-feature.md) | Adding a new feature to any target repo | — |
| [Fix a Bug](fix-bug.md) | Triaging and fixing a bug in any target repo | `tasks/templates/bug-fix.md` |
| [Cross-Repo Update](cross-repo-update.md) | Coordinated changes across multiple repos | `tasks/templates/cross-repo-update.md` |

## How Playbooks Work

1. A human fills in a task template (from `tasks/templates/`) and drops it in `tasks/active/`.
2. The implementer reads the task and playbook, writes the fix/feature, and commits.
3. The verifier tests the specific scenario with fresh context.
4. The reviewer checks the diff against golden principles and conventions.
5. The closer opens a PR in the target repo (requires `.case-reviewed`).
6. After merge, the task file moves to `tasks/done/`.

## Related Docs

- [Task File Format](../../tasks/README.md)
- [Architecture: CLI](../architecture/cli.md)
- [Architecture: AuthKit Framework Integrations](../architecture/authkit-framework.md)
- [Architecture: AuthKit Session](../architecture/authkit-session.md)
- [Convention: Commits](../conventions/commits.md)
- [Convention: Testing](../conventions/testing.md)
- [Convention: Pull Requests](../conventions/pull-requests.md)
- [Golden Principles](../golden-principles.md)
