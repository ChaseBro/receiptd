package db

import (
	"database/sql"
	"fmt"
	"time"
)

// Printer represents a CloudPRNT printer and the info captured from its polls.
type Printer struct {
	ID             string
	MACAddress     string
	IPAddress      string
	ClientType     string
	ClientVersion  string
	DotWidth       int
	PrintWidth     int
	HorizontalRes  float64
	LastStatusCode string
	LastSeenAt     time.Time
	RegisteredAt   time.Time
}

// UpsertPrinter inserts or updates a printer record.
// RegisteredAt is preserved on updates (set only on first insert).
func (d *DB) UpsertPrinter(p *Printer) error {
	_, err := d.Exec(`
		INSERT INTO printers
		    (id, mac_address, ip_address, client_type, client_version,
		     dot_width, print_width, horizontal_res, last_status_code,
		     last_seen_at, registered_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		    mac_address      = excluded.mac_address,
		    ip_address       = excluded.ip_address,
		    client_type      = COALESCE(excluded.client_type, printers.client_type),
		    client_version   = COALESCE(excluded.client_version, printers.client_version),
		    dot_width        = COALESCE(NULLIF(excluded.dot_width, 0), printers.dot_width),
		    print_width      = COALESCE(NULLIF(excluded.print_width, 0), printers.print_width),
		    horizontal_res   = COALESCE(NULLIF(excluded.horizontal_res, 0), printers.horizontal_res),
		    last_status_code = excluded.last_status_code,
		    last_seen_at     = excluded.last_seen_at`,
		p.ID,
		nullString(p.MACAddress),
		nullString(p.IPAddress),
		nullString(p.ClientType),
		nullString(p.ClientVersion),
		p.DotWidth,
		p.PrintWidth,
		p.HorizontalRes,
		nullString(p.LastStatusCode),
		p.LastSeenAt.UTC().Format(time.RFC3339Nano),
		p.RegisteredAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("upsert printer %s: %w", p.ID, err)
	}
	return nil
}

// GetPrinter retrieves a printer by ID. Returns nil, nil if not found.
func (d *DB) GetPrinter(id string) (*Printer, error) {
	row := d.QueryRow(`
		SELECT id, mac_address, ip_address, client_type, client_version,
		       dot_width, print_width, horizontal_res, last_status_code,
		       last_seen_at, registered_at
		FROM printers WHERE id = ?`, id)
	p, err := scanPrinter(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return p, err
}

// GetAllPrinters returns all printers ordered by last_seen_at descending.
func (d *DB) GetAllPrinters() ([]*Printer, error) {
	rows, err := d.Query(`
		SELECT id, mac_address, ip_address, client_type, client_version,
		       dot_width, print_width, horizontal_res, last_status_code,
		       last_seen_at, registered_at
		FROM printers ORDER BY last_seen_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("get all printers: %w", err)
	}
	defer rows.Close()

	var printers []*Printer
	for rows.Next() {
		p, err := scanPrinter(rows)
		if err != nil {
			return nil, err
		}
		printers = append(printers, p)
	}
	return printers, rows.Err()
}

func scanPrinter(row rowScanner) (*Printer, error) {
	var p Printer
	var macAddr, ipAddr, clientType, clientVersion, lastStatusCode sql.NullString
	var lastSeenAt, registeredAt string

	err := row.Scan(
		&p.ID, &macAddr, &ipAddr, &clientType, &clientVersion,
		&p.DotWidth, &p.PrintWidth, &p.HorizontalRes, &lastStatusCode,
		&lastSeenAt, &registeredAt,
	)
	if err != nil {
		return nil, err
	}
	p.MACAddress = macAddr.String
	p.IPAddress = ipAddr.String
	p.ClientType = clientType.String
	p.ClientVersion = clientVersion.String
	p.LastStatusCode = lastStatusCode.String

	if t, err := time.Parse(time.RFC3339Nano, lastSeenAt); err == nil {
		p.LastSeenAt = t
	}
	if t, err := time.Parse(time.RFC3339Nano, registeredAt); err == nil {
		p.RegisteredAt = t
	}
	return &p, nil
}
