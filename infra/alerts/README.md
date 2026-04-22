# Alerting rules

Prometheus-format alert rules for gluecron. Provider-neutral — works
with Prometheus + Alertmanager, Grafana Mimir + Grafana OnCall,
VictoriaMetrics + vmalert, or Thanos Ruler.

## File

- `gluecron.rules.yml` — five groups: availability, errors, latency,
  autopilot, resources. Three severity levels: `critical`, `warning`, `info`.

## Wire-up

### Prometheus + Alertmanager

1. Scrape gluecron:
   ```yaml
   # prometheus.yml
   scrape_configs:
     - job_name: gluecron
       metrics_path: /metrics
       static_configs:
         - targets: ['gluecron.com:443']
       scheme: https
   ```
2. Include the rules file:
   ```yaml
   # prometheus.yml
   rule_files:
     - /etc/prometheus/gluecron.rules.yml
   ```
3. Point Alertmanager at Slack / PagerDuty / email. Route `severity=critical`
   to the pager channel, `severity=warning` to Slack-warning.

### Blackbox probes for /readyz

One rule (`GluecronNotReady`) assumes you also run the Prometheus
[blackbox_exporter](https://github.com/prometheus/blackbox_exporter) probing
`https://gluecron.com/readyz`. If you skip blackbox, that rule will never
fire — safe, just redundant with `GluecronDown`.

Minimal blackbox scrape:
```yaml
- job_name: gluecron-blackbox
  metrics_path: /probe
  params:
    module: [http_2xx]
  static_configs:
    - targets:
        - https://gluecron.com/readyz
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - source_labels: [__param_target]
      target_label: instance
    - target_label: __address__
      replacement: blackbox-exporter:9115
```

## Severity routing

| Severity   | Where it goes          | Examples                                |
|------------|------------------------|-----------------------------------------|
| `critical` | page (SMS / phone)     | `GluecronDown`, `GluecronSpike5xx`      |
| `warning`  | Slack / email          | `GluecronHigh5xxRate`, `GluecronHighLatencyP95` |
| `info`     | dashboard only         | (reserved; none yet)                    |

## Tuning

- `GluecronHigh5xxRate` fires at >5% for 10m. Tighten once baseline is known.
- `GluecronHighLatencyP95` fires at >2s for 15m. Tune after the first
  24 hours of real traffic.
- `GluecronAutopilotStalled` expects `autopilot_last_run_timestamp_seconds`
  metric. If the autopilot ticker doesn't emit this gauge yet, either
  add it to `src/lib/autopilot.ts` (one `gauge.set(Date.now()/1000)`
  per tick) or drop this rule until the metric exists.

## Validation

Before rolling out:
```sh
promtool check rules infra/alerts/gluecron.rules.yml
```

No output = valid.
