import { hostname } from 'node:os';

/**
 * Which replica answered. In Compose and Kubernetes the hostname is the
 * container's name, which is exactly the granularity the section 25 experiment
 * needs: a run where one replica served every request is not a measurement of a
 * cluster, and the load scripts check for it rather than trusting the topology.
 *
 * Read once: the hostname cannot change under a running process.
 */
export const INSTANCE_ID = hostname();
