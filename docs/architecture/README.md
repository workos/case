# Architecture Docs

How each repo works. Read these before making structural changes.

| Doc                                          | Repo                                             | What it covers                                                                         |
| -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [pipeline.md](pipeline.md)                   | `case` (this repo)                               | LangGraph pipeline engine, revision loop, crash resume, provider-routing agent runtime |
| [cli.md](cli.md)                             | `../cli/main`                                    | Adapter pattern, event emitter, command structure, framework installers                |
| [authkit-framework.md](authkit-framework.md) | `../authkit-nextjs`, `../authkit-tanstack-start` | Canonical middleware-session-provider-hooks pattern                                    |
| [authkit-session.md](authkit-session.md)     | `../authkit-session`                             | Framework-agnostic session layer, storage adapters, encryption                         |
| [skills-plugin.md](skills-plugin.md)         | `../skills`                                      | Plugin structure, skill types, eval framework                                          |
| [workos-node.md](workos-node.md)             | `../workos-node/main`                            | Module pattern, HTTP client, serialization, multi-runtime support                      |
