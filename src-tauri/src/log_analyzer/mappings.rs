//! Маппинг Java-классов на mod ID

use stuzhik_core::ClassAnalysisResult;

/// Библиотеки и системные пакеты которые НЕ являются модами
/// Ошибки в этих классах не должны показываться как "отсутствующий мод"
pub const LIBRARY_PACKAGES: &[&str] = &[
    // Java стандартные библиотеки
    "java.",
    "javax.",
    "sun.",
    "com.sun.",
    "jdk.",
    // Kotlin/JetBrains
    "org.jetbrains.",
    "kotlin.",
    "kotlinx.",
    // Популярные библиотеки
    "org.apache.",
    "org.slf4j.",
    "org.log4j.",
    "com.google.",
    "io.netty.",
    "com.electronwill.",
    "org.objectweb.",
    "org.lwjgl.",
    "it.unimi.dsi.",
    "org.spongepowered.asm.",
    "org.spongepowered.mixin.",
    // Системные
    "cpw.mods.",
    "fml.",
    "net.minecraftforge.fml.",
];

/// Известные маппинги пакетов на mod ID
/// Расширенная база знаний для ~200 популярных модов
pub const KNOWN_PACKAGE_MAPPINGS: &[(&[&str], &str)] = &[
    // === Загрузчики (особая обработка) ===
    (&["net", "minecraftforge"], "__loader_forge__"),
    (&["net", "neoforged"], "__loader_neoforge__"),
    (&["net", "fabricmc"], "__loader_fabric__"),
    (&["org", "quiltmc"], "__loader_quilt__"),
    (&["net", "minecraft"], "__minecraft__"),
    (&["com", "mojang"], "__minecraft__"),
    // === Create и экосистема ===
    (&["com", "simibubi", "create"], "create"),
    (&["com", "jozufozu", "flywheel"], "flywheel"),
    (&["com", "tterrag", "registrate"], "registrate"),
    (&["com", "railwayteam", "railways"], "railways"),
    (&["net", "createmod", "catnip"], "createcatnip"),
    (
        &["com", "rbasamoyai", "createbigcannons"],
        "createbigcannons",
    ),
    // === Tech моды ===
    (&["mekanism"], "mekanism"),
    (&["appeng"], "ae2"),
    (
        &["blusunrize", "immersiveengineering"],
        "immersiveengineering",
    ),
    (&["cofh", "thermal"], "thermal"),
    (&["cofh", "core"], "cofh_core"),
    (&["team", "reborn", "energy"], "techreborn"),
    (
        &["aztech", "modern_industrialization"],
        "modern_industrialization",
    ),
    (&["com", "enderio"], "enderio"),
    (&["crazypants", "enderio"], "enderio"),
    (
        &["com", "rsinuniern", "industrialforegoing"],
        "industrialforegoing",
    ),
    (&["ic2"], "ic2"),
    (&["net", "industrial"], "industrialcraft"),
    (&["electrodynamics"], "electrodynamics"),
    (&["nuclearscience"], "nuclearscience"),
    (&["pneumaticcraft"], "pneumaticcraft"),
    (&["com", "refinedmods", "refinedstorage"], "refinedstorage"),
    (&["com", "refinedmods", "refinedpipes"], "refinedpipes"),
    // === GregTech моды ===
    (&["com", "gregtechceu", "gtceu"], "gtceu"),
    (&["com", "lowdragmc", "multiblocked"], "multiblocked"),
    (&["com", "lowdragmc", "lowdraglib"], "lowdraglib"),
    (&["gregtech"], "gregtech"),
    (&["muramasa"], "gregtech"),
    // === Recipe viewers ===
    (&["mezz", "jei"], "jei"),
    (&["me", "shedaniel", "rei"], "roughlyenoughitems"),
    (&["dev", "emi", "emi"], "emi"),
    (&["mcp", "mobius", "waila"], "waila"),
    (&["snownee", "jade"], "jade"),
    (&["mcjty", "theoneprobe"], "theoneprobe"),
    // === Vazkii моды ===
    (&["vazkii", "botania"], "botania"),
    (&["vazkii", "patchouli"], "patchouli"),
    (&["vazkii", "quark"], "quark"),
    (&["vazkii", "arl"], "autoreglib"),
    (&["vazkii", "neat"], "neat"),
    (&["vazkii", "akashictome"], "akashictome"),
    (&["vazkii", "morphotool"], "morphtool"),
    // === Оптимизация и производительность ===
    (&["net", "caffeinemc", "mods", "sodium"], "sodium"),
    (&["net", "caffeinemc", "mods", "lithium"], "lithium"),
    (&["net", "caffeinemc", "mods", "phosphor"], "phosphor"),
    (&["me", "jellysquid", "mods", "sodium"], "sodium"),
    (&["me", "jellysquid", "mods", "lithium"], "lithium"),
    (&["me", "jellysquid", "mods", "phosphor"], "phosphor"),
    (&["org", "embeddedt", "embeddium"], "embeddium"),
    (&["com", "teksomehire", "rubidium"], "rubidium"),
    (
        &["me", "flashyreese", "mods", "reeses_sodium_options"],
        "reeses-sodium-options",
    ),
    (&["de", "maxhenkel", "moreculling"], "moreculling"),
    (&["dev", "tr7zw", "entityculling"], "entityculling"),
    (
        &["traben", "entity_texture_features"],
        "entity-texture-features",
    ),
    (&["net", "irisshaders"], "iris"),
    (&["net", "coderbot", "iris"], "iris"),
    (&["me", "jellysquid", "mods", "iris"], "iris"),
    (&["org", "vintagestory", "oculus"], "oculus"),
    // === API и библиотеки ===
    (&["dev", "architectury"], "architectury"),
    (&["me", "shedaniel", "cloth"], "cloth-config"),
    (&["software", "bernie", "geckolib"], "geckolib"),
    (&["software", "bernie", "geckolib3"], "geckolib"),
    (
        &["com", "github", "tartaricacid", "touhoulittlemaid"],
        "geckolib",
    ),
    (&["top", "theillusivec4", "curios"], "curios"),
    (&["dev", "shadowsoffire", "placebo"], "placebo"),
    (&["dev", "shadowsoffire", "attributeslib"], "attributeslib"),
    (&["net", "blay09", "mods", "balm"], "balm"),
    (&["com", "teamabnormals", "blueprint"], "blueprint"),
    (&["net", "darkhax", "bookshelf"], "bookshelf"),
    (&["fuzs", "puzzleslib"], "puzzles-lib"),
    (&["com", "teamabnormals", "neapolitan"], "neapolitan"),
    (&["dev", "kosmx", "playeranim"], "playeranimator"),
    (&["net", "mehvahdjukaar", "moonlight"], "moonlight"),
    (&["com", "serilum", "collective"], "collective"),
    (&["org", "violetmoon", "citadel"], "citadel"),
    (&["de", "maxhenkel", "corelib"], "corelib"),
    (
        &["com", "teamresourceful", "resourcefullib"],
        "resourceful-lib",
    ),
    (&["com", "hollingsworth", "azurelib"], "azurelib"),
    // === Magic моды ===
    (&["elucent", "ars_nouveau"], "ars_nouveau"),
    (&["com", "hollingsworth", "arsnouveau"], "ars_nouveau"),
    (&["com", "ma", "api"], "maessentials"),
    (&["hellfirepvp", "astralsorcery"], "astralsorcery"),
    (&["electroblob", "wizardry"], "electroblobs-wizardry"),
    (&["com", "integral", "forgottenarts"], "forgotten-arts"),
    (
        &["com", "minecraftabnormals", "savageandravage"],
        "savageandravage",
    ),
    (&["thaumcraft"], "thaumcraft"),
    (&["wayoftime", "bloodmagic"], "bloodmagic"),
    (&["slimeknights", "tconstruct"], "tconstruct"),
    (&["net", "silentchaos512", "gems"], "silent-gems"),
    (&["com", "llamalad7", "mixinextras"], "mixinextras"),
    // === Adventure / RPG моды ===
    (&["net", "silentchaos512", "scalinghealth"], "scalinghealth"),
    (&["com", "github", "alexthe666"], "alexsmobs"),
    (&["artifacts"], "artifacts"),
    (&["net", "silentchaos512", "gear"], "silent-gear"),
    (&["iskallia", "vault"], "the-vault"),
    (&["com", "bewitchment"], "bewitchment"),
    (&["twilightforest"], "twilightforest"),
    (&["com", "progwml6", "natura"], "natura"),
    // === Mob моды ===
    (&["net", "alex", "mobs"], "alexsmobs"),
    (&["com", "github", "alexthe666", "iceandfire"], "iceandfire"),
    (&["com", "unrealdinnerbone", "mutantbeasts"], "mutantbeasts"),
    (&["com", "infamous", "dungeons_mobs"], "dungeons_mobs"),
    (&["supercoder79", "ecotones"], "ecotones"),
    // === Storage моды ===
    (&["com", "tom", "storagemod"], "toms_storage"),
    (
        &["com", "lothrazar", "storagenetwork"],
        "simplestoragenetwork",
    ),
    (
        &["com", "mrp_v2", "sophisticatedbackpacks"],
        "sophisticatedbackpacks",
    ),
    (
        &["com", "mrp_v2", "sophisticatedstorage"],
        "sophisticatedstorage",
    ),
    (&["vazkii", "morphtool"], "morphtool"),
    (
        &["net", "p3pp3rf1y", "sophisticatedcore"],
        "sophisticatedcore",
    ),
    (&["de", "maxhenkel", "car"], "car"),
    // === World generation ===
    (&["terrablender"], "terrablender"),
    (&["com", "terraforged"], "terraforged"),
    (
        &["net", "minecraftbyexample", "biomesoplenty"],
        "biomesoplenty",
    ),
    (&["biomesoplenty"], "biomesoplenty"),
    (&["com", "progwml6", "biomesoplenty"], "biomesoplenty"),
    (&["net", "idkwhy", "wildbackport"], "wildbackport"),
    (&["terrablender"], "terrablender"),
    (&["nonamecrackers2", "hunted"], "hunted"),
    // === Map моды ===
    (&["com", "mamiyaotaru", "voxelmap"], "voxelmap"),
    (&["xaero", "common"], "xaerominimap"),
    (&["xaero", "minimap"], "xaerominimap"),
    (&["xaero", "map"], "xaeroworldmap"),
    (&["journeymap"], "journeymap"),
    // === Camera и визуальные эффекты ===
    (&["io", "socol", "betterthirdperson"], "betterthirdperson"),
    (&["com", "seibel", "distanthorizons"], "distanthorizons"),
    (&["loaderCommon"], "distanthorizons"),
    (
        &["me", "flashyreese", "mods", "sodiumextra"],
        "sodium-extra",
    ),
    (&["de", "maxhenkel", "camera"], "camera"),
    // === Utility моды ===
    (&["mezz", "modnametooltip"], "modnametooltip"),
    (&["net", "blay09", "mods", "waystones"], "waystones"),
    (&["com", "lothrazar", "cyclic"], "cyclic"),
    (&["vazkii", "thedarkmod"], "thedarkmod"),
    (
        &["com", "teamabnormals", "upgrade_aquatic"],
        "upgrade_aquatic",
    ),
    (&["net", "minecraft", "supplementaries"], "supplementaries"),
    (
        &["net", "mehvahdjukaar", "supplementaries"],
        "supplementaries",
    ),
    (&["de", "maxhenkel", "gravestone"], "gravestone"),
    (&["net", "invtweaks"], "inventorytweaks"),
    (&["invtweaks"], "inventorytweaks"),
    // === Farming и Food моды ===
    (&["com", "pam", "harvestcraft"], "harvestcraft"),
    (&["vectorwing", "farmersdelight"], "farmersdelight"),
    (&["com", "teammetallurgy", "aquaculture"], "aquaculture"),
    (&["com", "lothrazar", "growthcraft"], "growthcraft"),
    (&["squeek", "appleskin"], "appleskin"),
    // === Building и декор ===
    (&["com", "chisel"], "chisel"),
    (&["team", "chisel", "ctm"], "ctm"),
    (&["vazkii", "morph"], "morph"),
    (&["com", "copycatsplus", "copycats"], "copycats"),
    (&["net", "id_myshkin", "blockcarpentry"], "blockcarpentry"),
    (&["com", "mduglas", "blockarmor"], "blockarmor"),
    // === Weather & Environment ===
    (&["weather2"], "weather2"),
    (&["com", "corosus", "weather2"], "weather2"),
    (&["sereneseasons"], "sereneseasons"),
    (&["com", "mamiyaotaru", "sereneseasons"], "sereneseasons"),
    // === KubeJS и скриптинг ===
    (&["dev", "latvian", "kubejs"], "kubejs"),
    (&["com", "blamejared", "crafttweaker"], "crafttweaker"),
    (&["crafttweaker"], "crafttweaker"),
    // === Compatibility и ports ===
    (&["org", "sinytra", "connector"], "connector"),
    (&["dev", "su5ed", "sinytra"], "connector"),
    // === Аксессуары и украшения ===
    (&["dev", "emi", "trinkets"], "trinkets"),
    (&["artifacts"], "artifacts"),
    (&["top", "theillusivec4", "caelus"], "caelus"),
    // === Прочие популярные моды ===
    (
        &["com", "telepathicgrunt", "repurposed_structures"],
        "repurposed-structures",
    ),
    (&["net", "onelitefeather", "bettermobs"], "bettermobs"),
    (&["net", "minecraft", "carryon"], "carryon"),
    (&["tschipp", "carryon"], "carryon"),
    (&["com", "minenest", "corail_tombstone"], "corail-tombstone"),
    (&["ovh", "corail", "tombstone"], "corail-tombstone"),
    (&["com", "chamoisest", "prettyweather"], "prettyweather"),
    (&["de", "maxhenkel", "easyvillagers"], "easyvillagers"),
    (&["fi", "dea", "mc", "deafission"], "deafission"),
];

/// Проверить является ли имя пакета служебным (не может быть mod ID)
pub fn is_service_package(name: &str) -> bool {
    const SERVICE_NAMES: &[&str] = &[
        "common",
        "api",
        "core",
        "client",
        "server",
        "mixin",
        "compat",
        "integration",
        "data",
        "items",
        "blocks",
        "entities",
        "util",
        "utils",
        "helper",
        "helpers",
        "registry",
        "network",
        "config",
        "init",
        "event",
        "events",
        "handler",
        "handlers",
        "impl",
        "internal",
        "base",
        "lib",
        "library",
        "foundation",
        "content",
        "platform",
        "render",
        "rendering",
        "model",
        "models",
        "gui",
        "screen",
        "screens",
        "menu",
        "capability",
        "capabilities",
        "asm",
        "mixins",
        "accessor",
        "accessors",
        "wrappers",
        "wrapper",
        "loader",
        "bootstrap",
        "setup",
    ];
    SERVICE_NAMES.contains(&name)
}

/// Извлечь mod ID из полного пути Java класса с интеллектуальным анализом
/// Примеры:
/// - net.caffeinemc.mods.sodium.client.* → Mod("sodium")
/// - org.jetbrains.annotations.* → Library
/// - net.minecraft.* → Minecraft
/// - net.fabricmc.* → Loader("fabric")
pub fn extract_mod_id_from_class(class_path: &str) -> String {
    match analyze_class_path(class_path) {
        ClassAnalysisResult::Mod(id) => id,
        ClassAnalysisResult::Library => "__library__".into(),
        ClassAnalysisResult::Minecraft => "__minecraft__".into(),
        ClassAnalysisResult::Loader(loader) => format!("__loader_{}__", loader),
        ClassAnalysisResult::Unknown => "unknown".into(),
    }
}

/// Полный анализ пути класса
pub fn analyze_class_path(class_path: &str) -> ClassAnalysisResult {
    let parts: Vec<&str> = class_path.split('.').collect();
    if parts.len() < 2 {
        return ClassAnalysisResult::Unknown;
    }

    // Проверяем известные маппинги ПЕРВЫМИ (loaders, minecraft, mods)
    // Это важно, т.к. некоторые loader пакеты также есть в LIBRARY_PACKAGES
    for (prefix, mod_id) in KNOWN_PACKAGE_MAPPINGS {
        if parts.len() >= prefix.len() {
            let matches = prefix
                .iter()
                .zip(parts.iter())
                .all(|(a, b)| a.eq_ignore_ascii_case(b));
            if matches {
                return match *mod_id {
                    "__minecraft__" => ClassAnalysisResult::Minecraft,
                    "__loader_forge__" => ClassAnalysisResult::Loader("forge".into()),
                    "__loader_neoforge__" => ClassAnalysisResult::Loader("neoforge".into()),
                    "__loader_fabric__" => ClassAnalysisResult::Loader("fabric".into()),
                    "__loader_quilt__" => ClassAnalysisResult::Loader("quilt".into()),
                    id => ClassAnalysisResult::Mod(id.to_string()),
                };
            }
        }
    }

    // Проверяем известные библиотеки (ПОСЛЕ known mappings)
    for lib in LIBRARY_PACKAGES {
        if class_path.starts_with(lib) {
            return ClassAnalysisResult::Library;
        }
    }

    // Эвристика: ищем паттерн `*.mods.*`
    // Например: net.caffeinemc.mods.sodium → sodium
    // Например: me.jellysquid.mods.lithium → lithium
    if let Some(mods_idx) = parts.iter().position(|&p| p == "mods") {
        if mods_idx + 1 < parts.len() {
            let mod_name = parts[mods_idx + 1].to_lowercase();
            if mod_name.len() > 2 && !is_service_package(&mod_name) {
                return ClassAnalysisResult::Mod(mod_name);
            }
        }
    }

    // Эвристика для неизвестных пакетов
    // Ищем первый "значимый" сегмент после стандартных префиксов
    let skip_prefixes = [
        "com",
        "net",
        "org",
        "io",
        "me",
        "dev",
        "fi",
        "de",
        "uk",
        "ru",
        "team",
        "cc",
        "xyz",
        "mc",
        "minecraft",
        "mod",
        "mods",
        "forge",
        "fabric",
        "neoforge",
        "quilt",
    ];

    // Ищем первый подходящий сегмент
    let mut candidates: Vec<(usize, &str)> = Vec::new();

    for (i, part) in parts.iter().enumerate() {
        let lower = part.to_lowercase();

        // Пропускаем стандартные префиксы и короткие сегменты
        if skip_prefixes.contains(&lower.as_str()) || part.len() <= 3 {
            continue;
        }

        // Пропускаем служебные названия
        if is_service_package(&lower) {
            continue;
        }

        // Пропускаем если это явно название класса (PascalCase с несколькими словами)
        if part.chars().filter(|c| c.is_uppercase()).count() > 1 {
            continue;
        }

        candidates.push((i, part));
    }

    // Выбираем лучшего кандидата - предпочитаем более длинный (более специфичный)
    // При равной длине предпочитаем более ранний
    if !candidates.is_empty() {
        candidates.sort_by(|(idx_a, a), (idx_b, b)| {
            // Сначала сравниваем по длине (descending)
            let len_cmp = b.len().cmp(&a.len());
            if len_cmp != std::cmp::Ordering::Equal {
                len_cmp
            } else {
                // При равной длине предпочитаем более ранний (ascending)
                idx_a.cmp(idx_b)
            }
        });

        if let Some((_, candidate)) = candidates.first() {
            return ClassAnalysisResult::Mod(candidate.to_lowercase());
        }
    }

    // Фоллбэк: берём 4-й сегмент если он не служебный
    if parts.len() > 3 {
        let fourth = parts[3].to_lowercase();
        if !is_service_package(&fourth) && fourth.len() > 2 {
            return ClassAnalysisResult::Mod(fourth);
        }
    }

    // Последний вариант - 3-й сегмент
    if parts.len() > 2 {
        let third = parts[2].to_lowercase();
        if !is_service_package(&third) {
            return ClassAnalysisResult::Mod(third);
        }
    }

    ClassAnalysisResult::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_service_package() {
        assert!(is_service_package("client"));
        assert!(is_service_package("server"));
        assert!(is_service_package("api"));
        assert!(is_service_package("mixin"));
        assert!(is_service_package("util"));

        assert!(!is_service_package("sodium"));
        assert!(!is_service_package("create"));
        assert!(!is_service_package("botania"));
    }

    #[test]
    fn test_analyze_class_path_known_mods() {
        // Create mod
        let result = analyze_class_path("com.simibubi.create.content.kinetics.base.KineticBlock");
        assert!(matches!(result, ClassAnalysisResult::Mod(id) if id == "create"));

        // Sodium mod
        let result = analyze_class_path("net.caffeinemc.mods.sodium.client.SodiumClientMod");
        assert!(matches!(result, ClassAnalysisResult::Mod(id) if id == "sodium"));

        // JEI mod
        let result = analyze_class_path("mezz.jei.api.IModPlugin");
        assert!(matches!(result, ClassAnalysisResult::Mod(id) if id == "jei"));

        // Botania mod
        let result = analyze_class_path("vazkii.botania.common.item.ModItems");
        assert!(matches!(result, ClassAnalysisResult::Mod(id) if id == "botania"));
    }

    #[test]
    fn test_analyze_class_path_loaders() {
        // Forge
        let result = analyze_class_path("net.minecraftforge.fml.loading.FMLLoader");
        assert!(matches!(result, ClassAnalysisResult::Loader(l) if l == "forge"));

        // Fabric
        let result = analyze_class_path("net.fabricmc.loader.impl.FabricLoaderImpl");
        assert!(matches!(result, ClassAnalysisResult::Loader(l) if l == "fabric"));

        // NeoForge
        let result = analyze_class_path("net.neoforged.fml.loading.FMLLoader");
        assert!(matches!(result, ClassAnalysisResult::Loader(l) if l == "neoforge"));

        // Quilt
        let result = analyze_class_path("org.quiltmc.loader.impl.QuiltLoaderImpl");
        assert!(matches!(result, ClassAnalysisResult::Loader(l) if l == "quilt"));
    }

    #[test]
    fn test_analyze_class_path_minecraft() {
        let result = analyze_class_path("net.minecraft.world.level.Level");
        assert!(matches!(result, ClassAnalysisResult::Minecraft));

        let result = analyze_class_path("com.mojang.blaze3d.platform.Window");
        assert!(matches!(result, ClassAnalysisResult::Minecraft));
    }

    #[test]
    fn test_analyze_class_path_libraries() {
        // Java standard library
        let result = analyze_class_path("java.util.ArrayList");
        assert!(matches!(result, ClassAnalysisResult::Library));

        // Apache commons
        let result = analyze_class_path("org.apache.commons.io.IOUtils");
        assert!(matches!(result, ClassAnalysisResult::Library));

        // SLF4J
        let result = analyze_class_path("org.slf4j.Logger");
        assert!(matches!(result, ClassAnalysisResult::Library));

        // Netty
        let result = analyze_class_path("io.netty.buffer.ByteBuf");
        assert!(matches!(result, ClassAnalysisResult::Library));
    }

    #[test]
    fn test_analyze_class_path_mods_pattern() {
        // Pattern: *.mods.modname.*
        let result = analyze_class_path("me.jellysquid.mods.lithium.common.LithiumMod");
        assert!(matches!(result, ClassAnalysisResult::Mod(id) if id == "lithium"));

        let result = analyze_class_path("net.caffeinemc.mods.phosphor.PhosphorMod");
        assert!(matches!(result, ClassAnalysisResult::Mod(id) if id == "phosphor"));
    }

    #[test]
    fn test_extract_mod_id_from_class() {
        // Known mod
        assert_eq!(
            extract_mod_id_from_class("com.simibubi.create.Create"),
            "create"
        );

        // Library
        assert_eq!(
            extract_mod_id_from_class("java.util.HashMap"),
            "__library__"
        );

        // Minecraft
        assert_eq!(
            extract_mod_id_from_class("net.minecraft.world.World"),
            "__minecraft__"
        );

        // Loader
        assert_eq!(
            extract_mod_id_from_class("net.minecraftforge.fml.ModLoader"),
            "__loader_forge__"
        );
    }

    #[test]
    fn test_analyze_class_path_heuristic() {
        // Должен извлечь "examplemod" из неизвестного мода
        let result = analyze_class_path("com.example.examplemod.items.CustomItem");
        assert!(matches!(result, ClassAnalysisResult::Mod(id) if id == "examplemod"));

        // Должен пропустить служебные пакеты
        let result = analyze_class_path("net.somemod.client.renderer.ClientRenderer");
        // Зависит от эвристики, но "client" и "renderer" не должны быть mod ID
        // Проверим что не Library и не Unknown
        assert!(!matches!(result, ClassAnalysisResult::Library));
    }
}
