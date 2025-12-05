# API Integration Generator

Research an API and generate complete integration code for your project.

## Example

**Ask:** `"Research the Stripe Payment Intents API and create a complete integration for our Node.js app"`

**Jazz will:**

1. Research the API documentation
2. Analyze your existing codebase structure
3. Generate integration code
4. Create tests
5. Update configuration files
6. Create documentation

## Setup

Create an agent with web search, file system, and shell tools:

```bash
jazz agent create
# Name: api-integration
# Tools: Web Search, File System, Shell
```

## Usage

```bash
jazz agent chat api-integration
```

Then ask Jazz to research and integrate an API. Jazz will:

- Research the API documentation
- Understand your codebase structure
- Generate integration code
- Create tests
- Update configuration
- Document the integration

## Example Output

```
You: Research the Stripe Payment Intents API and create a complete
     integration for our Node.js app

Agent: [Researching Stripe documentation]

✓ Read Stripe Payment Intents docs
✓ Analyzed our existing codebase structure
✓ Generated integration code

Created files:
✓ src/api/stripe.ts (Payment Intent creation)
✓ src/api/webhooks.ts (Stripe webhook handling)
✓ tests/stripe.test.ts (Unit tests)
✓ docs/stripe-integration.md (Tutorial)
✓ Updated .env.example (Added Stripe keys)

The integration includes:
- Payment Intent creation
- Webhook handling for confirmations
- Error handling for declined payments
- Test card numbers for development
- Idempotency key support

Should I commit these changes?

You: yes

Agent: ✓ Committed: "feat: add Stripe Payment Intents integration"
```

## More Examples

- `"Integrate the GitHub API for repository management"`
- `"Create a Slack bot integration"`
- `"Add Twilio SMS integration to the app"`
- `"Integrate the OpenAI API for chat features"`

## Tips

- Jazz researches the latest API documentation
- Generated code follows your project's patterns
- Tests are included for reliability
- Configuration files are updated automatically
- Documentation is generated for the integration
