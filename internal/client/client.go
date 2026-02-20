package client

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// Client communicates with the receiptd server
type Client struct {
	socketPath string
	tcpAddress string
}

// NewClient creates a new receiptd client
func NewClient() *Client {
	home, _ := os.UserHomeDir()
	socketPath := filepath.Join(home, ".receiptd", "receiptd.sock")
	
	return &Client{
		socketPath: socketPath,
		tcpAddress: "127.0.0.1:3099",
	}
}

// Connect establishes a connection to the receiptd server
func (c *Client) Connect() (net.Conn, error) {
	// TODO: Implement connection logic
	// 1. Try Unix socket first (preferred)
	// 2. Fall back to TCP if socket unavailable
	// 3. Return appropriate error messages
	
	// Stub implementation
	return nil, fmt.Errorf("client not implemented - using stubs")
}

// Send sends a command to the server and returns the response
func (c *Client) Send(command string, payload interface{}) (interface{}, error) {
	// TODO: Implement protocol
	// 1. Establish connection
	// 2. Send command with JSON payload
	// 3. Receive and parse response
	// 4. Handle errors appropriately
	
	return nil, fmt.Errorf("client not implemented - using stubs")
}

// IsServerRunning checks if the server is running
func (c *Client) IsServerRunning() bool {
	// TODO: Implement health check
	// - Try to connect to socket/TCP
	// - Send ping command
	// - Return true if successful
	
	return false
}
