package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/spf13/cobra"
)

var (
	chaosService   string
	chaosErrorRate float64
	chaosLatencyMs int
	chaosBaseURL   string
)

var chaosCmd = &cobra.Command{
	Use:   "chaos",
	Short: "Inject runtime faults into a service via its chaos endpoint",
	Long: `Calls the chaos injection endpoint on a service to set error rate or
artificial latency. Currently only users-service exposes a chaos endpoint.

Examples:
  observashop-cli chaos --service users --error-rate 0.5 --base-url http://localhost
  observashop-cli chaos --service users --error-rate 0          # restore
  observashop-cli chaos --service users --latency-ms 200`,
	RunE: runChaos,
}

func init() {
	rootCmd.AddCommand(chaosCmd)
	chaosCmd.Flags().StringVar(&chaosService, "service", "users", "Target service (only 'users' is supported currently)")
	chaosCmd.Flags().Float64Var(&chaosErrorRate, "error-rate", -1, "Error injection rate from 0.0 to 1.0 (omit to leave unchanged)")
	chaosCmd.Flags().IntVar(&chaosLatencyMs, "latency-ms", -1, "Artificial latency in milliseconds (omit to leave unchanged)")
	chaosCmd.Flags().StringVar(&chaosBaseURL, "base-url", "http://users-service.observashop.svc.cluster.local", "Base URL of the target service")
}

func runChaos(cmd *cobra.Command, _ []string) error {
	if chaosService != "users" {
		return fmt.Errorf("only 'users' service supports chaos injection currently")
	}
	if chaosErrorRate < 0 && chaosLatencyMs < 0 {
		return fmt.Errorf("provide at least one of --error-rate or --latency-ms")
	}

	if chaosErrorRate >= 0 {
		if err := postJSON(chaosBaseURL+"/chaos/error-rate", map[string]any{"rate": chaosErrorRate}); err != nil {
			return fmt.Errorf("set error rate: %w", err)
		}
		fmt.Printf("error rate set to %.2f\n", chaosErrorRate)
	}
	if chaosLatencyMs >= 0 {
		if err := postJSON(chaosBaseURL+"/chaos/latency", map[string]any{"ms": chaosLatencyMs}); err != nil {
			return fmt.Errorf("set latency: %w", err)
		}
		fmt.Printf("latency set to %dms\n", chaosLatencyMs)
	}
	return nil
}

func postJSON(url string, body any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
