import { describe, expect, it } from "bun:test";
import { evaluateRssStability, type RssSample } from "../scripts/load-test";

function makeSamples(rssValues: number[]): RssSample[] {
  return rssValues.map((rssMb, idx) => ({
    elapsedSec: idx * 30,
    rssMb,
    lagMs: 1.5,
  }));
}

describe("load-test — evaluateRssStability", () => {
  it("reports rssStable: true for stable or plateaued RSS samples within budget", () => {
    const fluctuating = evaluateRssStability(
      makeSamples([100, 112.5, 115, 114.2, 115.1]),
      64,
    );
    expect(fluctuating).toEqual({
      rssStable: true,
      netGrowthMb: 15.1,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });

    const plateaued = evaluateRssStability(makeSamples([120, 120, 120, 120]), 64);
    expect(plateaued).toEqual({
      rssStable: true,
      netGrowthMb: 0,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });
  });

  it("reports rssStable: false for monotonically increasing RSS samples (3+ samples)", () => {
    const result = evaluateRssStability(
      makeSamples([100, 102, 104.5, 107]),
      64,
    );
    expect(result).toEqual({
      rssStable: false,
      netGrowthMb: 7,
      monotonicGrowth: true,
      maxRssGrowthMb: 64,
    });
  });

  it("reports rssStable: false when net RSS drift exceeds maxRssGrowthMb", () => {
    const result = evaluateRssStability(
      makeSamples([100, 145, 130, 164.01]),
      64,
    );
    expect(result).toEqual({
      rssStable: false,
      netGrowthMb: 64.01,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });
  });

  it("allows net RSS drift exactly equal to maxRssGrowthMb when non-monotonic", () => {
    const result = evaluateRssStability(makeSamples([100, 168, 164]), 64);
    expect(result).toEqual({
      rssStable: true,
      netGrowthMb: 64,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });
  });

  it("handles edge cases with empty, single, or two samples", () => {
    expect(evaluateRssStability([], 64)).toEqual({
      rssStable: true,
      netGrowthMb: null,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });

    expect(evaluateRssStability(makeSamples([110]), 64)).toEqual({
      rssStable: true,
      netGrowthMb: null,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });

    // 2 samples: monotonic check requires >= 3 samples, only maxRssGrowthMb applies
    expect(evaluateRssStability(makeSamples([100, 120]), 64)).toEqual({
      rssStable: true,
      netGrowthMb: 20,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });

    expect(evaluateRssStability(makeSamples([100, 170]), 64)).toEqual({
      rssStable: false,
      netGrowthMb: 70,
      monotonicGrowth: false,
      maxRssGrowthMb: 64,
    });
  });
});
