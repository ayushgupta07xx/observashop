package cmd

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var (
	podsNamespace string
)

var podsCmd = &cobra.Command{
	Use:   "pods",
	Short: "List pods in the observashop namespace using the Kubernetes API",
	Long: `Lists pods in the observashop namespace (or another namespace via --namespace)
using client-go. Auto-detects in-cluster vs out-of-cluster mode:

  - When running inside a pod: uses the in-cluster service account
  - When running locally: uses ~/.kube/config (or $KUBECONFIG)`,
	RunE: runPods,
}

func init() {
	rootCmd.AddCommand(podsCmd)
	podsCmd.Flags().StringVarP(&podsNamespace, "namespace", "n", "observashop", "Namespace to list pods from")
}

func runPods(cmd *cobra.Command, _ []string) error {
	clientset, err := buildKubeClient()
	if err != nil {
		return fmt.Errorf("build kube client: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pods, err := clientset.CoreV1().Pods(podsNamespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list pods: %w", err)
	}

	if len(pods.Items) == 0 {
		fmt.Printf("no pods in namespace %q\n", podsNamespace)
		return nil
	}

	fmt.Printf("%-45s  %-10s  %-10s  %-10s  %s\n", "NAME", "READY", "STATUS", "RESTARTS", "AGE")
	fmt.Println("-------------------------------------------------------------------------------------------")
	for _, p := range pods.Items {
		ready, total := 0, len(p.Status.ContainerStatuses)
		restarts := int32(0)
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Ready {
				ready++
			}
			restarts += cs.RestartCount
		}
		age := time.Since(p.CreationTimestamp.Time).Round(time.Second)
		fmt.Printf("%-45s  %-10s  %-10s  %-10d  %s\n",
			p.Name,
			fmt.Sprintf("%d/%d", ready, total),
			string(p.Status.Phase),
			restarts,
			age,
		)
	}
	return nil
}

// buildKubeClient first tries in-cluster config (when running as a pod),
// then falls back to KUBECONFIG / ~/.kube/config (when running locally).
func buildKubeClient() (*kubernetes.Clientset, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return kubernetes.NewForConfig(cfg)
	}

	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		kubeconfig = filepath.Join(home, ".kube", "config")
	}

	cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return nil, err
	}
	return kubernetes.NewForConfig(cfg)
}
