import type { NodeRuntimeMetrics } from "../interfaces/observe-types";

export function collectRuntimeMetrics(
  prevCpu?: NodeJS.CpuUsage,
  elapsedMs = 1000,
): { sample: NodeRuntimeMetrics; cpu: NodeJS.CpuUsage } {
  const cpu = process.cpuUsage();
  const deltaUser = prevCpu ? Math.max(0, cpu.user - prevCpu.user) : cpu.user;
  const deltaSystem = prevCpu
    ? Math.max(0, cpu.system - prevCpu.system)
    : cpu.system;
  const totalMicros = deltaUser + deltaSystem;
  const percentageUsed =
    elapsedMs > 0
      ? Math.min(100, (totalMicros / (elapsedMs * 1000)) * 100)
      : 0;

  const mem = process.memoryUsage();
  const memPct =
    mem.heapTotal > 0 ? Math.min(100, (mem.heapUsed / mem.heapTotal) * 100) : 0;

  const sample: NodeRuntimeMetrics = {
    cpu: {
      user: deltaUser,
      system: deltaSystem,
      percentageUsed,
    },
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      percentageUsed: memPct,
    },
    gc: {
      count: 0,
      totalDuration: 0,
      breakdown: {},
    },
    eventLoop: {
      lag: 0,
      utilization: 0,
    },
  };
  return { sample, cpu };
}
