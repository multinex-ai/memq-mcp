import type { QuantumEntropySample } from "./quantum_entropy.ts";

export type ReplayCandidate = {
  id: string;
  agent_id: string;
  memory_type: string;
  task_id: string | null;
  tags: string[];
  text: string;
  created_at: string;
};

export type ReplaySelectionMode =
  | "window"
  | "priority_deterministic"
  | "priority_prng"
  | "priority_quantum";

export type ReplaySignalCounts = {
  failure: number;
  contradiction: number;
  procedure: number;
  constraint: number;
  surprise: number;
  benchmark: number;
};

export type ScoredReplayCandidate = ReplayCandidate & {
  replay_score: number;
  score_breakdown: Record<string, number>;
  signals: Array<keyof ReplaySignalCounts>;
};

export type ReplaySelectionDiagnostics = {
  mode: ReplaySelectionMode;
  strategy: "window" | "priority" | "priority_prng_tiebreak" | "priority_quantum_tiebreak";
  candidate_count: number;
  selected_count: number;
  tie_window_size: number;
  cutoff_score: number | null;
  selected_ids: string[];
  top_signals: ReplaySignalCounts;
  quantum_sample: QuantumEntropySample | null;
};

export type ReplaySelectionResult = {
  selected: ScoredReplayCandidate[];
  diagnostics: ReplaySelectionDiagnostics;
};

type ReplaySelectionOptions = {
  mode: ReplaySelectionMode;
  maxSources: number;
  tieEpsilon: number;
  quantumSample?: QuantumEntropySample | null;
};

const TYPE_WEIGHTS: Record<string, number> = {
  procedural: 0.26,
  semantic: 0.18,
  hybrid: 0.17,
  checkpoint: 0.14,
  episodic: 0.12,
  reflection: -0.08
};

const SIGNAL_PATTERNS: Record<keyof ReplaySignalCounts, RegExp> = {
  failure: /\b(fail(?:ed|ure)?|error|bug|incident|regression|broken|degraded|timeout|exception|mismatch|outage)\b/i,
  contradiction: /\b(contradict(?:ion|ory)?|stale|outdated|invalid|changed|no longer|drift|superseded)\b/i,
  procedure: /\b(should|must|never|always|step|procedure|protocol|run|call|pin|use|execute)\b/i,
  constraint: /\b(cannot|must not|limit|require|only|forbidden|boundary|auth|compliance|guardrail)\b/i,
  surprise: /\b(surpris(?:e|ing)|unexpected|novel|unknown|emergent)\b/i,
  benchmark: /\b(benchmark|measure|metric|latency|success rate|regression test|reproducible)\b/i
};

const SIGNAL_WEIGHTS: Record<keyof ReplaySignalCounts, number> = {
  failure: 0.24,
  contradiction: 0.2,
  procedure: 0.17,
  constraint: 0.15,
  surprise: 0.09,
  benchmark: 0.07
};

export function selectReplayCandidates(
  candidates: ReplayCandidate[],
  options: ReplaySelectionOptions
): ReplaySelectionResult {
  const maxSources = Math.max(1, options.maxSources);
  const tieEpsilon = Math.max(0, options.tieEpsilon);
  if (options.mode === "window") {
    const selected = candidates.slice(0, maxSources).map((candidate, index) =>
      scoreReplayCandidate(candidate, index, candidates.length)
    );
    return {
      selected,
      diagnostics: buildDiagnostics("window", options.mode, selected, candidates.length, 0, null, options.quantumSample ?? null)
    };
  }

  const scored = candidates.map((candidate, index) => scoreReplayCandidate(candidate, index, candidates.length));
  scored.sort(compareScoredCandidates);

  if (scored.length <= maxSources) {
    return {
      selected: scored,
      diagnostics: buildDiagnostics("priority", options.mode, scored, candidates.length, 0, null, options.quantumSample ?? null)
    };
  }

  const cutoffScore = scored[maxSources - 1]?.replay_score ?? null;
  const upperThreshold = (cutoffScore ?? 0) + tieEpsilon;
  const lowerThreshold = (cutoffScore ?? 0) - tieEpsilon;
  const guaranteed = scored.filter((candidate) => candidate.replay_score > upperThreshold);

  if (guaranteed.length >= maxSources) {
    const selected = guaranteed.slice(0, maxSources);
    return {
      selected,
      diagnostics: buildDiagnostics("priority", options.mode, selected, candidates.length, Math.max(0, guaranteed.length - maxSources), cutoffScore, options.quantumSample ?? null)
    };
  }

  const remainingSlots = maxSources - guaranteed.length;
  const tieWindow = scored.filter((candidate) => candidate.replay_score <= upperThreshold && candidate.replay_score >= lowerThreshold);
  const selected = [...guaranteed, ...selectTieWindow(tieWindow, remainingSlots, options)];

  let strategy: ReplaySelectionDiagnostics["strategy"] = "priority";
  if (options.mode === "priority_prng" && tieWindow.length > remainingSlots) {
    strategy = "priority_prng_tiebreak";
  } else if (options.mode === "priority_quantum" && tieWindow.length > remainingSlots && options.quantumSample) {
    strategy = "priority_quantum_tiebreak";
  }

  return {
    selected,
    diagnostics: buildDiagnostics(strategy, options.mode, selected, candidates.length, tieWindow.length, cutoffScore, options.quantumSample ?? null)
  };
}

export function scoreReplayCandidate(
  candidate: ReplayCandidate,
  recencyRank: number,
  totalCount: number
): ScoredReplayCandidate {
  const recencyDenominator = Math.max(1, totalCount - 1);
  const recencyScore = 0.22 * (1 - (recencyRank / recencyDenominator));
  const typeScore = TYPE_WEIGHTS[candidate.memory_type] ?? 0.1;
  const taskScore = candidate.task_id ? 0.08 : 0;
  const tagDiversityScore = Math.min(0.06, candidate.tags.length * 0.01);
  const lowered = `${candidate.tags.join(" ")} ${candidate.text}`.toLowerCase();

  const signals = detectSignals(lowered);
  const signalScore = signals.reduce((sum, signal) => sum + SIGNAL_WEIGHTS[signal], 0);
  const reflectionPenalty = candidate.memory_type === "reflection" ? 0.04 : 0;
  const scoreBreakdown = {
    recency: recencyScore,
    type: typeScore,
    task: taskScore,
    signal: signalScore,
    tag_diversity: tagDiversityScore,
    reflection_penalty: -reflectionPenalty
  };
  const replayScore = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);

  return {
    ...candidate,
    replay_score: replayScore,
    score_breakdown: scoreBreakdown,
    signals
  };
}

function detectSignals(loweredText: string): Array<keyof ReplaySignalCounts> {
  const out: Array<keyof ReplaySignalCounts> = [];
  for (const [signal, pattern] of Object.entries(SIGNAL_PATTERNS) as Array<[keyof ReplaySignalCounts, RegExp]>) {
    if (pattern.test(loweredText)) {
      out.push(signal);
    }
  }
  return out;
}

function selectTieWindow(
  tieWindow: ScoredReplayCandidate[],
  remainingSlots: number,
  options: ReplaySelectionOptions
): ScoredReplayCandidate[] {
  if (tieWindow.length <= remainingSlots) {
    return tieWindow.slice(0, remainingSlots);
  }

  if (options.mode === "priority_prng") {
    return orderByPseudoRandomTieBreak(tieWindow).slice(0, remainingSlots);
  }

  if (options.mode === "priority_quantum" && options.quantumSample) {
    return orderByQuantumTieBreak(tieWindow, options.quantumSample).slice(0, remainingSlots);
  }

  return tieWindow.slice(0, remainingSlots);
}

function orderByPseudoRandomTieBreak(candidates: ScoredReplayCandidate[]): ScoredReplayCandidate[] {
  const seed = candidates
    .map((candidate) => candidate.id)
    .sort()
    .join("|");
  return [...candidates].sort((left, right) => {
    const leftScore = normalizedHash(`${seed}:${left.id}`);
    const rightScore = normalizedHash(`${seed}:${right.id}`);
    if (leftScore !== rightScore) return rightScore - leftScore;
    return compareScoredCandidates(left, right);
  });
}

function orderByQuantumTieBreak(
  candidates: ScoredReplayCandidate[],
  sample: QuantumEntropySample
): ScoredReplayCandidate[] {
  const quantumSeed = sample.raw_hex.slice(0, 16);
  return [...candidates].sort((left, right) => {
    const leftScore = normalizedHash(`${quantumSeed}:${left.id}`) + sample.unit_interval;
    const rightScore = normalizedHash(`${quantumSeed}:${right.id}`) + sample.unit_interval;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return compareScoredCandidates(left, right);
  });
}

function compareScoredCandidates(left: ScoredReplayCandidate, right: ScoredReplayCandidate): number {
  if (left.replay_score !== right.replay_score) {
    return right.replay_score - left.replay_score;
  }
  if (left.created_at !== right.created_at) {
    return right.created_at.localeCompare(left.created_at);
  }
  return left.id.localeCompare(right.id);
}

function buildDiagnostics(
  strategy: ReplaySelectionDiagnostics["strategy"],
  mode: ReplaySelectionMode,
  selected: ScoredReplayCandidate[],
  candidateCount: number,
  tieWindowSize: number,
  cutoffScore: number | null,
  quantumSample: QuantumEntropySample | null
): ReplaySelectionDiagnostics {
  const topSignals: ReplaySignalCounts = {
    failure: 0,
    contradiction: 0,
    procedure: 0,
    constraint: 0,
    surprise: 0,
    benchmark: 0
  };

  for (const candidate of selected) {
    for (const signal of candidate.signals) {
      topSignals[signal] += 1;
    }
  }

  return {
    mode,
    strategy,
    candidate_count: candidateCount,
    selected_count: selected.length,
    tie_window_size: tieWindowSize,
    cutoff_score: cutoffScore,
    selected_ids: selected.map((candidate) => candidate.id),
    top_signals: topSignals,
    quantum_sample: quantumSample
  };
}

function normalizedHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0) / 0xffffffff;
}
