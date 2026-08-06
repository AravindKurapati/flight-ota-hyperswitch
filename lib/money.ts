/** Dollars to minor units. Rounds to avoid float drift: 19.99 * 100 = 1998.9999... */
export function usd(major: number): number {
  return Math.round(major * 100);
}

export function formatUsd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

const EXCISE_RATE = 0.075;        // US domestic air transportation excise tax
const SEGMENT_FEE = 505;          // per segment, minor units
const SEPTEMBER_11_FEE = 560;     // per one-way trip, minor units

export function fareBreakdown(baseMinor: number) {
  const excise = Math.round(baseMinor * EXCISE_RATE);
  const segment = SEGMENT_FEE;
  const september11 = SEPTEMBER_11_FEE;
  return {
    base: baseMinor,
    excise,
    segment,
    september11,
    total: baseMinor + excise + segment + september11,
  };
}
