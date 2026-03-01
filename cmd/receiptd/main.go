package main

import (
	"bufio"
	"os"
	"strings"

	"github.com/ChaseBro/receiptd/internal/cli"
)

// loadDotEnv reads KEY=VALUE pairs from a .env file in the current working
// directory and sets them in the process environment. Existing env vars are
// never overwritten, so explicit exports always win. If the file does not
// exist the function returns silently.
func loadDotEnv() {
	f, err := os.Open(".env")
	if err != nil {
		return // not present — silently skip
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// skip blank lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 1 {
			continue // no '=' or key is empty
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		// strip optional surrounding quotes from value
		if len(val) >= 2 &&
			((val[0] == '"' && val[len(val)-1] == '"') ||
				(val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		// only set if not already present in the environment
		if os.Getenv(key) == "" {
			os.Setenv(key, val) //nolint:errcheck
		}
	}
}

func main() {
	loadDotEnv()
	if err := cli.Execute(); err != nil {
		os.Exit(1)
	}
}
