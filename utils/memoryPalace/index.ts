/**
 * Memory Palace (記憶宮殿) — 統一導出
 */

// 類型
export type {
    MemoryRoom, RoomConfig, MemoryEntity, MemoryNode, MemoryVector,
    LinkType, MemoryLink, BoxStatus, TopicBox, TopicContinuity,
    AnticipationStatus, Anticipation, MemoryBatch,
    PersonalityStyle, EmbeddingConfig, ScoredMemory, RemoteVectorConfig,
    EventBox, PlateRoom, PlateEntry, RoomPlate,
    DigestReport, DigestReportSection,
} from './types';

export { ROOM_CONFIGS, ROOM_LABELS, getRoomLabel, PERSONALITY_WEIGHTS, EVENT_BOX_COMPRESSION_THRESHOLD, PLATE_ROOMS, PLATE_TITLES, PLATE_ENTRY_CAPS } from './types';

// 數據庫
export { MemoryNodeDB, MemoryVectorDB, MemoryLinkDB, MemoryBatchDB, TopicBoxDB, AnticipationDB, EventBoxDB, RoomPlateDB, DigestReportDB } from './db';

// Embedding
export { getEmbedding, getEmbeddings, cosineSimilarity } from './embedding';

// Rerank（cross-encoder 二次排序，作為主召回的獨立增強通道）
export { rerankDocuments } from './rerank';
export type { RerankApiConfig, RerankResult } from './rerank';

// 輸入管線
export { extractMemoriesFromBuffer } from './extraction';
export { vectorizeAndStore, updateStoredMemoryNode, checkModelConsistency, rebuildAllVectors } from './vectorStore';
export type { UpdateStoredMemoryNodeResult } from './vectorStore';

// 認知過程
export { runConsolidation, calculateEffectiveImportance, shouldPromote } from './consolidation';
export { buildLinks, strengthenCoActivated } from './links';

// 輸出管線
export { vectorSearch } from './vectorSearch';
export { bm25Search, tokenize } from './bm25';
export {
    analyzeExplicitEntitySignals,
    lookupExplicitEntityCandidates,
    mergeExplicitEntityCandidates,
    normalizeEntityKey,
} from './explicitEntityRecall';
export type {
    ExplicitEntityAnalysis,
    ExplicitEntityCandidate,
    ExplicitEntitySignal,
    ExplicitEntitySignalSource,
} from './explicitEntityRecall';
export {
    buildEventBoxLightIndex,
    lookupEventBoxLightCandidates,
    mergeEventBoxLightCandidates,
    normalizeEventBoxIndexText,
} from './eventBoxLightIndex';
export type {
    EventBoxLightCandidate,
    EventBoxLightIndex,
    EventBoxLightLookupResult,
    EventBoxLightMatchSource,
} from './eventBoxLightIndex';
export { hybridSearch } from './hybridSearch';
export { spreadActivation } from './activation';
export { applyPriming, checkRumination } from './priming';
export { expandAndFormat } from './formatter';
export { formatMemoryDateWithDistance } from './memoryDate';

// 集成
export type { LightLLMConfig, PipelineResult, DiaryIngestResult } from './pipeline';
export { retrieveMemories, injectMemoryPalace, processNewMessages, getMemoryPalaceHighWaterMark, ingestDiaryToPalace } from './pipeline';
export { RECALL_PIPELINE_VERSION, readRecallRuntimeSnapshot } from './trace';
export type { EventBoxMetadataRecallTrace, RecallEntryPoint, RecallFailureReason, RecallOutcome, RecallTrace, RecallRetrievalTelemetry } from './trace';
export {
    analyzeLocalContext,
    evaluateLocalRecallGate,
    renderLocalContextGuidance,
    normalizeRecallPlan,
    runLightRecallRouter,
} from './recallRouter';
export {
    analyzeUserInteraction,
    renderInteractionAdaptationGuidance,
    resolveAccommodationPolicy,
    DEFAULT_CHARACTER_ACCOMMODATION,
    INTERACTION_TREND_MESSAGE_SCAN_LIMIT,
    INTERACTION_TREND_TURN_LIMIT,
} from './interactionAdaptation';
export {
    analyzeDeepEngagement,
    renderDeepEngagementGuidance,
} from './deepEngagement';
export type {
    ConversationDepthSignals,
    ConversationDepthState,
    DeepEngagementAnalysis,
    EngagementMode,
} from './deepEngagement';
export {
    advanceConversationEngagement,
    analyzeConversationEngagement,
    clearConversationEngagementState,
    loadConversationEngagementState,
    renderConversationEngagementGuidance,
    saveConversationEngagementState,
    shouldUseLegacyDeepEngagement,
    CONVERSATION_ENGAGEMENT_ENGINE_KEY,
    CONVERSATION_ENGAGEMENT_STORAGE_PREFIX,
    CONVERSATION_ENGAGEMENT_VERSION,
} from './conversationEngagement';
export type {
    ActiveConversationSubject,
    ConversationAct,
    ConversationEngagementAdvanceResult,
    ConversationEngagementAnalysis,
    ConversationEngagementReason,
    ConversationInteractionMode,
    EngagementState,
    GroundedConversationFact,
    ProgressiveConversationStance,
    ResponseAct,
    ResponsePlan,
    StoredConversationEngagementState,
    SubjectHook,
    SubjectHookKind,
} from './conversationEngagement';
export type {
    InteractionSurfaceState,
    ResolvedAccommodationPolicy,
    UserInteractionAnalysis,
} from './interactionAdaptation';
export type {
    ContextSignals,
    LocalContextAnalysis,
    LocalRecallGateResult,
    RecallGateFeatures,
    RecallPlan,
    RecallQuery,
    RecallQueryScope,
    RecallQuerySource,
    RecallRouterExecutionResult,
    RecallRouterExecutionStatus,
    RecallRouterTrace,
} from './recallRouter';
export {
    DEFAULT_MEMORY_PALACE_WATERLINE,
    MEMORY_PALACE_WATERLINE_PRESETS,
    MIN_MEMORY_HOT_ZONE_SIZE,
    MAX_MEMORY_HOT_ZONE_SIZE,
    MIN_MEMORY_BUFFER_THRESHOLD,
    MAX_MEMORY_BUFFER_THRESHOLD,
    resolveMemoryPalaceWaterline,
    makeCustomMemoryPalaceWaterline,
} from './waterline';
export type { ResolvedMemoryPalaceWaterline } from './waterline';

// 期盼
export {
    processAnticipationLifecycle, fulfillAnticipation,
    disappointAnticipation, createAnticipation,
} from './anticipation';

// 認知消化
export { runCognitiveDigestion, incrementDigestRound, getDigestRoundCount, getLastDigestTs, detectPersonalityStyle } from './digestion';
export type { DigestResult } from './digestion';

// 遷移
export { migrateOldMemories, getAvailableMonths, getAvailableChunks } from './migration';
export type { MigrationProgress } from './migration';

// EventBox（事件盒：替代舊的 boxId 批次盒）
export {
    bindMemoriesIntoEventBox, manuallyBindMemories,
    removeMemoryFromBox, reviveArchivedMemory,
    unbindAllLiveMemories,
} from './eventBox';
export {
    maybeCompressEventBoxes, compressAllEligibleBoxes,
    regenerateEventBoxSummary, hasSummaryReasoningLeak,
} from './eventBoxCompression';
export type { RegenerateEventBoxSummaryResult } from './eventBoxCompression';

// 房間門牌（情景→語義固化層）
export {
    consolidateAllPlates, updatePlateFromBoxSummary,
    buildRoomPlatesInjection, formatRoomPlatesSection, isPlateRoom,
    bootstrapPlatesFromHistory, arePlatesEmpty,
    isPlateBootstrapDone, markPlateBootstrapDone,
    getBootstrapResume, setBootstrapResume, clearBootstrapResume,
} from './roomPlates';

// 一鍵清空（本地 + 雲端）
export { wipeAllMemoryPalace } from './wipe';
export type { WipeResult } from './wipe';

// 導出 / 導入（接入外置記憶庫、跨設備遷移用）
export { exportMemoryPalace, importMemoryPalace, isMemoryPalaceExportFile } from './export';
export type { MemoryPalaceExportFile, CharacterMemoryPalaceExport, ExportedVector, ImportResult } from './export';
