package cmd

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/spf13/cobra"
)

type service struct {
	name string
	url  string
}

type healthResult struct {
	service string
	ok      bool
	status  int
	latency time.Duration
	err     error
}

var (
	healthBaseURL string
	healthTimeout time.Duration
)

var healthCmd = &cobra.Command{
	Use:   "health",
	Short: "Check the /healthz endpoint of all ObservaShop services",
	Long: `Pings the /healthz endpoint on every ObservaShop service in parallel and prints
the result with latency. Exit code is non-zero if any service is unhealthy.

By default, services are accessed at their in-cluster DNS names, so this should
be run from inside the cluster (e.g. via 'kubectl run --rm -it ...').
Use --base-url to override for local port-forward testing:

    observashop-cli health --base-url http://localhost`,
	RunE: runHealth,
}

func init() {
	rootCmd.AddCommand(healthCmd)
	healthCmd.Flags().StringVar(&healthBaseURL, "base-url", "", "Override base URL prefix (e.g. http://localhost when port-forwarding). Each service is then accessed at <base-url>:<port>")
	healthCmd.Flags().DurationVar(&healthTimeout, "timeout", 3*time.Second, "Per-request timeout")
}

func defaultServices() []service {
	return []service{
		{name: "users-service", url: "http://users-service.observashop.svc.cluster.local/healthz"},
		{name: "products-service", url: "http://products-service.observashop.svc.cluster.local/healthz"},
		{name: "orders-service", url: "http://orders-service.observashop.svc.cluster.local/healthz"},
	}
}

func portForwardServices() []service {
	// When using --base-url, assume each service is mapped to a different local port.
	// User is responsible for setting up the port-forwards before running.
	return []service{
		{name: "users-service", url: healthBaseURL + ":8001/healthz"},
		{name: "products-service", url: healthBaseURL + ":8002/healthz"},
		{name: "orders-service", url: healthBaseURL + ":8003/healthz"},
	}
}

func runHealth(cmd *cobra.Command, _ []string) error {
	var services []service
	if healthBaseURL != "" {
		services = portForwardServices()
	} else {
		services = defaultServices()
	}

	results := make([]healthResult, len(services))
	var wg sync.WaitGroup

	client := &http.Client{Timeout: healthTimeout}

	for i, svc := range services {
		wg.Add(1)
		go func(idx int, s service) {
			defer wg.Done()
			results[idx] = checkOne(client, s)
		}(i, svc)
	}
	wg.Wait()

	allOk := true
	fmt.Printf("%-20s  %-8s  %-10s  %s\n", "SERVICE", "STATUS", "LATENCY", "DETAIL")
	fmt.Println("--------------------------------------------------------------------")
	for _, r := range results {
		statusText := "OK"
		detail := fmt.Sprintf("HTTP %d", r.status)
		if !r.ok {
			statusText = "FAIL"
			allOk = false
			if r.err != nil {
				detail = r.err.Error()
			}
		}
		fmt.Printf("%-20s  %-8s  %-10s  %s\n",
			r.service, statusText, r.latency.Round(time.Millisecond), detail)
	}

	if !allOk {
		return fmt.Errorf("one or more services are unhealthy")
	}
	return nil
}

func checkOne(client *http.Client, s service) healthResult {
	ctx, cancel := context.WithTimeout(context.Background(), healthTimeout)
	defer cancel()

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return healthResult{service: s.name, ok: false, latency: time.Since(start), err: err}
	}
	resp, err := client.Do(req)
	latency := time.Since(start)
	if err != nil {
		return healthResult{service: s.name, ok: false, latency: latency, err: err}
	}
	defer resp.Body.Close()
	return healthResult{
		service: s.name,
		ok:      resp.StatusCode == http.StatusOK,
		status:  resp.StatusCode,
		latency: latency,
	}
}
