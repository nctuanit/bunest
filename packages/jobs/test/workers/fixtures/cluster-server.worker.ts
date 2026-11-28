import { onClusterShutdown } from "../../../src/workers";

// Minimal worker for BunestWorkerCluster lifecycle test
let active = true;
const keepAlive = setInterval(() => {
  if (!active) clearInterval(keepAlive);
}, 1000);

onClusterShutdown(() => {
  active = false;
  clearInterval(keepAlive);
});
