import type { Candle, DataMode, Entity, Quote, Regime, StrategyDecision } from './domain.js';
export interface OptionAggregate extends Entity {
  instrumentKey: string;
  start: number;
  end: number;
  receivedAt: number;
  mode: DataMode;
  samples: number;
  firstSourceTs: number;
  lastSourceTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bid: number | null;
  ask: number | null;
  cumulativeVolume: number | null;
  observedVolumeChange: number | null;
  oi: number | null;
  oiChange: number | null;
  oiAsOf: number | null;
  maxSpreadPct: number | null;
  quality: string[];
  source: string;
}
export interface StorageCollection {
  name: string;
  count: number;
  dataBytes: number;
  storageBytes: number;
  indexBytes: number;
}
export interface DatabaseStorage {
  measured: boolean;
  collections: StorageCollection[];
  dataBytes: number;
  storageBytes: number;
  indexBytes: number;
  totalBytes: number;
}
export interface StorageReport extends Entity, DatabaseStorage {
  checkedAt: number;
  budgetBytes: number;
  usedPct: number | null;
  dailyGrowthBytes: number | null;
  daysToThreshold: number | null;
  level: 'NORMAL' | 'WARNING' | 'REDUCED' | 'CRITICAL' | 'UNAVAILABLE';
  optionalSnapshotStride: number;
  retention: {
    status: 'NOT_RUN' | 'OK' | 'DEGRADED' | 'FAILED';
    checkedAt: number | null;
    armed: number;
    pending: number;
  };
}
export type Participation =
  | 'STRONG_UPWARD'
  | 'STRONG_DOWNWARD'
  | 'WEAK'
  | 'ABNORMAL_NON_DIRECTIONAL'
  | 'POSSIBLE_BREAKOUT'
  | 'POSSIBLE_FALSE_BREAKOUT'
  | 'VOLUME_EXHAUSTION'
  | 'PRICE_VOLUME_DIVERGENCE'
  | 'INCONCLUSIVE'
  | 'UNAVAILABLE';
export interface AdvancedVolume {
  asOf: number;
  version: string;
  instrumentKey: string;
  sampleCount: number;
  lookback: number;
  volumeMean: number | null;
  volumeStdDev: number | null;
  volumeZScore: number | null;
  volumeAcceleration: number | null;
  obv: number | null;
  accumulationDistribution: number | null;
  vwap: number | null;
  vwapDeviationPct: number | null;
  divergence: 'BULLISH' | 'BEARISH' | 'NONE' | 'UNAVAILABLE';
  breakout: 'UP' | 'DOWN' | 'NONE' | 'UNAVAILABLE';
  falseBreakout: 'UPPER_REJECTED' | 'LOWER_REJECTED' | 'NONE' | 'UNAVAILABLE';
  participation: Participation;
  sectorRelativeParticipation: number | null;
  quality: string[];
  methodology: string;
}
export interface MarketFeatureRecord extends Entity {
  instrumentKey: string;
  asOf: number;
  mode: DataMode;
  advanced: AdvancedVolume;
}
export interface StrategyAssessment extends StrategyDecision {
  status: 'ELIGIBLE' | 'REJECTED' | 'INSUFFICIENT_DATA' | 'DATA_UNAVAILABLE';
  asOf: number;
}
export interface StrategyRecord extends Entity {
  runId: string;
  instrumentKey: string;
  asOf: number;
  regime: Regime;
  decisions: StrategyAssessment[];
}
export interface NewsBriefing extends Entity {
  day: string;
  cutoff: number;
  createdAt: number;
  version: string;
  status: 'READY' | 'DEGRADED' | 'UNAVAILABLE';
  model: string | null;
  sourceIds: string[];
  sources: {
    id: string;
    headline: string;
    summary: string;
    url: string;
    publishedAt: number;
    receivedAt: number;
    official: boolean;
  }[];
  clusters: { id: string; sourceIds: string[]; officialSourceIds: string[]; instrumentKeys: string[] }[];
  events: {
    category: string;
    summary: string;
    sourceIds: string[];
    evidence: { sourceId: string; quote: string }[];
    instrumentKeys: string[];
    verification: 'OFFICIAL_SOURCE' | 'ATTRIBUTED_UNVERIFIED';
  }[];
  failures: string[];
}
export type OutcomeStatus =
  | 'TARGET_BEFORE_STOP'
  | 'STOP_BEFORE_TARGET'
  | 'NEITHER_HIT'
  | 'AMBIGUOUS'
  | 'INVALIDATED'
  | 'DATA_UNAVAILABLE'
  | 'ENTRY_NOT_REACHED';
export interface ResearchOutcome extends Entity {
  signalId: string;
  candidateAt: number;
  horizonEnd: number;
  evaluatedAt: number;
  status: OutcomeStatus;
  entryReachedAt: number | null;
  targetAt: number | null;
  stopAt: number | null;
  paperFilled: boolean;
  evidenceCount: number;
  maxObservationGapMs: number | null;
  methodology: string;
  regime: Regime;
  strategyId: string;
}
export interface ValidationSample {
  id: string;
  signalAt: number;
  horizonEnd: number;
  availableAt: number;
  label: 0 | 1;
  regime: Regime;
  features: Record<string, number | null>;
  grossPnl: number | null;
  fees: number | null;
  slippage: number | null;
}
export interface ValidationReport extends Entity {
  createdAt: number;
  modelVersion: string;
  validated: boolean;
  report: Record<string, unknown>;
}
export interface InMemoryMinute {
  bucket: number;
  quote: Quote;
}
export interface RetentionCheckpoint extends Entity {
  instrumentKey: string;
  day: string;
  checkedAt: number;
  status: 'READY' | 'INCOMPLETE';
  sourceCount: number;
  aggregateIds: string[];
}
export interface IncrementalVolumeState {
  rows: Candle[];
  lastStart: number;
}
