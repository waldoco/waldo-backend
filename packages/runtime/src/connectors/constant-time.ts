// Compares secrets (MACs, digests, signatures) without returning early on the first differing byte, so response
// timing does not reveal how much of a forged value was right.
export const constantTimeEqual = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ (right[i] ?? 0);
  return diff === 0;
};
