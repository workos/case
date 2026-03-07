# Playbook: Add a CLI Resource Command

> Reference: [docs/architecture/cli.md](../architecture/cli.md)
> Target repo: `../cli/main/`

## Prerequisites

Before starting, confirm:

- The WorkOS API endpoint for this resource exists and is documented.
- You know which subcommands are needed (subset of: `list`, `get`, `create`, `update`, `delete`).
- The `@workos-inc/node` SDK has methods for this resource (check `node_modules/@workos-inc/node/`).

## Step 1: Create the Command File

Create `src/commands/{resource}.ts`.

Follow the pattern in `src/commands/organization.ts`:

1. Import utilities:
   ```typescript
   import { createWorkOSClient } from '../lib/workos-client.js';
   import { outputSuccess, outputJson, isJsonMode } from '../utils/output.js';
   import { createApiErrorHandler } from '../lib/api-error-handler.js';
   ```

2. Create an error handler at module scope:
   ```typescript
   const handleApiError = createApiErrorHandler('ResourceName');
   ```

3. Export a handler function per subcommand (`runResourceList`, `runResourceGet`, etc.). Each handler:
   - Accepts typed arguments + `apiKey: string` + optional `baseUrl?: string`
   - Creates a client via `createWorkOSClient(apiKey, baseUrl)`
   - Calls the SDK method inside `try/catch`, using `handleApiError(error)` in catch
   - Uses `outputSuccess('Message', data)` for mutations (create/update/delete)
   - Uses `outputJson(data)` for read operations (get)
   - For `list`: checks `isJsonMode()` and branches -- JSON mode outputs `{ data, listMetadata }`, human mode uses `formatTable()` from `../utils/table.js`

4. For list commands, support pagination options: `limit`, `before`, `after`, `order`. Export an options interface:
   ```typescript
   export interface ResourceListOptions {
     limit?: number;
     before?: string;
     after?: string;
     order?: string;
   }
   ```

5. Use `.js` extensions on all relative imports (ESM requirement).

## Step 2: Create the Test File

Create `src/commands/{resource}.spec.ts`.

Follow the pattern in `src/commands/organization.spec.ts`:

1. Mock the WorkOS client:
   ```typescript
   const mockSdk = {
     resourceName: {
       listResources: vi.fn(),
       getResource: vi.fn(),
       // ...other methods
     },
   };

   vi.mock('../lib/workos-client.js', () => ({
     createWorkOSClient: () => ({ sdk: mockSdk }),
   }));
   ```

2. Import `setOutputMode` from `../utils/output.js` (dynamic import after mock).

3. Import your command handlers (dynamic import after mock):
   ```typescript
   const { setOutputMode } = await import('../utils/output.js');
   const { runResourceList, runResourceGet } = await import('./resource.js');
   ```

4. Test each subcommand in a `describe` block:
   - Verify SDK method is called with correct arguments
   - Verify console output contains expected data
   - Test empty results case for list commands

5. Add a `JSON output mode` describe block:
   - `beforeEach(() => setOutputMode('json'))`
   - `afterEach(() => setOutputMode('human'))`
   - Verify `JSON.parse(consoleOutput[0])` produces correct structure
   - For list: verify `data` array and `listMetadata` are present
   - For mutations: verify `status: 'ok'` and `data` fields

## Step 3: Register in bin.ts

Open `src/bin.ts`. Add a `.command()` call in the yargs chain.

Pattern (from the organization command):

```typescript
.command(['resource-name', 'alias'], 'Description of resource management', (yargs) => {
  yargs.options({
    ...insecureStorageOption,
    'api-key': {
      type: 'string' as const,
      describe: 'WorkOS API key (overrides environment config)',
    },
  });
  registerSubcommand(
    yargs,
    'list',
    'List resources',
    (y) => y.options({
      limit: { type: 'number', describe: 'Limit number of results' },
      before: { type: 'string', describe: 'Cursor before' },
      after: { type: 'string', describe: 'Cursor after' },
      order: { type: 'string', describe: 'Order (asc or desc)' },
    }),
    async (argv) => {
      await applyInsecureStorage(argv.insecureStorage);
      const { resolveApiKey, resolveApiBaseUrl } = await import('./lib/api-key.js');
      const { runResourceList } = await import('./commands/resource.js');
      await runResourceList(
        { limit: argv.limit, before: argv.before, after: argv.after, order: argv.order },
        resolveApiKey({ apiKey: argv.apiKey }),
        resolveApiBaseUrl(),
      );
    },
  );
  // ... repeat for get, create, update, delete
  return yargs.demandCommand(1, 'Please specify a resource subcommand').strict();
})
```

Key details:
- Wrap each handler with `await applyInsecureStorage(argv.insecureStorage)` at the top.
- Use dynamic `import()` for the command module (lazy loading).
- Use `resolveApiKey({ apiKey: argv.apiKey })` and `resolveApiBaseUrl()` from `./lib/api-key.js`.
- Use `registerSubcommand()` from `./utils/register-subcommand.js` for each subcommand.
- For commands requiring auth, the parent `.command()` registration handles it via the `withAuth` wrapper or `ensureAuthenticated()`.

## Step 4: Update help-json.ts

Open `src/utils/help-json.ts`. Add a new entry to the `commands` array.

Pattern:
```typescript
{
  name: 'resource-name',
  description: 'Manage WorkOS resources (list, get, create, delete)',
  options: [insecureStorageOpt, apiKeyOpt],
  commands: [
    {
      name: 'list',
      description: 'List resources',
      options: [...paginationOpts],
    },
    {
      name: 'get',
      description: 'Get a resource',
      positionals: [{ name: 'id', type: 'string', description: 'Resource ID', required: true }],
    },
    // ... other subcommands
  ],
},
```

Use the shared option fragments defined at the top of the file: `insecureStorageOpt`, `apiKeyOpt`, `paginationOpts`.

## Step 5: Run Checks

```bash
cd ../cli/main
pnpm test          # all tests pass
pnpm typecheck     # no type errors
pnpm lint          # oxlint clean
pnpm format        # oxfmt clean
pnpm build         # compiles
```

## Step 6: Open PR

- Branch: `feat/add-{resource}-command`
- Commit: `feat: add {resource} command` (conventional commit)
- PR title: `feat: add {resource} command`
- PR body: describe what the command does, which subcommands, link to API docs
- One concern per PR -- do not bundle unrelated changes

## Verification Checklist

- [ ] `workos {resource} list` works in human and JSON mode
- [ ] `workos {resource} get <id>` works
- [ ] Other subcommands (create/update/delete) work if implemented
- [ ] `workos {resource} --help` shows correct usage
- [ ] `workos --help --json` includes the new command
- [ ] All tests pass including JSON output mode tests
- [ ] No type errors
- [ ] File is under 300 lines (split if needed)

## Common Mistakes

- **Forgetting `.js` extensions** on imports. Node ESM requires them. The build will succeed but runtime fails.
- **Not testing JSON mode**. Every command must work with `--json`. The spec must test `setOutputMode('json')`.
- **Not updating help-json.ts**. The command tree is a parallel registry -- it doesn't auto-discover from yargs.
- **Forgetting `handleApiError`**. All API calls must be wrapped in try/catch with the typed error handler.
- **Hard-coding API key argument**. Always use `resolveApiKey()` which checks argv, env config, and env vars.
