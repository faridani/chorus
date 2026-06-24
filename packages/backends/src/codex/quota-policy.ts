import type { ExitContext, QuotaPolicy, TerminalReason } from "@chorus/core";

export interface CodexQuotaConfig {
  /** Regex source strings indicating quota/rate-limit exhaustion. */
  exhaustionPatterns: string[];
  backoffStartMs: number;
  backoffMaxMs: number;
}

/**
 * Classifies how a Codex run ended and schedules retries after a quota pause.
 * Detection priority: explicit quota event → stderr regex → exit code. The
 * regex set is config-driven so it can be tuned without a release once we
 * learn the exact wording Codex emits when a subscription is exhausted.
 */
export class CodexQuotaPolicy implements QuotaPolicy {
  private readonly patterns: RegExp[];

  constructor(private readonly cfg: CodexQuotaConfig) {
    this.patterns = cfg.exhaustionPatterns.map((p) => new RegExp(p, "i"));
  }

  classifyExit(ctx: ExitContext): TerminalReason {
    if (ctx.killedByUs) return "killed";

    const sawQuotaEvent = ctx.lastEvents.some((e) => e.kind === "quota_warning");
    if (sawQuotaEvent || this.matchesQuota(ctx.stderrTail)) {
      return "quota_exhausted";
    }

    if (ctx.signal) return "crashed";
    if (ctx.exitCode === 0) return "completed";
    return "failed";
  }

  nextRetryAt(now: number, consecutivePauses: number): number {
    // First pause (count = 1) waits the base delay; each subsequent pause doubles.
    const factor = 2 ** Math.max(0, consecutivePauses - 1);
    const delay = Math.min(this.cfg.backoffStartMs * factor, this.cfg.backoffMaxMs);
    return now + delay;
  }

  private matchesQuota(text: string): boolean {
    return this.patterns.some((re) => re.test(text));
  }
}
