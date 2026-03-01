package db

import (
	"database/sql"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// DB wraps database/sql with receiptd-specific helpers.
type DB struct {
	*sql.DB
}

// Open opens (or creates) the receiptd SQLite database in dataDir.
func Open(dataDir string) (*DB, error) {
	path := filepath.Join(dataDir, "receiptd.db")
	sqldb, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	// SQLite best-practice pragmas
	if _, err := sqldb.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`); err != nil {
		sqldb.Close()
		return nil, fmt.Errorf("set pragmas: %w", err)
	}

	db := &DB{sqldb}
	if err := db.initSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return db, nil
}

const schema = `
CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    printer_id       TEXT,
    content          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    staged           INTEGER NOT NULL DEFAULT 0,
    error_msg        TEXT,
    created_at       TEXT NOT NULL,
    started_at       TEXT,
    completed_at     TEXT,
    acknowledged_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_printer  ON jobs(printer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created  ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS printers (
    id               TEXT PRIMARY KEY,
    mac_address      TEXT,
    ip_address       TEXT,
    client_type      TEXT,
    client_version   TEXT,
    dot_width        INTEGER,
    print_width      INTEGER,
    horizontal_res   REAL,
    last_status_code TEXT,
    last_seen_at     TEXT NOT NULL,
    registered_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_printers_mac ON printers(mac_address);
`

func (d *DB) initSchema() error {
	_, err := d.Exec(schema)
	return err
}
