// Bounded concurrency; results are consumed and committed in input order.
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

export function resolveConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.min(parsed, MAX_CONCURRENCY);
}

// A bounded sliding window: responses may finish out of order, but the consumer
// sees mail chronology and can persist each result before the whole batch ends.
// Keeping at most `width` results also prevents a slow first mail from buffering
// an unbounded number of later responses. Workers must return failures as values.
export async function* mapInOrder(items, worker, limit = DEFAULT_CONCURRENCY, shouldStop = () => false) {
  const width = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_CONCURRENCY, items.length));
  const active = new Map();
  let next = 0;
  const launch = () => {
    while (active.size < width && next < items.length && !shouldStop()) {
      const index = next++;
      active.set(index, Promise.resolve().then(() => worker(items[index], index)));
    }
  };
  launch();
  for (let index = 0; index < items.length; index += 1) {
    const result = active.get(index);
    if (!result) break;
    yield { index, result: await result };
    active.delete(index);
    launch();
  }
}
