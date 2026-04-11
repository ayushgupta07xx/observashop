package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var (
	sloPromURL string
)

var sloCmd = &cobra.Command{
	Use:   "slo-status",
	Short: "Show current state of SLO burn-rate alerts in Prometheus",
	Long: `Queries the Prometheus alerts API and prints the state of every alert
whose label 'slo' is set. Useful for a quick at-a-glance view of error budget
health across the platform.

Run with --prom-url http://localhost:9090 if you have a port-forward to Prometheus.`,
	RunE: runSLO,
}

func init() {
	rootCmd.AddCommand(sloCmd)
	sloCmd.Flags().StringVar(&sloPromURL, "prom-url", "http://kps-prometheus.monitoring.svc.cluster.local:9090", "Prometheus base URL")
}

type promAlertsResponse struct {
	Status string `json:"status"`
	Data   struct {
		Alerts []promAlert `json:"alerts"`
	} `json:"data"`
}

type promAlert struct {
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	State       string            `json:"state"`
	ActiveAt    time.Time         `json:"activeAt"`
	Value       string            `json:"value"`
}

func runSLO(cmd *cobra.Command, _ []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := strings.TrimRight(sloPromURL, "/") + "/api/v1/alerts"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("query Prometheus: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Prometheus returned HTTP %d", resp.StatusCode)
	}

	var body promAlertsResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	// Filter to alerts that have an "slo" label set
	sloAlerts := make([]promAlert, 0, len(body.Data.Alerts))
	for _, a := range body.Data.Alerts {
		if _, ok := a.Labels["slo"]; ok {
			sloAlerts = append(sloAlerts, a)
		}
	}

	if len(sloAlerts) == 0 {
		fmt.Println("no SLO alerts active (all error budgets healthy ✅)")
		return nil
	}

	// Sort by alertname for stable output
	sort.Slice(sloAlerts, func(i, j int) bool {
		return sloAlerts[i].Labels["alertname"] < sloAlerts[j].Labels["alertname"]
	})

	fmt.Printf("%-40s  %-10s  %-10s  %s\n", "ALERT", "STATE", "SEVERITY", "AGE")
	fmt.Println("------------------------------------------------------------------------------------")
	for _, a := range sloAlerts {
		age := time.Since(a.ActiveAt).Round(time.Second)
		fmt.Printf("%-40s  %-10s  %-10s  %s\n",
			a.Labels["alertname"],
			a.State,
			a.Labels["severity"],
			age,
		)
	}
	return nil
}
