# Integrations

Jazz supports various third-party integrations to enhance your agents' capabilities. This guide covers how to set up and configure each integration.

## Table of Contents

- [LLM Providers](#llm-providers)
- [Gmail Integration](#gmail-integration)
- [Web Search](#web-search)
- [Configuration Examples](#configuration-examples)

---

## LLM Providers

Jazz supports multiple LLM providers. You need at least one configured to create agents.

### OpenAI

**Setup**:

**Capabilites**: Latest OpenAI models with advanced tool use

1. Get your API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Add to your config:

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L13-L27)

### Anthropic

**Capabilities**: Claude Sonnet, Haiku and Opus with advanced tool use

**Setup**:

1. Get your API key from [Anthropic Console](https://console.anthropic.com/)
2. Add to your config:

```json
{
  "llm": {
    "anthropic": {
      "api_key": "sk-ant-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L28-L32)

### Google Gemini

**Capabilities**: Gemini Pro and Flash models with multimodal support

**Setup**:

1. Get your API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Add to your config:

```json
{
  "llm": {
    "google": {
      "api_key": "AIza..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L33-L42)

### Mistral AI

**Capabilities**: Mistral models with strong reasoning

**Setup**:

1. Get your API key from [Mistral Console](https://console.mistral.ai/)
2. Add to your config:

```json
{
  "llm": {
    "mistral": {
      "api_key": "mist..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L43-L49)

### xAI (Grok)

**Capabilities**: Grok models with real-time information

**Setup**:

1. Get your API key from [xAI Console](https://console.x.ai/)
2. Add to your config:

```json
{
  "llm": {
    "xai": {
      "api_key": "xai-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L50-L65)

### DeepSeek

**Capabilities**: Cost-effective models with strong reasoning

**Setup**:

1. Get your API key from [DeepSeek Platform](https://platform.deepseek.com/)
2. Add to your config:

```json
{
  "llm": {
    "deepseek": {
      "api_key": "sk-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L66)

### Ollama (Local Models)

**Capabilities**: Run models locally without API keys

**Setup**:

1. Install Ollama from [ollama.ai](https://ollama.ai/)
2. Pull a model: `ollama pull llama3.2`
3. Jazz will auto-detect available models from your Ollama instance.

---

## Gmail Integration

Enable your agents to manage Gmail: read, search, send emails, manage labels, and more.

### Prerequisites

- A Google account
- Access to [Google Cloud Console](https://console.cloud.google.com/)

### Setup Steps

#### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Select a project** → **New Project**
3. Name your project (e.g., "Jazz Agent")
4. Click **Create**

#### 2. Enable Gmail API

1. In your project, go to **APIs & Services** → **Library**
2. Search for "Gmail API"
3. Click **Gmail API** → **Enable**

#### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose **External** (unless you have Google Workspace)
3. Click **Create**
4. Fill in required fields:
   - **App name**: "Jazz Agent" (or your choice)
   - **User support email**: Your email
   - **Developer contact**: Your email
5. Click **Save and Continue**
6. On **Scopes** page:
   - Click **Add or Remove Scopes**
   - Add these Gmail scopes:
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/gmail.compose`
     - `https://www.googleapis.com/auth/gmail.labels`
   - Click **Update** → **Save and Continue**
7. On **Test users** page:
   - Click **Add Users**
   - Add your Gmail address
   - Click **Save and Continue**

#### 4. Create OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Choose **Desktop app** as application type
4. Name it "Jazz CLI"
5. Click **Create**
6. **Important**: Add the redirect URI:
   - Click the pencil icon to edit your OAuth client
   - Under **Authorized redirect URIs**, add:
     ```
     http://localhost:53682/oauth2callback
     ```
   - Click **Save**
7. Download the credentials JSON or copy the Client ID and Client Secret

#### 5. Add to Jazz Configuration

To setup the configuration, run:

```bash
jazz config set google.
```

And paste your client id and client secret when prompted.

#### 6. Authenticate

```bash
# Authenticate with Gmail
jazz auth gmail login

# This will:
# 1. Open your browser
# 2. Ask you to sign in to Google
# 3. Request permissions for Gmail access
# 4. Redirect back to Jazz (localhost)
# 5. Store authentication tokens securely

# Verify authentication
jazz auth gmail status
```

#### 7. Create an Agent with Gmail Tools

```bash
jazz agent create

# During creation:
# - Choose tools → Select "Gmail" category
# - This gives your agent access to all Gmail operations
```

### Gmail Tool Capabilities

Your agents can now:

- **Read Emails**: List, search, get full content
- **Send & Draft**: Compose and send emails on your behalf
- **Label Management**: Create, update, delete, apply labels
- **Email Actions**: Trash, delete, archive with approval
- **Batch Operations**: Modify multiple emails at once
- **Smart Search**: Use Gmail's powerful query syntax

### Security & Privacy

- **Token Storage**: Tokens are stored locally in `~/.jazz/google/gmail-token.json`
- **User Approval**: Destructive operations (delete, trash) require explicit approval
- **Read-Only by Default**: Agents can read freely but must ask before modifying
- **Revoke Access**: Run `jazz auth gmail logout` or revoke in [Google Account Settings](https://myaccount.google.com/permissions)

### Troubleshooting Gmail

**"Invalid Client" Error**:

- Verify redirect URI is exactly `http://localhost:53682/oauth2callback`
- Check Client ID and Secret are correct
- Ensure Gmail API is enabled

**"Access Blocked" Error**:

- Add your email as a test user in OAuth consent screen
- Verify scopes are configured correctly

**"Token Expired" Error**:

- Refresh tokens expire if unused for 6 months
- Re-authenticate: `jazz auth gmail login`

---

## Web Search

Enable your agents to search the web and get current information.

[Linkup](https://www.linkup.so/) and [Exa](https://exa.ai/) provide high-quality web search optimized for AI agents.

### Why Linkup/Exa?

- **AI-Optimized Results**: Structured data perfect for agents
- **Deep Search Mode**: Comprehensive research capabilities
- **Source Attribution**: Always know where information comes from
- **Fresh Content**: Access to current web information

### Setup Steps

#### 1. Get API Key

1. Visit [linkup.so](https://www.linkup.so/) or [exa.ai](https://exa.ai/)
2. Sign up for an account
3. Navigate to your dashboard
4. Copy your API key

#### 2. Add to Jazz Configuration

```sh
jazz config set linkup # jazz config set linkup.api_key <YOUR_LINKUP_API_KEY>
jazz config set exa # jazz config set exa.api_key <YOUR_EXA_API_KEY>
```

### Web Search Capabilities

Your agents can now:

- **Standard Search**: Quick results for common queries
- **Deep Search**: Comprehensive research with multiple sources
- **Sourced Answers**: AI-friendly format with citations
- **Raw Results**: Direct search results for parsing
- **Image Search**: Optional image results

### Usage Example

```bash
jazz agent chat my-agent

You: Search for the latest TypeScript 5.5 features

Agent: [Uses web_search]
       Based on recent web sources:

       TypeScript 5.5 introduces:
       1. Inferred Type Predicates
       2. Control Flow Narrowing Improvements
       3. [More features...]

       Sources:
       - TypeScript Blog
       - GitHub Release Notes
       - Dev.to Articles
```
