/**
 * Deterministic development / holdout split.
 *
 * Tuning a parameter on the same queries used to report its final score is the
 * classic way to publish a number that does not generalise. The split is
 * computed from the query ids themselves — sorted, then dealt alternately — so
 * it is reproducible without a random seed and stable across runs and machines.
 */
export interface QuerySplit {
  development: string[];
  holdout: string[];
}

export function splitQueries(queryIds: readonly string[], developmentShare = 0.5): QuerySplit {
  const unique = [...new Set(queryIds)].sort();
  const share = Math.min(0.9, Math.max(0.1, developmentShare));
  const developmentCount = Math.max(1, Math.round(unique.length * share));
  const development: string[] = [];
  const holdout: string[] = [];
  // Deal alternately rather than slicing, so both halves get a spread of query
  // ids (and therefore of categories, given how fixtures are ordered).
  unique.forEach((id, index) => {
    if (index % 2 === 0 && development.length < developmentCount) development.push(id);
    else if (holdout.length < unique.length - developmentCount) holdout.push(id);
    else development.push(id);
  });
  return { development, holdout };
}
