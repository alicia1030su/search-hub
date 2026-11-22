/** Normalize Vitest list output to sorted file::fullName identities. */
export function normalizeList(value) {
  const entries = Array.isArray(value) ? value : value?.tests ?? value?.testResults ?? [];
  return entries.map((entry) => {
    const file = typeof entry === "string" ? entry : entry.file ?? entry.filePath ?? entry.name;
    const name = typeof entry === "string" ? entry : entry.fullName ?? entry.name ?? "";
    return `${String(file).replaceAll("\\", "/")}::${String(name)}`;
  }).sort();
}

/** Flatten Vitest JSON assertion results without dropping skipped/todo cases. */
export function normalizeResults(value) {
  const entries = [];
  for (const file of value.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      entries.push({ key: `${String(file.name).replaceAll("\\", "/")}::${test.fullName}`, status: test.status });
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/** Compare complete test identity sets and require every case to pass. */
export function compareLowmem(expected, result, options = {}) {
  const assertions = normalizeResults(result);
  const expectedSorted = [...expected].sort();
  const actual = assertions.map((entry) => entry.key).sort();
  const expectedSet = new Set(expectedSorted);
  const actualSet = new Set(actual);
  const missing = expectedSorted.filter((key) => !actualSet.has(key));
  const unexpected = actual.filter((key) => !expectedSet.has(key));
  const nonPassed = assertions.filter((entry) => entry.status !== "passed");
  const listCleanup = options.listCleanup ?? { ok: true, residuals: [], errors: [] };
  const runCleanup = options.runCleanup ?? { ok: true, residuals: [], errors: [] };
  return {
    expectedCount: expectedSorted.length,
    actualCount: actual.length,
    missing,
    unexpected,
    nonPassed,
    listCleanup,
    runCleanup,
    passed: expectedSorted.length > 0 && missing.length === 0 && unexpected.length === 0 && nonPassed.length === 0 && options.runExitCode === 0 && listCleanup.ok && runCleanup.ok,
  };
}
