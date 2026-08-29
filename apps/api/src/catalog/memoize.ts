/**
 * Caches the promise, not the value, so N concurrent misses share one load.
 * A rejection is evicted: a cache that remembers failures answers with them
 * forever.
 */
export function singleFlight<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  load: () => Promise<V>,
): Promise<V> {
  const cached = cache.get(key);
  if (cached) return cached;

  const loading = load();
  cache.set(key, loading);
  // Attached, not awaited, and swallowing nothing: the caller still sees the
  // rejection, this only stops it being served to the next caller.
  loading.catch(() => {
    if (cache.get(key) === loading) cache.delete(key);
  });

  return loading;
}
