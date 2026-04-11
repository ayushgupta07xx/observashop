package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var (
	// Set at build time via -ldflags
	version = "dev"
	commit  = "none"
)

var rootCmd = &cobra.Command{
	Use:           "observashop-cli",
	Short:         "Operator CLI for the ObservaShop platform",
	Long:          `observashop-cli is a small operator tool for inspecting and exercising the ObservaShop microservice platform — checking service health, injecting faults, listing pods, and reading SLO state.`,
	SilenceUsage:  true,
	SilenceErrors: true,
	Version:       fmt.Sprintf("%s (commit %s)", version, commit),
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
