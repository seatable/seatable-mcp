#!/bin/bash

# MCP SeaTable Worker Local Test Suite
# Tests both SSE and Streamable HTTP transports

set -e

WORKER_URL="https://mcp-seatable.brian-money.workers.dev"
TEST_SESSION=""
MESSAGE_ENDPOINT=""

echo "🧪 MCP SeaTable Worker Test Suite"
echo "=================================="
echo

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Test 1: Health Check
test_health() {
    print_status "Testing health endpoint..."
    
    response=$(curl -s -w "HTTPSTATUS:%{http_code}" "$WORKER_URL/health")
    http_code=$(echo $response | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    
    if [ "$http_code" -eq 200 ]; then
        print_success "Health check passed (HTTP $http_code)"
    else
        print_error "Health check failed (HTTP $http_code)"
        return 1
    fi
}

# Test 2: SSE Endpoint Connection
test_sse_connection() {
    print_status "Testing SSE endpoint connection..."
    
    # Get SSE endpoint and extract session info
    sse_response=$(timeout 5 curl -s -H "Accept: text/event-stream" "$WORKER_URL/sse" || true)
    
    if echo "$sse_response" | grep -q "event: endpoint"; then
        MESSAGE_ENDPOINT=$(echo "$sse_response" | grep "data:" | head -1 | cut -d' ' -f2)
        TEST_SESSION=$(echo "$MESSAGE_ENDPOINT" | grep -o 'sessionId=[^&]*' | cut -d'=' -f2)
        
        print_success "SSE connection established"
        print_status "Message endpoint: $MESSAGE_ENDPOINT"
        print_status "Session ID: $TEST_SESSION"
    else
        print_error "Failed to establish SSE connection"
        echo "Response: $sse_response"
        return 1
    fi
}

# Test 3: MCP Initialize
test_initialize() {
    print_status "Testing MCP initialize..."
    
    if [ -z "$MESSAGE_ENDPOINT" ]; then
        print_error "No message endpoint available"
        return 1
    fi
    
    response=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d '{
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-25",
                "capabilities": {
                    "roots": {"listChanged": false},
                    "sampling": {}
                }
            },
            "id": 1
        }' \
        "$WORKER_URL$MESSAGE_ENDPOINT")
    
    http_code=$(echo $response | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    
    if [ "$http_code" -eq 202 ]; then
        print_success "Initialize request accepted (HTTP $http_code)"
    else
        print_error "Initialize failed (HTTP $http_code)"
        echo "Response: $response"
        return 1
    fi
}

# Test 4: Tools List
test_tools_list() {
    print_status "Testing tools/list..."
    
    response=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d '{
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {},
            "id": 2
        }' \
        "$WORKER_URL$MESSAGE_ENDPOINT")
    
    http_code=$(echo $response | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    
    if [ "$http_code" -eq 202 ]; then
        print_success "Tools list request accepted (HTTP $http_code)"
    else
        print_error "Tools list failed (HTTP $http_code)"
        echo "Response: $response"
        return 1
    fi
}

# Test 5: Ping Tool
test_ping_tool() {
    print_status "Testing ping_seatable tool..."
    
    response=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d '{
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "ping_seatable",
                "arguments": {}
            },
            "id": 3
        }' \
        "$WORKER_URL$MESSAGE_ENDPOINT")
    
    http_code=$(echo $response | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    
    if [ "$http_code" -eq 202 ]; then
        print_success "Ping tool request accepted (HTTP $http_code)"
    else
        print_error "Ping tool failed (HTTP $http_code)"
        echo "Response: $response"
        return 1
    fi
}

# Test 6: List Tables Tool
test_list_tables() {
    print_status "Testing list_tables tool..."
    
    response=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d '{
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "list_tables",
                "arguments": {}
            },
            "id": 4
        }' \
        "$WORKER_URL$MESSAGE_ENDPOINT")
    
    http_code=$(echo $response | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    
    if [ "$http_code" -eq 202 ]; then
        print_success "List tables tool request accepted (HTTP $http_code)"
    else
        print_error "List tables tool failed (HTTP $http_code)"
        echo "Response: $response"
        return 1
    fi
}

# Test 7: Streamable HTTP Transport (Basic)
test_streamable_http() {
    print_status "Testing Streamable HTTP transport..."
    
    # Test with missing session ID (should fail appropriately)
    response=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -d '{
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-25",
                "capabilities": {
                    "roots": {"listChanged": false},
                    "sampling": {}
                }
            },
            "id": 1
        }' \
        "$WORKER_URL/mcp")
    
    http_code=$(echo $response | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    body=$(echo $response | sed -e 's/HTTPSTATUS:.*//')
    
    if [ "$http_code" -eq 400 ] && echo "$body" | grep -q "Mcp-Session-Id header is required"; then
        print_success "Streamable HTTP correctly validates session ID requirement"
    else
        print_warning "Streamable HTTP response: HTTP $http_code"
        print_warning "Body: $body"
    fi
}

# Test 8: CORS Headers
test_cors() {
    print_status "Testing CORS headers..."
    
    response=$(curl -s -I -H "Origin: http://localhost:3000" "$WORKER_URL/health")
    
    if echo "$response" | grep -qi "access-control-allow-origin"; then
        print_success "CORS headers present"
    else
        print_warning "CORS headers may be missing"
    fi
}

# Main test runner
run_tests() {
    local failed=0
    
    echo "Starting test suite..."
    echo
    
    # Core functionality tests
    test_health || ((failed++))
    echo
    
    test_sse_connection || ((failed++))
    echo
    
    test_initialize || ((failed++))
    echo
    
    test_tools_list || ((failed++))
    echo
    
    test_ping_tool || ((failed++))
    echo
    
    test_list_tables || ((failed++))
    echo
    
    # Transport tests
    test_streamable_http || ((failed++))
    echo
    
    test_cors || ((failed++))
    echo
    
    # Summary
    echo "=================================="
    if [ $failed -eq 0 ]; then
        print_success "All tests passed! 🎉"
        echo
        print_status "Your MCP Worker is ready for use!"
        echo
        print_status "Next steps:"
        echo "  1. Test with VS Code MCP extension"
        echo "  2. Test with MCP Inspector"
        echo "  3. Test with Claude Desktop via mcp-remote"
    else
        print_error "$failed test(s) failed ❌"
        echo
        print_status "Check the errors above and redeploy if needed"
    fi
    
    return $failed
}

# Interactive mode
interactive_mode() {
    while true; do
        echo
        echo "🔧 Interactive Test Menu"
        echo "======================="
        echo "1. Run full test suite"
        echo "2. Test health endpoint"
        echo "3. Test SSE connection" 
        echo "4. Test specific tool"
        echo "5. Show current session info"
        echo "6. Test with live SSE monitoring"
        echo "7. Exit"
        echo
        read -p "Choose option (1-7): " choice
        
        case $choice in
            1) run_tests ;;
            2) test_health ;;
            3) test_sse_connection ;;
            4) 
                echo "Available tools: ping_seatable, list_tables, get_schema, list_rows, etc."
                read -p "Enter tool name: " tool_name
                if [ -n "$MESSAGE_ENDPOINT" ]; then
                    curl -s -X POST -H "Content-Type: application/json" \
                        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"$tool_name\",\"arguments\":{}},\"id\":99}" \
                        "$WORKER_URL$MESSAGE_ENDPOINT"
                    echo
                else
                    print_error "No active session. Run option 3 first."
                fi
                ;;
            5)
                if [ -n "$TEST_SESSION" ]; then
                    echo "Session ID: $TEST_SESSION"
                    echo "Message Endpoint: $MESSAGE_ENDPOINT"
                else
                    print_warning "No active session"
                fi
                ;;
            6)
                if command -v code >/dev/null 2>&1; then
                    print_status "Opening VS Code with MCP configuration..."
                    code .vscode/mcp.json
                else
                    print_warning "VS Code not found. Manual setup required."
                fi
                ;;
            7) 
                echo "Goodbye!"
                exit 0
                ;;
            *)
                print_error "Invalid option"
                ;;
        esac
    done
}

# Parse command line arguments
case "${1:-}" in
    --interactive|-i)
        interactive_mode
        ;;
    --help|-h)
        echo "Usage: $0 [--interactive|--help]"
        echo "  --interactive, -i    Run in interactive mode"
        echo "  --help, -h          Show this help"
        echo
        echo "Run without arguments to execute full test suite"
        ;;
    "")
        run_tests
        ;;
    *)
        echo "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1
        ;;
esac