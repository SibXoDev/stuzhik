pub mod error;
pub mod i18n;
pub mod types;

// Re-export commonly used items
pub use error::{ErrorInfo, LauncherError, Result};
pub use i18n::Language;
pub use types::{
    // Log analyzer types
    AffectedLevel,
    AnalysisReport,
    AnalysisSummary,
    AutoFix,
    ClassAnalysisResult,
    CrashInfo,
    // Instance types
    CreateInstanceRequest,
    DetectedProblem,
    ErrorChainAnalysis,
    ErrorGroup,
    Instance,
    InstanceStatus,
    InstanceType,
    LagSpike,
    LoaderType,
    LogAnalysisResult,
    LogFileInfo,
    MemoryIssue,
    MemoryIssueType,
    Mod,
    ModDependency,
    ModInfo,
    ModSource,
    Optimization,
    PerformanceAnalysis,
    ProblemCategory,
    ProblemStatus,
    Severity,
    SlowMod,
    Solution,
    SolutionDifficulty,
    SystemInfo,
    TpsIssue,
};
