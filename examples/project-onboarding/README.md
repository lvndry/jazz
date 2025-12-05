# Automated Project Onboarding

Clone a repository and automatically execute all setup instructions from the README.

## Example

**Ask:** `"Clone https://github.com/user/awesome-project and follow the README setup"`

**Jazz will:**

1. Clone the repository to your preferred directory
2. Detect the tech stack (Node.js, Python, etc.)
3. Search for setup instructions in README/docs
4. Install dependencies (`npm install`, `pip install`, etc.)
5. Create `.env` file from `.env.example` and prompt for missing keys
6. Run initialization scripts if needed
7. Verify the setup by running tests
8. Summarize what was configured and next steps

## Setup

Create an agent with git, shell, and file management tools:

```bash
jazz agent create
# Name: project-setup
# Tools: Git, Shell, File Management
```

## Usage

```bash
jazz agent chat project-setup
```

Then ask Jazz to set up a project. Jazz will:

- Clone the repository
- Read and parse setup instructions
- Execute setup steps with your approval
- Ask before running potentially dangerous commands (migrations, etc.)
- Verify the setup

## Example Output

```
You: Clone https://github.com/user/awesome-project and follow the README setup

Agent: ✓ Repository cloned to ./awesome-project

Found setup instructions:
1. Install dependencies: npm install
2. Copy .env.example to .env
3. Run database migrations: npm run migrate
4. Start dev server: npm run dev

Should I execute these steps?

You: yes, but ask before running migrations

Agent: [Executes steps 1-2]

✓ Dependencies installed (234 packages)
✓ Created .env from .env.example

⚠️ About to run: npm run migrate
This will modify your database.

Proceed? (yes/no)

You: yes

Agent: ✓ Migrations completed (applied 12 migrations)

✓ Setup complete! Ready to develop!
```

## More Examples

- `"Set up this repo for local development"`
- `"Clone and configure the project from this URL"`
- `"Follow the setup instructions in the README"`

## Tips

- Jazz will ask for approval before running potentially dangerous commands
- You can specify which steps to skip or require approval for
- Jazz detects the tech stack automatically
- Setup instructions are parsed from README, docs, or setup scripts



