//! Download Manager - re-exports SmartDownloader for backwards compatibility
//!
//! This module is deprecated. Use `smart_downloader::SmartDownloader` directly.

pub use crate::smart_downloader::{
    fetch_json, DownloadConfig, DownloadProgress, DownloadSemaphores, DownloadStatus,
    DownloadTask, MirrorInfo, MirrorRegistry, MirrorRule, ResourceType,
    SmartDownloader as DownloadManager,
};
