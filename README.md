# Cable Atlas

An interactive 3D globe of the world's submarine internet cables — 724 cables,
1,922 landing points, 1989–2029. Dark cinematic globe, glowing cables with
animated light-packet pulses, click-to-explore cable stories, a timeline of the
network's growth, and search across cables, countries, and owners.

All 724 cables render as a **single merged `THREE.LineSegments` draw call**; one
shader drives the traffic pulses, timeline year-filtering, hover highlight, and
selection dimming via vertex attributes + uniforms, so the scene stays at 60fps.

## Develop

```bash
npm install
npm run data    # re-fetch latest cable data from TeleGeography's public API
npm run dev
```

## Deploy

Vercel (current production): `vercel deploy --prod`.

Self-hosted / Rancher / any Kubernetes — image is published at
`ghcr.io/saiudayagiri/cable-atlas:v1`:

```bash
# rebuild + push a new version
docker build -t ghcr.io/saiudayagiri/cable-atlas:v1 .
docker push ghcr.io/saiudayagiri/cable-atlas:v1

# deploy (edit the Ingress host in deploy/k8s.yaml first)
kubectl create namespace cable-atlas
kubectl apply -n cable-atlas -f deploy/k8s.yaml
kubectl -n cable-atlas get pods -w        # wait for 2/2 Running

# if the ghcr package is private, either make it public
# (github.com -> Packages -> cable-atlas -> settings -> Change visibility)
# or create a pull secret and uncomment imagePullSecrets in deploy/k8s.yaml:
kubectl -n cable-atlas create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=saiudayagiri \
  --docker-password=<github-token-with-read:packages>

# quick check without DNS/Ingress:
kubectl -n cable-atlas port-forward svc/cable-atlas 8080:80
# then open http://localhost:8080
```

The container is a ~15 MB nginx serving the static build — no GPU resources
needed server-side (all rendering is client WebGL). Each pod handles thousands
of concurrent visitors; 2 replicas is plenty. Verified on a kind cluster:
both replicas Ready, app + data served through the Service.

## Data

Cable geometry and metadata © [TeleGeography](https://www.submarinecablemap.com),
fetched from their public API and baked to static JSON at build time
(`scripts/fetch-data.mjs`). Non-commercial use, with attribution — this project
is a fan visualization, not affiliated with TeleGeography.
