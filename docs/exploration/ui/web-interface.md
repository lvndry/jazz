# Web Interface for Jazz Agents

## Overview

This document outlines the implementation plan for a `jazz ui` command that spawns a web-based chat interface on `localhost:3000`, allowing users to interact with Jazz agents through a browser instead of the CLI.

## Goals

1. **Web-Based Chat Interface**: Provide a modern, responsive web UI for chatting with Jazz agents
2. **Real-Time Streaming**: Support streaming agent responses via Server-Sent Events (SSE)
3. **Feature Parity**: Maintain all CLI chat features (special commands, tool execution, etc.)
4. **Seamless Integration**: Reuse existing agent execution logic without modification
5. **Developer Experience**: Easy to use, fast to start, minimal dependencies

## Architecture

### High-Level Design

```
┌─────────────────┐
│   Browser UI    │
│  (localhost:3000)│
└────────┬────────┘
         │ HTTP/SSE
         │
┌────────▼─────────────────────────┐
│      Express Web Server         │
│  ┌───────────────────────────┐  │
│  │  Static File Server      │  │
│  │  (HTML/CSS/JS)           │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  API Endpoints            │  │
│  │  - GET  /api/agents       │  │
│  │  - POST /api/chat         │  │
│  │  - GET  /api/chat/stream  │  │
│  └───────────────────────────┘  │
└────────┬────────────────────────┘
         │
┌────────▼─────────────────────────┐
│    Agent Execution Layer         │
│  ┌───────────────────────────┐   │
│  │  AgentRunner.run()        │   │
│  │  (existing logic)         │   │
│  └───────────────────────────┘   │
│  ┌───────────────────────────┐   │
│  │  WebWriter                │   │
│  │  (SSE output adapter)     │   │
│  └───────────────────────────┘   │
└──────────────────────────────────┘
```

### Component Breakdown

#### 1. Web Server (`src/services/web-server.ts`)

**Purpose**: HTTP server that serves the UI and handles API requests

**Responsibilities**:

- Serve static files (HTML, CSS, JS)
- Handle API endpoints for agent operations
- Manage SSE connections for streaming responses
- Integrate with existing Effect layers

**Key Features**:

- Express.js for HTTP server (lightweight, well-supported)
- Static file serving for frontend assets
- SSE endpoint for real-time streaming
- REST API for agent management and chat

**Dependencies**:

- `express` - HTTP server framework
- `express-static` or built-in static serving
- Effect-TS integration for service layers

#### 2. Web Writer (`src/core/utils/web-writer.ts`)

**Purpose**: Adapter that sends output to web clients instead of terminal

**Responsibilities**:

- Implement `OutputWriter` interface
- Convert terminal output to SSE events
- Format output for web consumption (HTML-safe, structured)

**Design**:

```typescript
export class WebWriter implements OutputWriter {
  private readonly sendEvent: (event: string, data: string) => void;

  write(text: string): Effect.Effect<void, never>;
  writeLine(text: string): Effect.Effect<void, never>;
  clearLines(count: number): Effect.Effect<void, never>;
  flush(): Effect.Effect<void, never>;
}
```

**SSE Event Types**:

- `output` - Text output (text or line)
- `clear` - Clear previous lines
- `thinking` - Thinking indicator
- `tool_execution` - Tool execution status
- `error` - Error messages
- `metrics` - Performance metrics
- `done` - Stream completion

#### 3. UI Command Handler (`src/cli/commands/ui.ts`)

**Purpose**: CLI command that starts the web server

**Responsibilities**:

- Parse command options (port, host, agent selection)
- Initialize web server with Effect layers
- Handle graceful shutdown
- Open browser automatically (optional)

**Command Signature**:

```bash
jazz ui [options]
  --port <port>        Port to run on (default: 3000)
  --host <host>        Host to bind to (default: localhost)
  --no-open            Don't open browser automatically
  --agent <agentRef>   Pre-select an agent
```

#### 4. Frontend (`src/services/web-server/static/`)

**Purpose**: Single-page application for chat interface

**Structure**:

```
static/
├── index.html          # Main HTML page
├── css/
│   └── styles.css     # Styling
└── js/
    └── app.js         # Frontend logic
```

**Features**:

- Modern, responsive chat UI
- Real-time message streaming
- Markdown rendering for agent responses
- Tool execution indicators
- Conversation history
- Agent selection dropdown
- Special command support (visual indicators)

**Technologies**:

- Vanilla JavaScript (no build step needed)
- Marked.js for markdown rendering (already in dependencies)
- Native EventSource API for SSE
- CSS Grid/Flexbox for layout

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)

#### Step 1.1: Add Dependencies

- Add `express` to `package.json`
- Add `@types/express` to devDependencies
- Update package.json scripts if needed

#### Step 1.2: Create Web Writer

- **File**: `src/core/utils/web-writer.ts`
- Implement `OutputWriter` interface
- Convert terminal output to structured SSE events
- Handle special output types (thinking, tools, errors)

#### Step 1.3: Create Web Server Service

- **File**: `src/services/web-server.ts`
- Express server setup
- Static file serving
- Effect-TS integration
- Graceful shutdown handling

**Key Functions**:

```typescript
export function createWebServer(options: {
  port: number;
  host: string;
  openBrowser?: boolean;
}): Effect.Effect<void, Error, ...>
```

### Phase 2: API Endpoints (Week 1-2)

#### Step 2.1: Agent Management Endpoints

- `GET /api/agents` - List all agents
- `GET /api/agents/:id` - Get agent details
- Use existing `AgentService` layer

#### Step 2.2: Chat Endpoints

- `POST /api/chat` - Start chat session (non-streaming)
- `GET /api/chat/stream` - SSE endpoint for streaming chat

**Request Format**:

```json
{
  "agentId": "agent-123",
  "message": "Hello, agent!",
  "conversationId": "conv-456", // optional
  "conversationHistory": [] // optional
}
```

**SSE Response Format**:

```
event: output
data: {"type":"text","content":"Hello"}

event: thinking
data: {"active":true}

event: tool_execution
data: {"tool":"gmail_list_emails","status":"running"}

event: done
data: {"conversationId":"conv-456","messages":[...]}
```

#### Step 2.3: Integrate Agent Runner

- Wrap `AgentRunner.run()` with web writer
- Handle streaming vs non-streaming modes
- Convert Effect errors to HTTP responses
- Maintain conversation state per session

### Phase 3: Frontend Development (Week 2)

#### Step 3.1: HTML Structure

- Chat container with message history
- Input area with send button
- Agent selector dropdown
- Status indicators (thinking, tool execution)
- Special command hints

#### Step 3.2: JavaScript Logic

- EventSource connection for SSE
- Message rendering (markdown support)
- Conversation history management
- Agent selection handling
- Special command parsing and display
- Error handling and retry logic

#### Step 3.3: Styling

- Modern, clean design
- Responsive layout
- Dark/light theme support (optional)
- Syntax highlighting for code blocks
- Smooth animations for streaming

### Phase 4: Integration & Testing (Week 2-3)

#### Step 4.1: CLI Command Integration

- **File**: `src/cli/commands/ui.ts`
- Add `ui` command to main CLI program
- Handle command options
- Browser auto-open functionality

#### Step 4.2: Error Handling

- Network error recovery
- SSE reconnection logic
- Graceful degradation (fallback to polling if SSE fails)
- User-friendly error messages

#### Step 4.3: Testing

- Unit tests for web writer
- Integration tests for API endpoints
- E2E tests for chat flow
- SSE connection testing
- Error scenario testing

### Phase 5: Polish & Documentation (Week 3)

#### Step 5.1: Feature Parity

- Ensure all CLI special commands work (`/new`, `/help`, `/status`, `/tools`, `/clear`)
- Tool execution visualization
- Metrics display
- Conversation management

#### Step 5.2: Performance

- Optimize SSE event frequency
- Minimize frontend bundle size
- Lazy loading for large conversations
- Efficient markdown rendering

#### Step 5.3: Documentation

- Update main README with `jazz ui` command
- Add UI screenshots
- Document API endpoints (for future extensibility)
- Troubleshooting guide

## Technical Decisions

### Why Express.js?

- **Lightweight**: Minimal dependencies, fast startup
- **Mature**: Well-tested, extensive ecosystem
- **Simple**: Easy to integrate with Effect-TS
- **SSE Support**: Native support for streaming responses

### Why Server-Sent Events (SSE) over WebSockets?

- **Simplicity**: One-way streaming is sufficient (server → client)
- **HTTP-based**: Easier to debug, works through proxies
- **Auto-reconnect**: Built-in browser support
- **Lower overhead**: No protocol upgrade, simpler implementation

### Why Vanilla JavaScript?

- **No Build Step**: Faster development, easier deployment
- **Small Bundle**: Minimal dependencies, fast loading
- **Simplicity**: Easier to maintain, no framework overhead
- **Compatibility**: Works everywhere, no transpilation needed

### Output Rendering Strategy

**Option A: Server-Side Rendering (SSE)**

- Server renders markdown → HTML
- Send HTML chunks via SSE
- Pros: Consistent rendering, less client work
- Cons: More server processing, larger payloads

**Option B: Client-Side Rendering (SSE)**

- Server sends markdown text via SSE
- Client renders with Marked.js
- Pros: Smaller payloads, better streaming UX
- Cons: Client-side processing, potential inconsistencies

**Decision: Option B (Client-Side Rendering)**

- Better streaming experience (can render as text arrives)
- Smaller network payloads
- More flexible (can add syntax highlighting, etc.)
- Marked.js already in dependencies

## File Structure

```
src/
├── cli/
│   └── commands/
│       └── ui.ts                    # UI command handler
├── core/
│   └── utils/
│       └── web-writer.ts            # Web output writer
├── services/
│   ├── web-server.ts                # Express server
│   └── web-server/
│       └── static/                  # Frontend assets
│           ├── index.html
│           ├── css/
│           │   └── styles.css
│           └── js/
│               └── app.js
```

## API Specification

### GET /api/agents

List all available agents.

**Response**:

```json
{
  "agents": [
    {
      "id": "agent-123",
      "name": "My Agent",
      "description": "Agent description",
      "status": "active",
      "config": {
        "agentType": "default",
        "llmProvider": "openai",
        "llmModel": "gpt-4"
      }
    }
  ]
}
```

### GET /api/agents/:id

Get agent details.

**Response**:

```json
{
  "id": "agent-123",
  "name": "My Agent",
  "description": "Agent description",
  "status": "active",
  "config": { ... },
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### POST /api/chat

Start a chat session (non-streaming, for simple requests).

**Request**:

```json
{
  "agentId": "agent-123",
  "message": "Hello!",
  "conversationId": "conv-456",
  "conversationHistory": []
}
```

**Response**:

```json
{
  "conversationId": "conv-456",
  "content": "Hello! How can I help?",
  "messages": [...]
}
```

### GET /api/chat/stream

Stream chat responses via SSE.

**Query Parameters**:

- `agentId` (required) - Agent identifier
- `message` (required) - User message
- `conversationId` (optional) - Existing conversation ID
- `conversationHistory` (optional) - JSON-encoded conversation history

**SSE Events**:

- `output` - Text output chunk
- `thinking` - Thinking indicator (active/inactive)
- `tool_execution` - Tool execution status
- `error` - Error message
- `metrics` - Performance metrics
- `done` - Stream completion with final data

**Example**:

```
GET /api/chat/stream?agentId=agent-123&message=Hello

event: output
data: {"type":"text","content":"Hello"}

event: thinking
data: {"active":true}

event: output
data: {"type":"line","content":"How can I help you today?"}

event: done
data: {"conversationId":"conv-456","messages":[...]}
```

## Security Considerations

1. **Localhost Only**: By default, bind to `localhost` only (not `0.0.0.0`)
2. **No Authentication**: Since it's localhost-only, no auth needed initially
3. **Input Validation**: Validate all API inputs using Schema
4. **CORS**: Not needed for localhost, but can add if needed for future remote access
5. **Rate Limiting**: Consider rate limiting for API endpoints (future enhancement)

## Future Enhancements

### Phase 2 Features (Post-MVP)

1. **Multi-Agent Support**: Switch between agents in the same session
2. **Conversation History**: Persistent conversation storage and retrieval
3. **Export Conversations**: Download conversation history as markdown/JSON
4. **Dark Mode**: Theme toggle in UI
5. **Keyboard Shortcuts**: Power user features
6. **Agent Configuration UI**: Edit agents through the web interface
7. **Tool Approval UI**: Visual tool approval interface
8. **Metrics Dashboard**: Real-time performance metrics visualization
9. **Remote Access**: Optional authentication for remote access (SSH tunnel, etc.)
10. **Mobile Responsive**: Better mobile experience

### Advanced Features

1. **WebSocket Support**: For bidirectional communication (tool approvals, etc.)
2. **Multi-User Support**: Multiple users, shared conversations
3. **Plugin System**: Custom UI plugins/extensions
4. **Agent Marketplace**: Browse and install agents from the UI
5. **Visual Workflow Builder**: Drag-and-drop workflow creation

## Implementation Checklist

### Core Infrastructure

- [ ] Add Express.js dependency
- [ ] Create WebWriter class
- [ ] Create web server service
- [ ] Integrate with Effect layers
- [ ] Add graceful shutdown handling

### API Endpoints

- [ ] GET /api/agents
- [ ] GET /api/agents/:id
- [ ] POST /api/chat
- [ ] GET /api/chat/stream (SSE)
- [ ] Error handling middleware

### Frontend

- [ ] HTML structure
- [ ] CSS styling
- [ ] JavaScript chat logic
- [ ] SSE connection handling
- [ ] Markdown rendering
- [ ] Agent selector
- [ ] Special command support
- [ ] Error handling UI

### CLI Integration

- [ ] Add `jazz ui` command
- [ ] Command options (port, host, agent)
- [ ] Browser auto-open
- [ ] Help text and documentation

### Testing

- [ ] Unit tests for WebWriter
- [ ] API endpoint tests
- [ ] SSE streaming tests
- [ ] Frontend integration tests
- [ ] E2E chat flow tests

### Documentation

- [ ] Update main README
- [ ] Add UI screenshots
- [ ] API documentation
- [ ] Troubleshooting guide

## Success Metrics

1. **Feature Parity**: All CLI chat features work in UI
2. **Performance**: Streaming latency < 100ms
3. **Reliability**: SSE reconnection works seamlessly
4. **User Experience**: Intuitive, responsive interface
5. **Code Quality**: Maintains Jazz standards (Effect-TS, type safety, error handling)

## Timeline Estimate

- **Week 1**: Core infrastructure + API endpoints
- **Week 2**: Frontend development + integration
- **Week 3**: Testing + polish + documentation

**Total**: ~3 weeks for MVP, 4-5 weeks for polished release

## Open Questions

1. **Port Configuration**: Should port be configurable via config file or CLI only?
2. **Browser Auto-Open**: Should this be default or opt-in?
3. **Static File Location**: Bundle in dist/ or serve from src/?
4. **SSE vs WebSocket**: Start with SSE, but should we plan for WebSocket migration?
5. **Authentication**: When/if we add remote access, what auth mechanism?
6. **Conversation Persistence**: Should conversations persist across server restarts?

## References

- [Express.js Documentation](https://expressjs.com/)
- [Server-Sent Events (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Marked.js Documentation](https://marked.js.org/)
- [Effect-TS Documentation](https://effect.website/)
