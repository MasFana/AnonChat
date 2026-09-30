package chat

import "testing"

func TestLoadConfigDeploymentDefaults(t *testing.T) {
	t.Setenv("ADDR", "")
	t.Setenv("TRUSTED_PROXY_CIDRS", "")
	t.Setenv("PPROF_TOKEN", "")

	config, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Address != "127.0.0.1:8000" || config.PprofToken != "" {
		t.Fatalf("unexpected defaults: %#v", config)
	}
	if len(config.TrustedProxyCIDRs) != 2 || config.TrustedProxyCIDRs[0].String() != "127.0.0.1/32" || config.TrustedProxyCIDRs[1].String() != "::1/128" {
		t.Fatalf("unexpected trusted proxies: %v", config.TrustedProxyCIDRs)
	}
}
