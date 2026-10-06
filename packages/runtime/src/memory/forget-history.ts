// Which history entries a held topic or withheld quote reaches when it is split over consecutive turns.
// One linear pass per stream: join the normalized entries into one string with an offset map (all entries, and each role's entries alone,
// since an owner message split over turns has assistant replies between its pieces; joined with no gap and with a space), find every occurrence
// of a needle, and drop exactly the entries a match overlaps. Known limit: pieces separated by an unrelated entry of the same role, and paraphrases, are not caught.
export const splitDrops = (texts: readonly string[], roles: readonly unknown[], needles: readonly string[], alone: readonly boolean[]): boolean[] => {
  const drop = alone.slice();
  const live = needles.filter(needle => needle.length > 0);
  const sweep = (indices: number[], gap: string) => {
    let stream = ''; const starts: number[] = [];
    indices.forEach((index, at) => { if (at > 0) stream += gap; starts.push(stream.length); stream += texts[index]!; });
    const entryAt = (offset: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= offset) lo = mid; else hi = mid - 1; } return lo; };
    for (const needle of live) {
      for (let found = stream.indexOf(needle); found !== -1; found = stream.indexOf(needle, found + 1)) {
        const first = entryAt(found), last = entryAt(found + needle.length - 1);
        if (last > first) for (let k = first; k <= last; k++) drop[indices[k]!] = true;
      }
    }
  };
  const every = texts.map((_, i) => i);
  for (const gap of ['', ' ']) {
    sweep(every, gap);
    for (const role of new Set(roles)) sweep(every.filter(i => roles[i] === role), gap);
  }
  return drop;
};
