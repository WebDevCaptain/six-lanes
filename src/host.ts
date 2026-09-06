import { cpus, totalmem, release, platform } from 'node:os';

/**
 * Plan section 9 rule 7: every published number carries the machine it came from.
 *
 * A millisecond is a property of hardware, not of an architecture. Without the
 * host stamped beside it, a timing tells a reader nothing they can transfer to
 * their own situation - which is also why bytes read is reported next to it.
 */
export interface HostSpec {
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGb: number;
  readonly platform: string;
  readonly node: string;
  readonly measuredAt: string;
}

export function hostSpec(): HostSpec {
  const cores = cpus();
  return {
    cpu: cores[0]?.model ?? 'unknown',
    cores: cores.length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    platform: `${platform()} ${release()}`,
    node: process.version,
    measuredAt: new Date().toISOString().slice(0, 10),
  };
}

export function describeHost(spec: HostSpec = hostSpec()): string {
  return `${spec.cpu}, ${spec.cores} cores, ${spec.memoryGb} GB, ${spec.platform}, node ${spec.node}, measured ${spec.measuredAt}`;
}
