const MIN_PASSPHRASE_CODE_POINTS = 12;

/**
 * Validates the policy without normalizing the secret. Trimming is used only
 * for the Unicode-code-point length/blank check; encryption always uses the
 * exact value supplied by the operator.
 */
export function validateBackupPassphrase(value: string): string {
  if (typeof value !== "string") throw new Error("Backup passphrase must be a string");
  const checked = value.trim();
  if (checked.length === 0) throw new Error("Backup passphrase must not be blank");
  if (Array.from(checked).length < MIN_PASSPHRASE_CODE_POINTS) {
    throw new Error(`Backup passphrase must contain at least ${MIN_PASSPHRASE_CODE_POINTS} Unicode code points`);
  }
  return value;
}
