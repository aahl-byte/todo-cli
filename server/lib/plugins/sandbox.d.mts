export interface SandboxJob {
  code: string;
  item: unknown;
  event: unknown;
  settings: unknown;
  connections: string[];
  kinds: string[];
  /** Epoch ms the run must finish by. */
  deadline: number;
  memoryBytes: number;
}

/** Each answers with a JSON envelope: {value} or {error, status?}. */
export interface SandboxHost {
  call(connection: string, call: string): Promise<string>;
  attach(kind: string, fields: string): Promise<string>;
  sleep(ms: number): Promise<string>;
}

export function runSandbox(job: SandboxJob, host: SandboxHost): Promise<{ error?: string }>;
export function hostFailure(e: unknown): string;
