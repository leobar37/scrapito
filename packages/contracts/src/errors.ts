/** Base class for all typed errors thrown by the SDK. */
export class ScrapError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Thrown when the agent-browser subprocess fails to spawn, times out, or
 * emits malformed stdout (i.e. anything that is NOT a valid failure envelope). */
export class AgentBrowserProcessError extends ScrapError {
  constructor(message: string, details?: unknown) {
    super("AGENT_BROWSER_PROCESS", message, details);
  }
}

/** Thrown when a browser/domain command returns a valid failure envelope. */
export class AgentBrowserCommandError extends ScrapError {
  constructor(message: string, details?: unknown) {
    super("AGENT_BROWSER_COMMAND", message, details);
  }
}

/** Thrown when a URL/host/path is rejected by CrawlPolicy. */
export class PolicyError extends ScrapError {
  constructor(message: string, details?: unknown) {
    super("POLICY_DENIED", message, details);
  }
}

/** Thrown when a per-host circuit is open. */
export class CircuitOpenError extends ScrapError {
  constructor(message: string, details?: unknown) {
    super("CIRCUIT_OPEN", message, details);
  }
}

/** Thrown when a job/run exhausts its request or duration budget. */
export class BudgetExhaustedError extends ScrapError {
  constructor(message: string, details?: unknown) {
    super("BUDGET_EXHAUSTED", message, details);
  }
}

/** Thrown when a challenge/CAPTCHA is detected. */
export class ChallengeDetectedError extends ScrapError {
  constructor(message: string, details?: unknown) {
    super("CHALLENGE_DETECTED", message, details);
  }
}

/** Thrown when the ingest writer lease is held by another process. */
export class WriterLockedError extends ScrapError {
  constructor(message: string, details?: unknown) {
    super("WRITER_LOCKED", message, details);
  }
}
