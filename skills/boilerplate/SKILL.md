---
name: boilerplate
description: Generate project scaffolds from descriptions. Use when starting a new project, scaffolding, or creating "CLI in Go", "React app with auth", or similar from a short description.
---

# Boilerplate

Generate minimal project scaffolds from short descriptions. Turn "CLI in Go with cobra" or "React app with auth" into a runnable structure with the right files and commands.

## When to Use

- User wants to start a new project from a description
- User asks for a scaffold, boilerplate, or starter
- User says "create a X that does Y" and expects a project layout

## Workflow

1. **Parse request**: Language, framework, key features (auth, DB, API, CLI)
2. **Choose stack**: Specific tools (e.g. cobra for Go CLI, Vite+React for frontend)
3. **Design layout**: Directories, main entry, config, README
4. **Generate**: Minimal files to run (main, config, one example)
5. **Verify**: Commands to install, run, test

## Common Patterns

### CLI

| Request         | Stack              | Output                                      |
| --------------- | ------------------ | ------------------------------------------- |
| "CLI in Go"     | cobra or flag      | main.go, cmd/root.go, go.mod                |
| "CLI in Node"   | commander or yargs | index.js, package.json, bin                 |
| "CLI in Python" | argparse or click  | main.py, pyproject.toml or requirements.txt |
| "CLI in Rust"   | clap               | main.rs, Cargo.toml                         |

Minimal: one command, --help, one subcommand or flag. README with install and run.

### Web App (frontend)

| Request               | Stack                       | Output                                      |
| --------------------- | --------------------------- | ------------------------------------------- |
| "React app"           | Vite + React                | src/App.tsx, index.html, package.json       |
| "React app with auth" | Vite + React + auth context | + auth context, login form, protected route |
| "Next.js app"         | Next.js                     | app/page.tsx, layout.tsx, package.json      |
| "Static site"         | HTML/CSS/JS or 11ty         | index.html, style.css, script.js            |

Minimal: one page, run with one command. Auth = context + simple login UI + one protected route.

### API / Backend

| Request              | Stack              | Output                             |
| -------------------- | ------------------ | ---------------------------------- |
| "REST API in Node"   | Express or Fastify | server.js, routes, package.json    |
| "REST API in Go"     | net/http or Gin    | main.go, handlers, go.mod          |
| "REST API in Python" | FastAPI            | main.py, routers, requirements.txt |

Minimal: one health route, one example resource route (GET/POST). README with run and curl example.

### Full-stack

| Request              | Stack                       | Output                               |
| -------------------- | --------------------------- | ------------------------------------ |
| "Full-stack with DB" | Next.js + Prisma or similar | app/, api/, schema, seed             |
| "React + Node API"   | Vite + Express              | frontend/, backend/, README for both |

Minimal: one flow (e.g. list + create) with real DB. README for setup and run.

## Scaffold Rules

1. **Minimal**: Only what’s needed to run and one clear path (e.g. one command, one route).
2. **Conventional**: Standard layout (e.g. cmd/ for Go, src/ for TS/JS).
3. **Runnable**: User can install deps and run with 1–2 commands.
4. **Documented**: README with install, run, and (if applicable) env vars.

## README for Scaffolds

```markdown
# [Project Name]

[One-line description]

## Setup

\`\`\`bash
[install deps: npm install, go mod download, etc.]
\`\`\`

## Run

\`\`\`bash
[npm run dev, go run ., etc.]
\`\`\`

## [Optional: Env / Config]
```

## What to Generate

- **Always**: Entry point, dependency file (package.json, go.mod, Cargo.toml, etc.), README
- **When relevant**: Config (e.g. .env.example), one test, .gitignore
- **Avoid**: Full app logic; keep to minimal “hello world” or one feature

## Ambiguity

If the request is vague:
- Pick one reasonable stack and say what you chose: "Using Vite + React; say if you want Next.js instead."
- Default to TypeScript for Node/React unless they say "JavaScript".

## Anti-Patterns

- ❌ Huge template with many options; keep it small
- ❌ Unrunnable (missing deps, wrong paths)
- ❌ No README or run instructions
- ❌ Over-engineered (e.g. full DDD for a tiny CLI)
