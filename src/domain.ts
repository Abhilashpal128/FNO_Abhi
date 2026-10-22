import type {
  OptionAggregate,
  StorageReport,
  MarketFeatureRecord,
  StrategyRecord,
  NewsBriefing,
  ResearchOutcome,
  ValidationReport,
  RetentionCheckpoint,
  AdvancedVolume,
} from './advanced-domain.js';
export type DataMode = 'live' | 'historical' | 'demo';
export type Direction = 'BULLISH' | 'BEARISH';
export type Regime =
  | 'BULLISH_TRENDING'
  | 'BEARISH_TRENDING'
  | 'SIDEWAYS'
  | 'HIGH_VOLATILITY'
  | 'NEWS_DRIVEN'
  | 'INSUFFICIENT_DATA';
export type SignalStatus =
  | 'WATCHING'
  | 'TRIGGERED'
  | 'MONITORING'
  | 'TARGET_1_HIT'
  | 'TARGET_2_HIT'
  | 'STOPPED'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'REJECTED'
  | 'DATA_UNAVAILABLE';
export interface Entity {
  id: string;
}
export interface Instrument extends Entity {
  name: string;
  tradingSymbol: string;
  kind: 'INDEX' | 'EQUITY' | 'FUT' | 'CE' | 'PE';
  underlyingKey: string;
  underlyingType: 'INDEX' | 'EQUITY';
  expiry: string | null;
  strike: number | null;
  lotSize: number;
  tickSize: number;
  active: boolean;
  asOf: number;
  mode: DataMode;
  sector: string | null;
  rawTickSize?: number;
}
export interface Candle extends Entity {
  instrumentKey: string;
  interval: number;
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  oi: number | null;
  complete: boolean;
  quality: string[];
  source: string;
  receivedAt: number;
  mode: DataMode;
}
export interface Quote extends Entity {
  instrumentKey: string;
  ltp: number;
  bid: number | null;
  ask: number | null;
  bidQty: number;
  askQty: number;
  cumulativeVolume: number | null;
  oi: number | null;
  previousOi: number | null;
  oiAsOf: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  iv: number | null;
  sourceTs: number;
  receivedAt: number;
  lastTradeTs: number;
  mode: DataMode;
  quality: string[];
}
export interface VolumeProfile extends Entity {
  instrumentKey: string;
  day: string;
  minute: number;
  interval: number;
  volume: number;
  valid: boolean;
  receivedAt: number;
  mode: DataMode;
}
export interface VolumeFeatures {
  asOf: number;
  methodology: string;
  volumeInstrumentKey: string;
  openingFiveMinuteVolume: number | null;
  openingFiveMinuteRvol: number | null;
  intervalVolume: number | null;
  sameTimeHistoricalAverageVolume: number | null;
  volumeSpikeRatio: number | null;
  baselineSamples: number;
  volumeTrend: 'EXPANDING' | 'DECLINING' | 'FLAT' | 'UNKNOWN';
  priceVolumeRelationship: string;
  vwap: number | null;
  volumeConfirmationStatus: 'CONFIRMED' | 'UNCONFIRMED' | 'INSUFFICIENT_DATA';
  dataQualityFlags: string[];
}
export interface NewsItem extends Entity {
  summary?: string;
  sectors?: string[];
  clusterId?: string;
  headline: string;
  url: string;
  source: string;
  publishedAt: number;
  receivedAt: number;
  instrumentKeys: string[];
  classification: 'EARNINGS' | 'POLICY' | 'CORPORATE' | 'GENERAL';
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  sentimentMethod: string | null;
  official: boolean;
  mode: DataMode;
}
export interface MarketSession extends Entity {
  day: string;
  open: number;
  close: number;
  trading: boolean;
  verified: boolean;
  source: string;
  receivedAt: number;
}
export interface MarketEvent extends Entity {
  title: string;
  start: number;
  end: number;
  instrumentKeys: string[];
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  publishedAt: number;
  receivedAt: number;
  source: string;
}
export interface TechnicalFeatures {
  sma: number | null;
  ema: number | null;
  rsi: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  atr: number | null;
  adx: number | null;
  bollinger: { lower: number; middle: number; upper: number } | null;
  support: number | null;
  resistance: number | null;
  momentum: number | null;
}
export interface StrategyDecision {
  strategyId: string;
  version: string;
  direction: Direction | null;
  underlyingEntry: number | null;
  invalidation: number | null;
  target1: number | null;
  target2: number | null;
  reasons: string[];
  conflicts: string[];
}
export interface Scenario {
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
  quantity: number;
  oneLotCapital: number;
  plannedLoss: number;
  estimatedCosts: number;
  rewardRisk: number;
  methodology: string;
  underlyingInvalidation: number;
}
export interface Opportunity extends Entity {
  advanced?: AdvancedVolume;
  newsFeatures?: { asOf: number; officialCount: number | null; sentiment: number | null };
  day: string;
  slot: number;
  analysisRunId: string;
  createdAt: number;
  expiresAt: number;
  mode: DataMode;
  underlying: Instrument;
  contract: Instrument;
  underlyingPrice: number;
  quote: Quote;
  scenario: Scenario;
  volume: VolumeFeatures;
  technical: TechnicalFeatures;
  regime: Regime;
  strategy: StrategyDecision;
  ranking: { rvol: number; rewardRisk: number; spreadPct: number; rankMethod: string };
  probability: number | null;
  newsIds: string[];
  reasons: string[];
  warnings: string[];
  riskStatus: 'ACCEPTED';
  snapshotHash: string;
}
export interface SignalEvent extends Entity {
  signalId: string;
  timestamp: number;
  status: SignalStatus;
  reason: string;
  quoteId: string | null;
}
export interface AnalysisRun extends Entity {
  day: string;
  scheduledFor: number;
  analyzedAt: number;
  kind: 'INITIAL' | 'REEVALUATION' | 'DEEP' | 'MANUAL';
  status: 'OPPORTUNITIES' | 'NO_TRADE' | 'INSUFFICIENT_DATA';
  mode: DataMode;
  signalIds: string[];
  activeSignalIds: string[];
  signalStatuses: { id: string; status: SignalStatus; riskStatus: 'ACCEPTED' }[];
  rejections: { instrumentKey: string; reasons: string[] }[];
  qualityLimitations: string[];
  dataFreshness: {
    newestQuoteAt: number | null;
    oldestRequiredQuoteAt: number | null;
    maxAgeMs: number;
    status: 'LIVE' | 'DELAYED' | 'DEMO' | 'UNAVAILABLE';
  };
  nextScheduledAt: number | null;
  volume: VolumeFeatures[];
}
export interface PaperTrade extends Entity {
  signalId: string;
  instrumentKey: string;
  underlyingKey: string;
  correlationGroup: string;
  day: string;
  openedAt: number;
  quantity: number;
  lots: number;
  entry: number;
  entryFee: number;
  stop: number;
  target1: number;
  target2: number;
  plannedRisk: number;
  status: 'OPEN' | 'CLOSED';
  exit: number | null;
  exitFee: number | null;
  closedAt: number | null;
  pnl: number | null;
  closeReason: string | null;
  mode: DataMode;
  requestKey: string;
}
export interface Execution extends Entity {
  tradeId: string;
  timestamp: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  fee: number;
  quoteId: string;
  method: string;
}
export interface PrivateAccount extends Entity {
  capital: number;
  cash: number;
  realizedPnl: number;
  updatedAt: number;
  revision: number;
}
export interface RiskSettings extends Entity {
  globalNoTrade: boolean;
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxAggregateRisk: number;
  maxCorrelatedRisk: number;
  maxDailyOpportunities: number;
  updatedAt: number;
}
export interface Job extends Entity {
  scheduledFor: number;
  kind: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  owner: string;
  leaseUntil: number;
  attempts: number;
  finishedAt: number | null;
  error: string | null;
}
export interface Health extends Entity {
  status: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
  checkedAt: number;
  details: string[];
}
export interface VersionRecord extends Entity {
  name: string;
  version: string;
  createdAt: number;
  validated: boolean;
  details: Record<string, unknown>;
}
export interface RegimeRecord extends Entity {
  instrumentKey: string;
  asOf: number;
  regime: Regime;
  technical: TechnicalFeatures;
  mode: DataMode;
}
export interface BacktestRun extends Entity {
  ablations?: { withoutVolume: Performance; withoutNews: Performance; withoutVolumeOrNews: Performance };
  evaluation?: {
    decisions: number;
    eligible: number;
    filled: number;
    noFill: number;
    unresolved: number;
    grossPnl: number;
    feesAndSlippage: number;
    averageWin: number | null;
    averageLoss: number | null;
    worstLosingStreak: number;
    coverage: number | null;
  };
  createdAt: number;
  status: 'COMPLETE' | 'INSUFFICIENT_DATA';
  from: number;
  to: number;
  mode: DataMode;
  strategyVersion: string;
  metrics: Performance;
  trades: BacktestTrade[];
  limitations: string[];
  baseline: Performance;
}
export interface BacktestTrade {
  grossPnl?: number;
  fees?: number;
  slippage?: number;
  signalAt: number;
  entryAt: number;
  exitAt: number;
  entry: number;
  exit: number;
  quantity: number;
  pnl: number;
  reason: string;
  regime: Regime;
}
export interface Performance {
  trades: number;
  netPnl: number;
  winRate: number | null;
  expectancy: number | null;
  maxDrawdown: number;
  profitFactor: number | null;
}
export interface Collections {
  option_aggregates: OptionAggregate;
  storage_health: StorageReport;
  retention_checkpoints: RetentionCheckpoint;
  market_features: MarketFeatureRecord;
  strategy_decisions: StrategyRecord;
  news_briefings: NewsBriefing;
  research_outcomes: ResearchOutcome;
  validation_reports: ValidationReport;
  instruments: Instrument;
  instrument_versions: InstrumentVersion;
  event_calendar_versions: EventCalendarVersion;
  market_candles: Candle;
  market_volume_profiles: VolumeProfile;
  option_snapshots: Quote;
  market_news: NewsItem;
  market_sessions: MarketSession;
  market_events: MarketEvent;
  market_regimes: RegimeRecord;
  analysis_runs: AnalysisRun;
  trade_signals: Opportunity;
  signal_events: SignalEvent;
  paper_trades: PaperTrade;
  paper_trade_executions: Execution;
  private_accounts: PrivateAccount;
  risk_settings: RiskSettings;
  data_ingestion_checkpoints: Job;
  system_health: Health;
  strategy_definitions: VersionRecord;
  strategy_versions: VersionRecord;
  model_versions: VersionRecord;
  model_performance: VersionRecord;
  backtest_runs: BacktestRun;
}
export type Collection = keyof Collections;
export interface InstrumentVersion extends Entity {
  instrumentKey: string;
  asOf: number;
  instrument: Instrument;
  mode: DataMode;
}
export interface EventCalendarVersion extends Entity {
  validFrom: string;
  validUntil: string;
  source: string;
  receivedAt: number;
  events: MarketEvent[];
}
