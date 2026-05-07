# Disc Helm Chart

Self-host [Disc](https://github.com/systemsoft/disc) on Kubernetes.

## What This Chart Deploys

- A `Deployment` running the Disc server image (`ghcr.io/systemsoft/disc`)
- A `Service` (ClusterIP by default) exposing port 5656
- An optional `Ingress`, `HorizontalPodAutoscaler`, `PodDisruptionBudget`,
  `ServiceMonitor`, and `NetworkPolicy`
- A chart-managed `Secret` (DATABASE_URL + DISC_JWT_SECRET) when you don't
  bring your own

The chart targets **external PostgreSQL only**. The bundled-PG path that
ships with the Disc CLI is a local-development convenience and is not
deployed by this chart. Use a managed PostgreSQL (RDS, CloudSQL, AlloyDB,
Bitnami chart, Crunchy Postgres operator, etc.) and point this chart at it.

## Prerequisites

- Kubernetes 1.25+
- Helm 3.10+
- An external PostgreSQL 16+ instance reachable from the cluster
- (Optional) cert-manager for TLS issuance
- (Optional) Prometheus Operator for `ServiceMonitor` support

## Quick Install

```bash
helm install disc ./deploy/helm/disc \
  --set database.external.url='postgres://disc:secret@my-pg.example.com:5432/disc'
```

The chart auto-generates a JWT signing secret on first install and
preserves it across upgrades via `helm.sh/resource-policy: keep`.

## Upgrade

```bash
helm upgrade disc ./deploy/helm/disc -f my-values.yaml
```

Rolling updates use `maxSurge: 1`, `maxUnavailable: 0`, so a healthy
replica is always serving during the rollout. The pre-stop period is
`terminationGracePeriodSeconds: 30` to match Disc's `shutdownDrainTimeout`.

## Configuration

See [`values.yaml`](./values.yaml) for the full reference (every option is
documented inline). The most-likely overrides:

| Path                                                       | Purpose                      |
| ---------------------------------------------------------- | ---------------------------- |
| `image.tag`                                                | Pin to an exact image tag.   |
| `replicaCount`                                             | HA replica count.            |
| `database.external.url` / `database.external.urlSecretRef` | Connect to your Postgres.    |
| `auth.jwtSecret` / `auth.jwtSecretRef`                     | Provide your own JWT secret. |
| `tls.enabled`, `tls.certSecret`                            | In-pod TLS termination.      |
| `ingress.enabled`, `ingress.hosts`, `ingress.tls`          | Expose to the world.         |
| `autoscaling.enabled`                                      | Turn on the HPA.             |
| `metrics.enabled`, `metrics.serviceMonitor.enabled`        | Wire up Prometheus.          |

For a production-grade overlay, see
[`values-prod-example.yaml`](./values-prod-example.yaml).

## A Note on OAuth / SMTP / Captcha

As of Disc `2026.05.04`, OAuth provider config, SMTP config, and captcha
config are configured at SDK-instantiation time in user code rather than
via `DISC_*` environment variables. To wire those into a Kubernetes
deployment today:

1. Mount your config as a file via `extraVolumes` / `extraVolumeMounts`
2. Reference it from your bootstrap script

Future versions of Disc may expose `DISC_OAUTH_*` / `DISC_SMTP_*` env
vars, at which point those will be added to this chart.

## Bundled PostgreSQL Path

If you saw `Dockerfile.bundled` in the Disc repo and wondered: that path
is for local development only. It runs Postgres inside the same container
via the Disc CLI's bundled-binary manager. For production, use a managed
PostgreSQL and point this chart at it via `database.external.*`.

## Testing the Install

```bash
helm test disc
```

Runs a busybox pod that hits `/health/ready` on the Service and asserts a
200 response.

## Uninstall

```bash
helm uninstall disc
```

The chart-managed Secret is annotated `helm.sh/resource-policy: keep`, so
it is preserved across uninstall to avoid losing the JWT signing key. To
delete it explicitly:

```bash
kubectl delete secret disc
```
