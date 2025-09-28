#!/bin/bash

# MCP SeaTable Local Development Environment Setup
# Sets up everything needed for local testing and development

set -e

echo "🚀 Setting up MCP SeaTable Local Test Environment"
echo "================================================="
echo

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() {
    echo -e "${BLUE}[SETUP]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[DONE]${NC} $1"
}

print_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check Node.js
    if ! command -v node >/dev/null 2>&1; then
        echo "❌ Node.js is required but not installed"
        exit 1
    fi
    
    # Check npm
    if ! command -v npm >/dev/null 2>&1; then
        echo "❌ npm is required but not installed"
        exit 1
    fi
    
    print_success "Prerequisites check passed"
}

# Install development dependencies
install_dev_deps() {
    print_status "Installing development dependencies..."
    
    # Install MCP Inspector globally if not already installed
    if ! npm list -g @modelcontextprotocol/inspector >/dev/null 2>&1; then
        print_status "Installing MCP Inspector globally..."
        npm install -g @modelcontextprotocol/inspector
    fi
    
    # Install mcp-remote for IDE integration
    if ! npm list -g mcp-remote >/dev/null 2>&1; then
        print_status "Installing mcp-remote globally..."
        npm install -g mcp-remote
    fi
    
    print_success "Development dependencies installed"
}

# Create VS Code workspace configuration
setup_vscode_config() {
    print_status "Setting up VS Code configuration..."
    
    mkdir -p .vscode
    
    # Create VS Code settings for MCP development
    cat > .vscode/settings.json << 'EOF'
{
    "mcp.servers": {
        "seatable-local": {
            "command": "node",
            "args": ["dist/index.js"],
            "cwd": "${workspaceFolder}",
            "env": {}
        },
        "seatable-worker-sse": {
            "url": "https://mcp-seatable.brian-money.workers.dev/sse",
            "type": "http"
        },
        "seatable-worker-remote": {
            "command": "npx",
            "args": ["mcp-remote", "https://mcp-seatable.brian-money.workers.dev/sse"]
        }
    },
    "typescript.preferences.includePackageJsonAutoImports": "on"
}
EOF
    
    # Create launch configuration for debugging
    cat > .vscode/launch.json << 'EOF'
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Debug MCP Server (Local)",
            "type": "node",
            "request": "launch",
            "program": "${workspaceFolder}/dist/index.js",
            "env": {
                "NODE_ENV": "development",
                "LOG_LEVEL": "debug"
            },
            "console": "integratedTerminal",
            "sourceMaps": true,
            "outFiles": ["${workspaceFolder}/dist/**/*.js"]
        },
        {
            "name": "Debug Worker (Local)",
            "type": "node",
            "request": "launch",
            "program": "${workspaceFolder}/node_modules/wrangler/bin/wrangler.js",
            "args": ["dev", "src/cloudflare/worker.ts", "--local"],
            "cwd": "${workspaceFolder}",
            "env": {
                "NODE_ENV": "development"
            },
            "console": "integratedTerminal"
        }
    ]
}
EOF
    
    print_success "VS Code configuration created"
}

# Create test configuration files
setup_test_configs() {
    print_status "Creating test configuration files..."
    
    # Create environment template
    if [ ! -f .env.test ]; then
        cat > .env.test << 'EOF'
# Test Environment Configuration
# Copy to .env and fill in your values

# SeaTable Configuration
SEATABLE_SERVER_URL=https://cloud.seatable.io
SEATABLE_API_TOKEN=your_api_token_here
SEATABLE_BASE_UUID=your_base_uuid_here
SEATABLE_TABLE_NAME=your_table_name_here

# Development Settings
LOG_LEVEL=debug
SEATABLE_MOCK=false
HTTP_TIMEOUT_MS=30000

# Optional: Mock mode for testing without SeaTable
# SEATABLE_MOCK=true
EOF
    fi
    
    # Create MCP Inspector config
    cat > .mcp-inspector.json << 'EOF'
{
    "servers": [
        {
            "name": "SeaTable Worker (SSE)",
            "url": "https://mcp-seatable.brian-money.workers.dev/sse",
            "type": "sse"
        },
        {
            "name": "SeaTable Worker (HTTP)",
            "url": "https://mcp-seatable.brian-money.workers.dev/mcp",
            "type": "http"
        },
        {
            "name": "SeaTable Local CLI",
            "command": "node",
            "args": ["dist/index.js"],
            "cwd": ".",
            "type": "stdio"
        }
    ]
}
EOF
    
    print_success "Test configuration files created"
}

# Create convenient npm scripts
setup_npm_scripts() {
    print_status "Adding convenient npm scripts..."
    
    # Add test and development scripts to package.json
    node -e "
        const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
        pkg.scripts = pkg.scripts || {};
        
        // Add testing scripts
        pkg.scripts['test:worker'] = './scripts/test-worker.sh';
        pkg.scripts['test:worker:interactive'] = './scripts/test-worker.sh --interactive';
        pkg.scripts['test:inspector'] = 'mcp-inspector';
        pkg.scripts['test:local'] = 'npm run build && node dist/index.js';
        
        // Add development scripts  
        pkg.scripts['dev:worker'] = 'wrangler dev src/cloudflare/worker.ts --local';
        pkg.scripts['dev:remote'] = 'mcp-remote https://mcp-seatable.brian-money.workers.dev/sse';
        
        // Add deployment scripts
        pkg.scripts['deploy:staging'] = 'wrangler deploy --env staging';
        pkg.scripts['deploy:prod'] = 'wrangler deploy --env production';
        
        require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
        console.log('Added npm scripts to package.json');
    "
    
    print_success "npm scripts added"
}

# Create documentation
create_docs() {
    print_status "Creating testing documentation..."
    
    cat > TESTING.md << 'EOF'
# MCP SeaTable Testing Guide

This guide covers how to test the MCP SeaTable implementation in various environments.

## Quick Start

```bash
# Run full test suite
npm run test:worker

# Interactive testing
npm run test:worker:interactive

# Start MCP Inspector
npm run test:inspector

# Test local CLI version
npm run test:local
```

## Test Environments

### 1. Cloudflare Worker (Production)
- **SSE Endpoint**: https://mcp-seatable.brian-money.workers.dev/sse
- **HTTP Endpoint**: https://mcp-seatable.brian-money.workers.dev/mcp
- **Health Check**: https://mcp-seatable.brian-money.workers.dev/health

### 2. Local Development
- Build and run: `npm run build && npm start`
- Debug mode: Use VS Code launch configuration
- Mock mode: Set `SEATABLE_MOCK=true` in `.env`

### 3. VS Code Integration
- Configuration in `.vscode/mcp.json`
- Multiple server options:
  - `seatable-worker-sse`: Direct worker connection
  - `seatable-worker-remote`: Via mcp-remote bridge
  - `seatable-local`: Local CLI version

## Testing Tools

### 1. Automated Test Script
```bash
./scripts/test-worker.sh              # Full test suite
./scripts/test-worker.sh --interactive # Interactive mode
```

### 2. MCP Inspector
```bash
npx @modelcontextprotocol/inspector@latest
# Then connect to: https://mcp-seatable.brian-money.workers.dev/sse
```

### 3. Manual curl Testing
```bash
# Get SSE endpoint
curl -H "Accept: text/event-stream" "https://mcp-seatable.brian-money.workers.dev/sse"

# Test initialize (replace sessionId)
curl -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}' \
  "https://mcp-seatable.brian-money.workers.dev/sse/message?sessionId=YOUR_SESSION_ID"
```

### 4. Claude Desktop Integration
```bash
# Install mcp-remote if not already installed
npm install -g mcp-remote

# Test connection
npx mcp-remote https://mcp-seatable.brian-money.workers.dev/sse
```

## Available Tools

The MCP server provides these tools:
- `ping_seatable` - Health check
- `list_tables` - List all tables
- `get_schema` - Get base schema
- `list_rows` - List rows with pagination
- `get_row` - Get specific row
- `add_row` - Add new row
- `update_row` - Update existing row
- `delete_row` - Delete row
- And 10+ more...

## Troubleshooting

### Common Issues

1. **"Session not found" errors**
   - This was the old issue, should be resolved with MCP Agent pattern
   - If still occurring, check Worker logs: `wrangler tail`

2. **Connection timeouts**
   - Check network connectivity
   - Verify Worker is deployed: `curl https://mcp-seatable.brian-money.workers.dev/health`

3. **Tool execution failures**
   - Check SeaTable credentials are set in Worker secrets
   - Verify base UUID and API token are valid
   - Check logs for specific error messages

4. **VS Code MCP extension issues**
   - Ensure latest extension version
   - Check `.vscode/mcp.json` configuration
   - Try connecting via mcp-remote instead

### Getting Help

1. Check Worker logs: `wrangler tail`
2. Test with diagnostic page: https://mcp-seatable.brian-money.workers.dev/
3. Run automated tests: `npm run test:worker`
4. Use MCP Inspector for detailed debugging
EOF
    
    print_success "Testing documentation created"
}

# Main setup function
main() {
    check_prerequisites
    echo
    
    install_dev_deps
    echo
    
    setup_vscode_config
    echo
    
    setup_test_configs
    echo
    
    setup_npm_scripts
    echo
    
    create_docs
    echo
    
    print_success "🎉 Local test environment setup complete!"
    echo
    print_info "Next steps:"
    echo "  1. Copy .env.test to .env and configure your SeaTable credentials"
    echo "  2. Run the test suite: npm run test:worker"
    echo "  3. Try interactive testing: npm run test:worker:interactive"
    echo "  4. Open MCP Inspector: npm run test:inspector"
    echo "  5. Test in VS Code with the MCP extension"
    echo
    print_info "Documentation:"
    echo "  • See TESTING.md for detailed testing instructions"
    echo "  • Check .vscode/ folder for VS Code configurations"
    echo "  • Use scripts/test-worker.sh for automated testing"
}

main "$@"