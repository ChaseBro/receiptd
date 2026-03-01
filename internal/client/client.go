package client

import (
	"encoding/json"
	"fmt"
	"net"
	"time"
)

// Response represents a server response
type Response struct {
	Status  string      `json:"status"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// Client communicates with the receiptd server
type Client struct {
	tcpAddress string
}

// NewClient creates a new receiptd client
func NewClient() *Client {
	return &Client{
		tcpAddress: "127.0.0.1:3099",
	}
}

// Connect establishes a connection to the receiptd server
func (c *Client) Connect() (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", c.tcpAddress, 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to server: %w", err)
	}
	return conn, nil
}

// SendCommand sends a command to the server
func (c *Client) SendCommand(cmd string, payload interface{}) (*Response, error) {
	conn, err := c.Connect()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	
	// Send command
	req := map[string]interface{}{
		"command": cmd,
		"payload": payload,
	}
	
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil, fmt.Errorf("send failed: %w", err)
	}
	
	// Read response
	var resp Response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return nil, fmt.Errorf("read failed: %w", err)
	}
	
	if resp.Error != "" {
		return &resp, fmt.Errorf("%s", resp.Error)
	}
	
	return &resp, nil
}

// Status gets server status
func (c *Client) Status() (*Response, error) {
	return c.SendCommand("status", nil)
}

// AddJob adds a print job. If staged is true the job is held in the queue and
// never dispatched to the printer.
func (c *Client) AddJob(printerID, content string, staged bool) (*Response, error) {
	return c.SendCommand("add_job", map[string]interface{}{
		"printerId": printerID,
		"content":   content,
		"staged":    staged,
	})
}

// GetJobs gets all jobs
func (c *Client) GetJobs() (*Response, error) {
	return c.SendCommand("get_jobs", nil)
}

// GetPrinters gets known printers
func (c *Client) GetPrinters() (*Response, error) {
	return c.SendCommand("get_printers", nil)
}

// IsServerRunning checks if the server is running
func (c *Client) IsServerRunning() bool {
	conn, err := net.DialTimeout("tcp", c.tcpAddress, 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}