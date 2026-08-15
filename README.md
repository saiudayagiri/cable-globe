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

Self-hosted / Rancher / any Kubernetes:

```bash
docker build -t <registry>/cable-atlas:v1 .
docker push <registry>/cable-atlas:v1
# edit image + host in deploy/k8s.yaml, then
kubectl apply -f deploy/k8s.yaml
```

The container is a ~15 MB nginx serving the static build — no GPU resources
needed server-side (all rendering is client WebGL). Each pod handles thousands
of concurrent visitors; 2 replicas is plenty.

## Data

Cable geometry and metadata © [TeleGeography](https://www.submarinecablemap.com),
fetched from their public API and baked to static JSON at build time
(`scripts/fetch-data.mjs`). Non-commercial use, with attribution — this project
is a fan visualization, not affiliated with TeleGeography.
