//! Mod Recommendations Engine
//!
//! Provides intelligent mod recommendations based on installed mods.
//! Uses Modrinth API to find related and popular mods.

use crate::api::modrinth::ModrinthClient;
use crate::error::{LauncherError, Result};
use crate::mods::ModManager;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Reason why a mod is being recommended
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RecommendationReason {
    /// Mod is popular in the same category as installed mods
    SameCategory { category: String },
    /// Mod is frequently used together with installed mods
    PopularWith { mod_names: Vec<String> },
    /// Mod is an addon/extension for an installed mod
    AddonFor { mod_name: String },
    /// Mod is trending for this Minecraft version
    Trending,
    /// Mod is popular optimization mod
    Optimization,
    /// Mod is a popular library that many mods depend on
    CommonDependency,
}

/// A recommended mod with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModRecommendation {
    /// Modrinth slug
    pub slug: String,
    /// Display name
    pub name: String,
    /// Short description
    pub description: String,
    /// Icon URL
    pub icon_url: Option<String>,
    /// Total downloads
    pub downloads: u64,
    /// Follower count
    pub follows: u64,
    /// Author name
    pub author: String,
    /// Categories
    pub categories: Vec<String>,
    /// Why this mod is recommended
    pub reason: RecommendationReason,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
}

/// Configuration for recommendations
#[derive(Debug, Clone)]
pub struct RecommendationConfig {
    /// Maximum number of recommendations to return
    pub limit: usize,
    /// Minecraft version filter
    pub minecraft_version: String,
    /// Loader filter (fabric, forge, etc.)
    pub loader: String,
}

/// Mod Recommendations Engine
pub struct RecommendationEngine;

impl RecommendationEngine {
    /// Get mod recommendations based on installed mods
    pub async fn get_recommendations(
        instance_id: &str,
        config: RecommendationConfig,
    ) -> Result<Vec<ModRecommendation>> {
        log::info!(
            "Getting recommendations for instance {} (MC: {}, Loader: {})",
            instance_id,
            config.minecraft_version,
            config.loader
        );

        // 1. Get installed mods
        let installed_mods = ModManager::list_mods(instance_id)?;
        let installed_slugs: HashSet<String> =
            installed_mods.iter().map(|m| m.slug.clone()).collect();

        log::info!("Found {} installed mods", installed_mods.len());

        // 2. Collect categories from Modrinth mods
        let mut category_counts: HashMap<String, u32> = HashMap::new();
        let mut modrinth_mods: Vec<String> = Vec::new();

        for m in &installed_mods {
            if m.source == "modrinth" {
                modrinth_mods.push(m.slug.clone());
            }
        }

        // Fetch categories for installed Modrinth mods
        for slug in &modrinth_mods {
            if let Ok(project) = ModrinthClient::get_project(slug).await {
                for cat in &project.categories {
                    // Skip loader categories
                    if !["fabric", "forge", "neoforge", "quilt"].contains(&cat.as_str()) {
                        *category_counts.entry(cat.clone()).or_insert(0) += 1;
                    }
                }
            }
        }

        log::info!("Collected categories: {:?}", category_counts);

        // 3. Get top categories (most common among installed mods)
        let mut top_categories: Vec<(String, u32)> = category_counts.into_iter().collect();
        top_categories.sort_by(|a, b| b.1.cmp(&a.1));
        let top_categories: Vec<String> =
            top_categories.into_iter().take(5).map(|(c, _)| c).collect();

        // 4. Search for popular mods in each category
        let mut recommendations: Vec<ModRecommendation> = Vec::new();
        let mut seen_slugs: HashSet<String> = installed_slugs.clone();

        let client = ModrinthClient::new();

        // Search in top categories
        for category in &top_categories {
            let search_results = Self::search_by_category(
                &client,
                category,
                &config.minecraft_version,
                &config.loader,
                10,
            )
            .await;

            if let Ok(results) = search_results {
                for hit in results {
                    if !seen_slugs.contains(&hit.slug) {
                        seen_slugs.insert(hit.slug.clone());
                        recommendations.push(ModRecommendation {
                            slug: hit.slug,
                            name: hit.title,
                            description: hit.description,
                            icon_url: hit.icon_url,
                            downloads: hit.downloads,
                            follows: hit.follows,
                            author: hit.author,
                            categories: hit.categories.clone(),
                            reason: RecommendationReason::SameCategory {
                                category: category.clone(),
                            },
                            confidence: Self::calculate_confidence(hit.downloads, hit.follows),
                        });
                    }
                }
            }
        }

        // 5. Add trending/popular mods if we don't have enough
        if recommendations.len() < config.limit {
            let trending = Self::get_trending_mods(
                &client,
                &config.minecraft_version,
                &config.loader,
                config.limit,
            )
            .await;

            if let Ok(results) = trending {
                for hit in results {
                    if !seen_slugs.contains(&hit.slug) {
                        seen_slugs.insert(hit.slug.clone());

                        // Determine reason based on categories
                        let reason = if hit.categories.contains(&"optimization".to_string()) {
                            RecommendationReason::Optimization
                        } else if hit.categories.contains(&"library".to_string()) {
                            RecommendationReason::CommonDependency
                        } else {
                            RecommendationReason::Trending
                        };

                        recommendations.push(ModRecommendation {
                            slug: hit.slug,
                            name: hit.title,
                            description: hit.description,
                            icon_url: hit.icon_url,
                            downloads: hit.downloads,
                            follows: hit.follows,
                            author: hit.author,
                            categories: hit.categories,
                            reason,
                            confidence: Self::calculate_confidence(hit.downloads, hit.follows),
                        });
                    }
                }
            }
        }

        // 6. Sort by confidence and limit
        recommendations.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        recommendations.truncate(config.limit);

        log::info!("Returning {} recommendations", recommendations.len());
        Ok(recommendations)
    }

    /// Search mods by category using facets
    async fn search_by_category(
        _client: &ModrinthClient,
        category: &str,
        minecraft_version: &str,
        loader: &str,
        limit: u32,
    ) -> Result<Vec<crate::api::modrinth::ModrinthSearchHit>> {
        // Use faceted search with category filter
        let facets = format!(
            "[[\"project_type:mod\"],[\"versions:{}\"],[\"categories:{}\"],[\"categories:{}\"]]",
            minecraft_version, loader, category
        );

        let url = reqwest::Url::parse_with_params(
            "https://api.modrinth.com/v2/search",
            &[
                ("facets", facets.as_str()),
                ("limit", &limit.to_string()),
                ("index", "downloads"), // Sort by downloads
            ],
        )
        .map_err(|e| LauncherError::ApiError(format!("URL build error: {}", e)))?;

        let result: crate::api::modrinth::ModrinthSearchResult =
            crate::downloader::fetch_json(url.as_str()).await?;

        Ok(result.hits)
    }

    /// Get trending/popular mods
    async fn get_trending_mods(
        client: &ModrinthClient,
        minecraft_version: &str,
        loader: &str,
        limit: usize,
    ) -> Result<Vec<crate::api::modrinth::ModrinthSearchHit>> {
        // Search popular mods for this version/loader
        let result = client
            .search_mods("", Some(minecraft_version), Some(loader), limit as u32, 0)
            .await?;

        Ok(result.hits)
    }

    /// Calculate confidence score based on downloads and follows
    fn calculate_confidence(downloads: u64, follows: u64) -> f32 {
        // Logarithmic scale for downloads (1M+ downloads = high confidence)
        let download_score = (downloads as f64 + 1.0).log10() / 7.0; // log10(10M) ≈ 7

        // Logarithmic scale for follows (10K+ follows = high confidence)
        let follow_score = (follows as f64 + 1.0).log10() / 5.0; // log10(100K) ≈ 5

        // Weighted average (downloads more important)
        let score = (download_score * 0.7 + follow_score * 0.3) as f32;

        // Clamp to 0.0 - 1.0
        score.clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_confidence() {
        // Low downloads/follows
        let low = RecommendationEngine::calculate_confidence(100, 10);
        assert!(low > 0.0 && low < 0.5);

        // Medium downloads/follows
        let medium = RecommendationEngine::calculate_confidence(100_000, 1_000);
        assert!(medium > 0.3 && medium < 0.8);

        // High downloads/follows (like Sodium)
        let high = RecommendationEngine::calculate_confidence(10_000_000, 50_000);
        assert!(high > 0.7);
    }

    #[test]
    fn test_recommendation_reason_serialization() {
        let reason = RecommendationReason::SameCategory {
            category: "technology".to_string(),
        };
        let json = serde_json::to_string(&reason).unwrap();
        assert!(json.contains("same_category"));
        assert!(json.contains("technology"));
    }
}
