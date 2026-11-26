export type Health = "up" | "down" | "dead";

export interface HealthMonitorOptions {
  /** Resolves true when the server answers its health endpoint; a throw counts as a failed probe. */
  probe: () => Promise<boolean>;
  childExited: () => boolean;
  /** Consecutive failed probes that mean the server is dead (default 3). */
  failuresToDead?: number;
}

/**
 * Tells a slow or busy server ("down") from a dead one: a single failed probe is not death,
 * `failuresToDead` in a row is, and an exited child is death right away.
 */
export class HealthMonitor {
  readonly #probe: () => Promise<boolean>;
  readonly #childExited: () => boolean;
  readonly #failuresToDead: number;
  #failures = 0;

  constructor(o: HealthMonitorOptions) {
    this.#probe = o.probe;
    this.#childExited = o.childExited;
    this.#failuresToDead = o.failuresToDead ?? 3;
  }

  async check(): Promise<Health> {
    if (this.#childExited()) return "dead";
    let ok = false;
    try {
      ok = await this.#probe();
    } catch {
      // a refused connection is a failed probe
    }
    if (ok) {
      this.#failures = 0;
      return "up";
    }
    this.#failures += 1;
    return this.#failures >= this.#failuresToDead ? "dead" : "down";
  }

  /** Forget earlier failures, e.g. after the server was restarted. */
  reset(): void {
    this.#failures = 0;
  }
}
