# Cross-Repository Refactoring

Refactor code patterns across multiple repositories simultaneously.

## Example

**Ask:** `"Find all repositories in ~/projects that use the old Logger class and refactor them to use the new LoggerService"`

**Jazz will:**

1. Scan multiple repositories
2. Identify files using the old pattern
3. Show you example refactorings
4. Apply changes across all repos with your approval
5. Run tests to verify nothing broke
6. Create commits in each repository

## Setup

Create an agent with git, file management, and shell tools:

```bash
jazz agent create
# Name: refactor-master
# Tools: Git, File Management, Shell
```

## Usage

```bash
jazz agent chat refactor-master
```

Then describe the refactoring you want to perform. Jazz will:

- Scan the specified directories for matching patterns
- Show you examples of the changes before applying
- Apply changes across all matching repositories
- Run tests to ensure nothing broke
- Create commits in each repository

## Example Output

```
You: Find all repositories in ~/projects that use the old Logger class
     and refactor them to use the new LoggerService

Agent: Scanning ~/projects...

Found old Logger usage in 5 repositories:
1. ~/projects/api-service (12 files)
2. ~/projects/web-app (8 files)
3. ~/projects/worker (5 files)
4. ~/projects/admin-panel (6 files)
5. ~/projects/mobile-backend (9 files)

Total: 40 files to refactor

Should I proceed with refactoring?

You: yes, show me the changes for one file first

Agent: Example refactoring (api-service/src/auth.ts):

- import { Logger } from './logger';
+ import { LoggerService } from '@company/logger';

- const logger = new Logger('auth');
+ const logger = LoggerService.create('auth');

- logger.log('User logged in');
+ logger.info('User logged in');

Apply this pattern to all 40 files?

You: yes

Agent: [Refactoring across repositories]

✓ api-service: 12 files updated
✓ web-app: 8 files updated
✓ worker: 5 files updated
✓ admin-panel: 6 files updated
✓ mobile-backend: 9 files updated

✓ All tests passing across all repositories
✓ Created commits in each repository

Summary:
- 40 files refactored
- 5 repositories updated
- 0 breaking changes
- All tests passing
```

## More Examples

- `"Replace all instances of console.log with the Logger utility in ~/projects"`
- `"Update all API endpoints from REST to GraphQL in my microservices"`
- `"Migrate all components from class to functional components"`
- `"Refactor authentication patterns across all repos"`

## Tips

- Be specific about the pattern you want to change
- Review the example refactorings before approving
- Jazz will ask for approval before making changes
- All changes are committed with descriptive messages
- Tests are run to verify nothing broke



