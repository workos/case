# Playbooks

Step-by-step guides for recurring operations across WorkOS OSS repos. Each playbook is designed to be executed by an agent given a corresponding task template.

## Index

| Playbook | Use When | Task Template |
|----------|----------|---------------|
| [Add CLI Command](add-cli-command.md) | Adding a new resource command to the WorkOS CLI | `tasks/templates/cli-command.md` |
| [Add AuthKit Framework](add-authkit-framework.md) | Creating a new AuthKit integration for a framework | `tasks/templates/authkit-framework.md` |
| [Fix a Bug](fix-bug.md) | Triaging and fixing a bug in any target repo | `tasks/templates/bug-fix.md` |
| [Cross-Repo Update](cross-repo-update.md) | Coordinated changes across multiple repos | `tasks/templates/cross-repo-update.md` |

## How Playbooks Work

1. A human fills in a task template (from `tasks/templates/`) and drops it in `tasks/active/`.
2. An agent reads the task, which references a playbook.
3. The agent follows the playbook steps, checking off the task's checklist as it goes.
4. The agent opens a PR in the target repo.
5. After merge, the task file moves to `tasks/done/`.

## Related Docs

- [Task File Format](../../tasks/README.md)
- [Architecture: CLI](../architecture/cli.md)
- [Architecture: AuthKit Framework Integrations](../architecture/authkit-framework.md)
- [Architecture: AuthKit Session](../architecture/authkit-session.md)
- [Convention: Commits](../conventions/commits.md)
- [Convention: Testing](../conventions/testing.md)
- [Convention: Pull Requests](../conventions/pull-requests.md)
- [Golden Principles](../golden-principles.md)
