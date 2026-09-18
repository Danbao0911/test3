export type RecoveryCleanupStep = "fixture" | "disconnect" | "drop" | "files";

export type RecoveryCleanupOperations = Record<RecoveryCleanupStep, () => Promise<void>>;

export type RecoveryCleanupResult = {
  errors: Array<{ step: RecoveryCleanupStep; code: "CLEANUP_STEP_FAILED" }>;
};

/**
 * Runs recovery-drill cleanup in a fixed order and never hides a failed step.
 * The optional injected set is intentionally test-only plumbing; the script
 * itself never enables it for a normal run.
 */
export async function runRecoveryCleanup(
  operations: RecoveryCleanupOperations,
  options: { injectFailure?: RecoveryCleanupStep } = {},
): Promise<RecoveryCleanupResult> {
  const errors: RecoveryCleanupResult["errors"] = [];
  for (const step of ["fixture", "disconnect", "drop", "files"] as const) {
    try {
      if (options.injectFailure === step) throw new Error("synthetic cleanup failure");
      await operations[step]();
    } catch {
      errors.push({ step, code: "CLEANUP_STEP_FAILED" });
    }
  }
  return { errors };
}

export function recoveryOutcome(recoveryVerified: boolean, cleanup: RecoveryCleanupResult) {
  const passed = recoveryVerified && cleanup.errors.length === 0;
  return {
    status: passed ? "passed" as const : "failed" as const,
    exitCode: passed ? 0 : 1,
    recoveryVerified,
    cleanupVerified: cleanup.errors.length === 0,
    cleanupErrors: cleanup.errors,
  };
}
