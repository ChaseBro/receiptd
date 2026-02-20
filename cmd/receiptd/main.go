package main

import (
	"os"

	"github.com/ChaseBro/receiptd/internal/cli"
)

func main() {
	if err := cli.Execute(); err != nil {
		os.Exit(1)
	}
}
