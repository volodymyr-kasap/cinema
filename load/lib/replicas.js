import http from 'k6/http';
import { check } from 'k6';

function headerValue(response, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(response.headers)) {
    if (key.toLowerCase() === wanted) return response.headers[key];
  }
  return null;
}

/**
 * The single most likely way to get a fake result out of this sub-project is an
 * nginx that resolved `api` once at startup and sent everything to one replica:
 * the stack looks balanced and the experiment measures one container (spec §6).
 *
 * So the run ends by asking. Twenty sequential probes per expected replica, and
 * every replica must serve at least half of its equal share. Sequential and
 * separate from the load phase on purpose -- this is a question about routing,
 * and answering it under saturation would only measure queueing.
 */
export function checkReplicaBalance(baseUrl, replicas) {
  const probes = replicas * 20;
  const served = {};

  for (let i = 0; i < probes; i += 1) {
    const response = http.get(`${baseUrl}/api/v1/movies?limit=1`);
    const id = headerValue(response, 'x-instance-id') || 'unknown';
    served[id] = (served[id] || 0) + 1;
  }

  const floor = Math.floor(probes / replicas / 2);
  console.log(`replica distribution over ${probes} probes: ${JSON.stringify(served)}`);

  check(served, {
    [`all ${replicas} replicas answered`]: (s) => Object.keys(s).length === replicas,
    [`every replica served at least ${floor} probes`]: (s) =>
      Object.keys(s).every((id) => s[id] >= floor),
  });
}
