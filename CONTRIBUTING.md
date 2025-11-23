# Contributing to Jazz

Thanks for wanting to contribute! This document gives a quick set of guidelines and pointers to help new contributors get productive fast.

1. Read the READMEs

- We have short READMEs in three primary layers to help you understand the code layout and responsibilities:
  - `src/core/README.md` - business logic, domain types, and contracts
  - `src/services/README.md` - implementations/adapters and example patterns
  - `src/cli/README.md` - CLI commands, presentation, and entrypoint

2. Development checklist

- Fork the repository and create a feature branch
- Run the full checks locally:
  - Type check: `pnpm run build` or `npm run build`
  - Lint: `pnpm run lint` or `npm run lint`
  - Tests: `bun test` (project uses Bun for tests) or `npm test`
- Keep your changes small & focused. If adding an interface, add both: `src/core/interfaces/<name>.ts` and `src/services/<name>.ts` implementation.

3. Code style & tests

- New behavior must include tests when possible
- Unit test guidelines:
  - Mock interfaces with `Layer.succeed(TAG, mock)`
  - Prefer mocking services for isolated unit tests and use small integration tests to validate wiring
- Use project linting rules before committing

4. How to add a new service or adapter

- Add the interface to `src/core/interfaces` (include a Context tag)
- Implement the service in `src/services` and expose a Layer
- Add the Layer to `createAppLayer` in `src/main.ts` (if needed at runtime)
- Add tests with mocked and, where appropriate, integration-level tests

5. Documentation

- Update the appropriate README (core/services/cli) when you add features or change interfaces

6. Pull request checklist

- [ ] Branch from main
- [ ] Build passes locally
- [ ] Lint passes locally
- [ ] Tests pass locally
- [ ] README/ARCHITECTURE updated (if applicable)
- [ ] Short description of the change + motivation in PR description

If you want help writing a test or a service implementation for your change, open a draft PR and ask — maintainers will review and help iterate.
