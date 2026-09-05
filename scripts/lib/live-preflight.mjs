/** Reject an unaffordable campaign before any provider invocation is reserved. */
export function assertLiveCampaignReady(allowance, observations, mockObservations, needsConformance) {
  if (allowance.pending) throw new Error("Unconfirmed live call; inspect before continuing");
  if (observations.some(o => !o.passed)) throw new Error("A prior comparison failed; preserve it and review the evidence before another campaign");
  if (mockObservations.length !== 4 || mockObservations.some(o => !o.passed || !Number.isInteger(o.calls) || o.calls < 1)) throw new Error("Four successful mock observations with measured calls are required");
  const minimumCalls = mockObservations.slice(observations.length).reduce((sum, o) => sum + o.calls, needsConformance ? 4 : 0);
  const remainingCalls = allowance.maxCalls - allowance.calls;
  if (minimumCalls > remainingCalls) throw new Error(`Insufficient remaining allowance: at least ${minimumCalls} calls required, ${remainingCalls} available. No calls started.`);
  if (allowance.activeMs >= allowance.maxActiveMs) throw new Error("Active time allowance exhausted");
  return { minimumCalls, remainingCalls, retryReserve: remainingCalls - minimumCalls };
}
export function assertFunctionalPreflight(allowance, mock) {
  if (allowance.pending) throw new Error("Unconfirmed live call; inspect before continuing");
  if (mock.mode !== "mock" || !mock.passed || mock.status !== "completed" || mock.workerCount !== 2 || mock.calls !== 8) throw new Error("A successful eight-call generated-graph mock is required");
  const remainingCalls = allowance.maxCalls - allowance.calls;
  if (remainingCalls < mock.calls) throw new Error(`At least ${mock.calls} calls required, ${remainingCalls} available. No calls started.`);
  if (allowance.activeMs >= allowance.maxActiveMs) throw new Error("Active time allowance exhausted");
  return { estimatedCalls: mock.calls, remainingCalls, retryReserve: remainingCalls - mock.calls };
}
