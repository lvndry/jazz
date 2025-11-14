# Jazz TODO

## 🎯 Current Priority: Task Execution Engine

## 🚀 What's Working Right Now

### ✅ **Storage System (Complete)**

- Agents are persisted to `./.jazz/agents/` as JSON files
- Full CRUD operations working
- File-based and in-memory storage implementations
- Automatic directory creation and error handling

### ✅ **Validation System (Complete)**

- Agent name validation (alphanumeric with hyphens/underscores)
- Description validation (required, max 500 chars)
- Configuration validation (timeout, retry policies)
- Task validation using Schema

### ✅ **CLI Interface (Complete)**

- Full command structure with help system
- Error handling with user-friendly messages
- Command options for timeout, retries, backoff strategies
- Global options for verbose/quiet modes

### ✅ **Documentation (Complete)**

- Comprehensive README with installation guide
- Complete API documentation
- Architecture overview
- Usage examples and tutorials
- CLI reference with all commands

### 🔄 **What's Missing (Main Priority)**

- **Task Execution Engine**: The core functionality to actually run tasks
- **MCP Integration**: Model Context Protocol support
- **Automation System**: Scheduling and triggers

---

### Phase 1: Basic Agent Management ✅ COMPLETED

#### ✅ Completed

- [x] Project bootstrap with TypeScript + Effect
- [x] Core type definitions and interfaces
- [x] Effect layers for services (logging, config, storage)
- [x] CLI framework with Commander.js
- [x] Error handling with tagged errors
- [x] Basic CLI structure and commands
- [x] **Agent Creation CLI Command**
  - [x] Implement `jazz agent create` command
  - [x] Add agent validation using Schema
  - [x] Generate unique agent IDs
  - [x] Store agents in storage service
  - [x] Add agent description and metadata support
- [x] **Agent Storage & Persistence**
  - [x] Implement agent CRUD operations
  - [x] Add agent listing with filtering
  - [x] Agent update and deletion commands
  - [x] Agent configuration management
- [x] **Agent Validation**
  - [x] Schema validation for agent definitions
  - [x] Task configuration validation
  - [x] Basic dependency validation
  - [x] Environment variable validation

#### 🔄 In Progress

- [ ] **Task Execution Engine**
  - [x] Implement task execution framework
  - [x] Implement Gmail tool execution
  - [x] Command execution capability
  - [x] Script execution capability
  - [x] API call execution
  - [x] File operation tasks
  - [x] Result tracking and storage
  - [ ] Make reasoning tokens visible
  - [ ] Should we support the `think` tool ?

- [ ] **Context Management**
  - [ ] Reduce length of system prompt
  - [ ] Summarize previous on every step and send the summary along the message
        Conversation sent to the API is [{ role:system, message: "..."}, {"role": "system": "summary of previous messages..."}, { role: "user", message: "..."} ]
  - Explore subagent triggers

- [ ] **Ease of use**
  - [ ] Cookbooks with concrete example of agents and worfklows that can be created

### Phase 2: Task Execution Engine

#### 📋 Task Execution Core

- [ ] **Task Types Implementation**
  - [x] Command execution (shell commands)
  - [x] Script execution (JavaScript/TypeScript)
  - [x] API call execution (HTTP requests)
  - [x] File operation tasks

- [->] **Execution Context**
  - [x] Working directory management
  - [ ] Environment variable injection

- [ ] **Task Dependencies**
  - [ ] Dependency resolution algorithm
  - [ ] Task ordering and parallel execution
  - [ ] Dependency failure handling
  - [ ] Circular dependency detection

### Phase 3: MCP Integration

#### 📋 MCP (Model Context Protocol) Support

- [ ] **MCP Client Implementation**
  - [ ] MCP protocol client
  - [ ] Tool discovery and registration
  - [ ] MCP server connection management
  - [ ] Authentication and security

- [ ] **MCP Tool Integration**
  - [ ] Tool execution framework
  - [ ] Parameter validation
  - [ ] Result processing
  - [ ] Error handling for MCP calls

- [ ] **Agent-MCP Communication**
  - [ ] Agent tool access layer
  - [ ] Tool permission management
  - [ ] MCP tool result integration
  - [ ] Tool dependency management

#### 📋 MCP Tool Categories

- [ ] **File System Tools**
  - [ ] File read/write operations
  - [ ] Directory management
  - [ ] File watching and monitoring
  - [ ] Path manipulation utilities

- [ ] **Database Tools**
  - [ ] SQL query execution
  - [ ] Database connection management
  - [ ] Transaction handling
  - [ ] Schema operations

- [ ] **API Integration Tools**
  - [ ] HTTP client with authentication
  - [ ] REST API helpers
  - [ ] GraphQL support
  - [ ] Webhook management

- [ ] **AI/ML Tools**
  - [ ] LLM integration
  - [ ] Embedding generation
  - [ ] Model inference
  - [ ] Prompt management

### Phase 4: Advanced Features

#### 📋 Automation & Scheduling

- [ ] **Automation Management**
  - [ ] Automation creation and configuration
  - [ ] Trigger system (schedule, file, webhook, manual)
  - [ ] Automation execution orchestration
  - [ ] Automation monitoring and logging

- [ ] **Scheduling System**
  - [ ] Cron expression support
  - [ ] Interval-based scheduling
  - [ ] One-time execution
  - [ ] Timezone handling

#### 📋 Monitoring & Observability

- [ ] **Logging & Tracing**
  - [ ] Structured logging with correlation IDs
  - [ ] Execution tracing
  - [ ] Error aggregation
  - [ ] Log filtering and search

- [ ] **Result Management**
  - [ ] Task result storage
  - [ ] Result querying and filtering
  - [ ] Result export capabilities
  - [ ] Historical data retention

#### 📋 Configuration & Security

- [x] **Configuration Management**
  - [x] Environment-based configuration
  - [x] Configuration file support (JSON/YAML/TOML)
  - [x] Configuration validation

- [ ] **Security Features**
  - [ ] Credential management
  - [ ] Access control and permissions
  - [ ] Audit logging
  - [ ] Encryption for sensitive data

### Phase 5: Developer Experience

#### 📋 CLI Enhancements

- [ ] **Interactive Commands**
  - [x] Agent creation wizard
  - [ ] Configuration setup assistant

- [ ] **Output & Formatting**
  - [x] Pretty-printed output
  - [ ] JSON/YAML export options
  - [ ] Progress indicators
  - [ ] Colored output and themes

#### 📋 Development Tools

- [ ] **Testing Framework**
  - [ ] Unit tests for core functionality
  - [ ] Integration tests for CLI commands
  - [ ] End-to-end tests for agent execution
  - [ ] Performance benchmarks

- [ ] **Documentation**
  - [x] CLI usage examples
  - [->] Agent creation guide
  - [ ] MCP integration tutorial

#### 📋 Plugin System

- [ ] **Plugin Architecture**
  - [ ] Plugin loading and management
  - [ ] Plugin API definition
  - [ ] Plugin lifecycle management
  - [ ] Plugin dependency resolution

- [ ] **Built-in Plugins**
  - [ ] Common task types
  - [ ] Popular MCP tools
  - [ ] Monitoring plugins
  - [ ] Notification plugins

## 🔗 Related Issues

- ✅ Agent creation command implementation - COMPLETED
- ✅ Storage layer - COMPLETED
- ✅ CLI user experience improvements - COMPLETED
- 🔄 Task execution engine design - IN PROGRESS
- 📋 MCP protocol integration - PLANNED

### Ideas not in roadmap yet

- Being able to create agents from config file `jazz agent create --config agent.json`
- Right authentification info are stored and shared by all agents. But maybe we'd like to have one auth per agent. For example one agent connected to gmail account 1 and an other for gmail account 2 ?
- Might want to load the configuration from a .mjs instead of a .json
- Might want to seperate config from secrets
- MEMORY -> keep memory about my workflow preferences, favorite folders, ...

### Gmail Enhancement Ideas

- **Attachment Support** (you have the interface but not implemented)
- **createReplyToEmailTool** - Reply to specific email with thread context
- **createForwardEmailTool** - Forward email to new recipients
- **Advanced Search with Date Ranges** - Structured date filters for email search
- **Calendar Integration** (if you add Google Calendar) - Parse email for meeting details and create calendar events

### Use Cases/Workflows/Ideas I'ld like to see

- Read the diff code, create the commit message, commit and push
- Summarize my emails with `newsletter` label and then delete them
- Download an image from the internet to my destination folder
- Given a URL to a github repo, clone the repo and follow the setup instructions from the repo and setup everything for me

---

## 🎯 Code Quality Improvements

### 🚀 **Immediate Improvements (Next 1-2 weeks)**

#### **Testing Infrastructure**

- [ ] **Basic Test Suite Setup**
  - [ ] Add Effect.test framework integration
  - [ ] Create test utilities and helpers
  - [ ] Set up test configuration and scripts
  - [ ] Add test coverage reporting
- [ ] **Core Functionality Tests**
  - [ ] Unit tests for agent service operations
  - [ ] Storage service tests (file and in-memory)
  - [ ] Configuration service tests
  - [ ] CLI command tests
- [ ] **Integration Tests**
  - [ ] End-to-end agent creation and execution
  - [ ] Gmail tool integration tests
  - [ ] Error handling and recovery tests
  - [ ] Performance and timeout tests

#### **Security Enhancements**

- [ ] **Input Validation & Sanitization**
  - [ ] File path sanitization for security
  - [ ] Command injection prevention
  - [ ] Input length and format validation
  - [ ] Malicious input detection
- [ ] **Security Hardening**
  - [ ] Rate limiting for external API calls
  - [ ] Secure credential storage
  - [ ] Access control and permissions
  - [ ] Audit logging for security events

### 📈 **Short-term Improvements (Next month)**

#### **Performance & Monitoring**

- [ ] **Performance Monitoring**
  - [ ] Add execution time tracking for all operations
  - [ ] Implement performance metrics collection
  - [ ] Add memory usage monitoring
  - [ ] Create performance dashboards
- [ ] **Resource Management**
  - [ ] Implement proper resource cleanup patterns
  - [ ] Add connection pooling for external services
  - [ ] Implement resource limits and quotas
  - [ ] Add graceful shutdown handling
- [ ] **Caching Layer**
  - [ ] Add intelligent caching for expensive operations
  - [ ] Implement cache invalidation strategies
  - [ ] Add cache performance monitoring
  - [ ] Support for distributed caching

#### **Developer Experience**

- [ ] **Enhanced CLI Features**
  - [x] Interactive agent creation wizard
  - [ ] Configuration setup assistant
  - [ ] Command completion and suggestions
  - [ ] Progress indicators for long operations
- [ ] **Better Error Handling**
  - [ ] Interactive error recovery suggestions
  - [ ] Detailed error reporting with stack traces
  - [ ] Error categorization and filtering
  - [ ] User-friendly error messages

#### **Code Quality & Architecture**

- [ ] **Performance Optimizations**
  - [ ] Lazy evaluation for expensive operations
  - [ ] Parallel processing where possible
  - [ ] Memory usage optimization
  - [ ] Database query optimization
- [ ] **Code Organization**
  - [ ] Refactor large functions into smaller, focused ones
  - [ ] Improve separation of concerns
  - [ ] Add more abstraction layers where needed
  - [ ] Implement design patterns consistently

### 🏗️ **Medium-term Improvements (Next quarter)**

#### **Advanced Features**

- [ ] **Plugin System Architecture**
  - [ ] Plugin loading and management framework
  - [ ] Plugin API definition and documentation
  - [ ] Plugin lifecycle management
  - [ ] Plugin dependency resolution
  - [ ] Built-in plugin examples and templates
- [ ] **Advanced Monitoring & Observability**
  - [ ] Real-time agent status dashboard
  - [ ] Distributed tracing with correlation IDs
  - [ ] Error aggregation and analysis
  - [ ] Performance trend analysis
  - [ ] Health checks and alerting
- [ ] **Configuration Management**
  - [ ] Hot configuration reload
  - [ ] Configuration validation and migration
  - [ ] Environment-specific configurations
  - [ ] Configuration templates and presets

#### **Security & Compliance**

- [ ] **Comprehensive Security Audit**
  - [ ] Security vulnerability scanning
  - [ ] Penetration testing
  - [ ] Security best practices implementation
  - [ ] Compliance with security standards
- [ ] **Advanced Security Features**
  - [ ] Multi-factor authentication support
  - [ ] Role-based access control (RBAC)
  - [ ] Encryption for sensitive data at rest
  - [ ] Secure communication protocols
  - [ ] Security event monitoring and alerting

#### **Scalability & Performance**

- [ ] **Horizontal Scaling Support**
  - [ ] Distributed agent execution
  - [ ] Load balancing for agent tasks
  - [ ] Cluster management and coordination
  - [ ] High availability and failover
- [ ] **Performance Optimization**
  - [ ] Database connection pooling
  - [ ] Query optimization and indexing
  - [ ] Caching strategies and implementation
  - [ ] Resource usage optimization
