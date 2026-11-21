import seekSteps from "./zh/seek-steps";
import reviews from "./zh/reviews";
import playOrders from "./zh/play-orders";
import gameRomLibrary from "./zh/game-rom-library";
import gameNotes from "./zh/game-notes";
import gameLibraryRefinements from "./zh/game-library-refinements";
import gamePokemonUi from "./zh/game-pokemon-ui";
import customArtwork from "./zh/custom-artwork";
import gameAtlasDiscovery from "./zh/game-atlas-discovery";
import gameDiscoveryPicker from "./zh/game-discovery-picker";
import gameLibraryManagement from "./zh/game-library-management";
import gameHydraImport from "./zh/game-hydra-import";
import gameStudioCatalog from "./zh/game-studio-catalog";
import gameArtwork from "./zh/game-artwork";
import gameCommunity from "./zh/game-community";
import gameMetadataMatching from "./zh/game-metadata-matching";
import gameAgeRatings from "./zh/game-age-ratings";
import gameLibraryLinks from "./zh/game-library-links";
import gameModHub from "./zh/game-mod-hub";
import gameLibraryTitles from "./zh/game-library-titles";
import gameStoreSearch from "./zh/game-store-search";
import gameSteamShortcuts from "./zh/game-steam-shortcuts";
import gameGallery from "./zh/game-gallery";
import gameStardew from "./zh/game-stardew";
import gameSourceAlerts from "./zh/game-source-alerts";
import gameSims from "./zh/game-sims";
import gameTarkov from "./zh/game-tarkov";
import gameTft from "./zh/game-tft";
import gameEve from "./zh/game-eve";
import gameOsrs from "./zh/game-osrs";
import gameFfxiv from "./zh/game-ffxiv";
import gameFortnite from "./zh/game-fortnite";
import gameSetup from "./zh/game-setup";
import torrentDialog from "./zh/torrent-dialog";
import gameDownloadNotifications from "./zh/game-download-notifications";
import gameDownloadCenter from "./zh/game-download-center";
import warhammerUniverse from "./zh/warhammer-universe";
import gameLeague from "./zh/game-league";
import gameValorant from "./zh/game-valorant";
import gameAudience from "./zh/game-audience";
import gameDetailFlow from "./zh/game-detail-flow";
import gameWowTalents from "./zh/game-wow-talents";
import gameWowProgress from "./zh/game-wow-progress";
import gameWowRuns from "./zh/game-wow-runs";
import gameMediaRelations from "./zh/game-media-relations";
import gameDota from "./zh/game-dota";
import gameOverwatch from "./zh/game-overwatch";
import gameWowEquipment from "./zh/game-wow-equipment";
import gameRecommendations from "./zh/game-recommendations";
import gameOwnedDiscovery from "./zh/game-owned-discovery";
import gameBackups from "./zh/game-backups";
import gameArchives from "./zh/game-archives";
import gameUnifiedLibrary from "./zh/game-unified-library";
import gamePlaytime from "./zh/game-playtime";
import gameLaunchHealth from "./zh/game-launch-health";
import gameSourceDiscovery from "./zh/game-source-discovery";
import gameGuides from "./zh/game-guides";
import gameModUpdates from "./zh/game-mod-updates";
import gameMinecraft from "./zh/game-minecraft";
import gameRoms from "./zh/game-roms";
import gameExploreRows from "./zh/game-explore-rows";
import gameHackDiscovery from "./zh/game-hack-discovery";
import gameHub from "./zh/game-hub";
import gameRetro from "./zh/game-retro";
import floatingPlayer from "./zh/floating-player";
import gameAntiCheat from "./zh/game-anti-cheat";
import gameDock from "./zh/game-dock";
import gameCompanion from "./zh/game-companion";
import gameWow from "./zh/game-wow";
import gameSearch from "./zh/game-search";
import mediaStart from "./zh/media-start";
import spooktober from "./zh/spooktober";
import listenTogether from "./zh/listen-together";
import music from "./zh/music";
import sportsConsent from "./zh/sports-consent";
import sportsStatistics from "./zh/sports-statistics";
import sportsApi from "./zh/sports-api";
import esportsArena from "./zh/esports-arena";
import sportsHub from "./zh/sports-hub";
import contextActionsFallback from "./context-actions-fallback";

import ebookSources from "./zh/ebook-sources";
import settingsRefinements from "./zh/settings-refinements";
import coverage from "./zh/coverage";
import subtitles from "./zh/subtitles";
import sweepA from "./zh/sweep-a";
import sweepB from "./zh/sweep-b";
import sweepC from "./zh/sweep-c";
import sweepD from "./zh/sweep-d";
import sweepE from "./zh/sweep-e";
import sweepF from "./zh/sweep-f";
import residual from "./zh/residual";
import core from "./zh/core";
import playback from "./zh/playback";
import discovery from "./zh/discovery";
import library from "./zh/library";
import settings from "./zh/settings";
import social from "./zh/social";
import live from "./zh/live";
import books from "./zh/books";
import system from "./zh/system";
import plugins from "./zh/plugins";
import brands from "./zh/brands";
import bpSports from "./zh/bp-sports";
import queueBasket from "./zh/queue-basket";
import liveWeb from "./zh/live-web";

import nytTv from "./zh/nyt-tv";

import gameAchievements from "./zh/game-achievements";

const zh: Record<string, string> = {
  "collections.feed.more": "加载更多合集",
  "collections.feed.error": "无法加载合集。请重试。",
  "Show content ratings?": "显示内容分级？",
  "Age ratings and content notes when playback starts.": "在播放开始时显示年龄分级和内容提示。",
  ...gameCommunity,
  ...torrentDialog,
  "nav.games": "游戏",
  "games.explore": "探索",
  "games.library": "游戏库",
  "games.saved": "收藏",
  "games.download.nav": "下载",
  "games.search": "搜索游戏",
  ...gameAudience,
  ...gameHub,
  ...floatingPlayer,
  ...gameAntiCheat,
  Translations: "翻译",
  "Translating…": "正在翻译…",
  "Showing {lang}": "正在显示{lang}",
  "Show all": "显示全部",
  "games.download.speed.title": "下载速度",
  "games.download.speed.note":
    "此个人资料中的直接下载和种子下载共用此限制。单个种子可以设有更低的限制。",
  "games.download.speed.unlimited": "不限速",
  "games.download.speed.limited": "限制速度",
  "games.download.speed.rate": "每秒千字节",
  "games.download.speed.range": "请输入 {min} 到 {max} 之间的整数。",
  "games.download.speed.error": "无法加载或保存速度设置。请重试。",
  "games.download.speed.current": "文件下载速度：{rate}",
  "games.discovery.sale.cards.included": "集换式卡牌",
  "games.discovery.sale.cards.none": "无特卖卡牌",
  "games.discovery.sale.cards.unknown": "卡牌尚未确认",
  "games.discovery.sale.cards.includedNote":
    "根据 Steam 现行的特卖卡牌规则，此特卖包含卡牌。请打开 Steam 查看获取条件。",
  "games.discovery.sale.cards.noneNote":
    "根据 Steam 现行规则，此季节特卖不包含集换式卡牌。其他活动奖励另行计算。",
  "games.discovery.sale.cards.unknownNote":
    "无法核实 Steam 现行的卡牌规则。请打开 Steam 查看是否提供卡牌。",
  "games.discovery.sale.cards.badgeNote": "集齐一套卡牌即可合成特卖徽章、表情和个人资料背景。",
  "games.download.storage.title": "下载空间",
  "games.download.storage.note":
    "估算包含直接下载、种子下载和临时文件，也包括已暂停的下载。不包含外部安装程序。",
  "games.download.storage.error": "无法检查存储空间。",
  "games.download.storage.unavailable": "无法获取可用空间",
  "games.download.storage.free": "可用空间：{size}",
  "games.download.storage.remaining": "额外空间：{size}",
  "games.download.storage.estimate": "部分现有文件尚未检查。实际所需空间可能更少。",
  "games.download.storage.unknown": "大小未知：{count} 个文件",
  "games.download.storage.other": "其他 Harbor 任务已预留 {size}",
  "games.download.storage.shortfall": "还需要 {size} 空间",
  "games.download.state.retrying": "正在重新连接",
  "games.download.queueOrder": "队列顺序：{position}",
  "games.download.earlier": "将 {name} 前移",
  "games.download.later": "将 {name} 后移",
  ...gameAchievements,
  ...gameSearch,
  ...gameDock,
  ...gameCompanion,
  ...gameFortnite,
  ...gameFfxiv,
  ...gameOsrs,
  ...gameTarkov,
  ...gameModHub,
  ...gameSims,
  ...gameStardew,
  ...gameTft,
  ...gameEve,
  ...warhammerUniverse,
  ...gameWow,
  "games.selection.partial": "已更新{count}款，共{total}款游戏。其余游戏仍处于选中状态，请重试。",
  "games.selection.failed": "无法更新所选游戏。请重试。",
  "games.custom.nav": "本地游戏",
  "games.libraryPersonal.visibility": "游戏库显示范围",
  "games.libraryPersonal.visible": "你的游戏",
  "games.libraryPersonal.pinned": "已置顶",
  "games.libraryPersonal.hidden": "已隐藏",
  "games.library.sort": "游戏库排序",
  "games.selection.start": "选择",
  "games.selection.game": "选择{name}",
  "games.selection.actions": "所选游戏操作",
  "games.selection.count": "已选择 {count} 项",
  "games.selection.clear": "清除选择",
  "games.selection.all": "全选（{count} 项）",
  "games.selection.pinned": "已置顶的游戏：{count}款。",
  "games.selection.unpinned": "已取消置顶的游戏：{count}款。",
  "games.selection.hidden": "已隐藏的游戏：{count}款。可在“已隐藏”中找到。",
  "games.selection.shown": "已在游戏库中显示的游戏：{count}款。",
  "games.selection.show": "在游戏库中显示",
  "games.selection.hide": "隐藏",
  "games.selection.pin": "置顶",
  "games.selection.unpin": "取消置顶",
  "games.selection.matchNote": "部分所选游戏不可用。请刷新游戏库后重试。",
  "games.selection.collection": "添加到合辑",
  "games.collections.localMissing": "已不在此个人资料的游戏库中",
  "games.collections.dynamic": "按筛选条件收录的合辑",
  "games.collections.manual": "自行选择游戏",
  "games.collections.type": "合辑类型",
  "games.collections.filters": "合辑筛选条件",
  "games.collections.ruleQuery": "游戏标题包含",
  "games.collections.autoNote":
    "游戏会根据其在游戏库中的状态是否符合筛选条件，自动加入或移出此合辑。",
  "games.collections.pickerAutoNote":
    "按筛选条件收录的合辑会自动更新。请在“合辑”中管理其筛选条件。",
  "games.collections.matches": "匹配的游戏：{count}款",
  "games.collections.emptyDynamic":
    "游戏库中没有符合这些筛选条件的游戏。请更改筛选条件，或向游戏库添加更多游戏。",
  "games.collections.collections_rules": "无法读取此合辑的筛选条件。已保存的数据未被替换。",
  "games.collections.collections_dynamic":
    "此合辑会自动更新。请在“合辑”中更改其筛选条件，以调整显示的游戏。",
  "games.collections.title": "合辑",
  "games.collections.personal": "由你创建",
  "games.collections.note":
    "每种游戏都有自己的归处。将心爱的游戏、准备玩的作品和想重返的世界归在一起。",
  "games.collections.addTo": "添加到合辑",
  "games.collections.count": "{count}款游戏",
  "games.collections.one": "1款游戏",
  "games.collections.search": "搜索你的合辑",
  "games.collections.name": "合辑名称",
  "games.collections.newName": "为新合辑命名",
  "games.collections.create": "创建",
  "games.collections.first": "从这里创建你的第一个合辑。",
  "games.collections.noMatches": "没有匹配的合辑。",
  "games.collections.pickerNote": "可以选择任意数量。更改会随选择自动保存。",
  "games.collections.empty": "为下一款让你着迷的游戏留个位置。",
  "games.collections.findGames": "寻找游戏",
  "games.collections.description": "简单介绍一下",
  "games.collections.edit": "编辑合辑",
  "games.collections.pin": "置顶合辑",
  "games.collections.unpin": "取消置顶合辑",
  "games.collections.remove": "移除合辑",
  "games.collections.removeNote": "仅移除此合辑。你的游戏、存档、下载和其他合辑都会保留。",
  "games.collections.confirmRemove": "移除此合辑",
  "games.collections.removeGame": "从此合辑中移除{name}",
  "games.collections.removeShort": "从合辑中移除",
  "games.collections.added": "最近添加的优先",
  "games.collections.done": "完成",
  "games.collections.save": "保存更改",
  "games.collections.collections_name": "合辑名称须为1至80个字符，描述最多240个字符。",
  "games.collections.collections_duplicate": "你已有同名合辑。",
  "games.collections.collections_limit":
    "此个人资料已达到合辑存储上限。请移除不用的合辑或游戏后重试。",
  "games.collections.collections_missing": "此合辑已被移除。请选择其他合辑。",
  "games.collections.collections_read": "无法读取你的合辑。已保存的数据未被替换。请尝试重新加载。",
  "games.collections.collections_write":
    "无法保存更改。之前的合辑仍然保留。请释放一些设备存储空间后重试。",
  "games.collections.collections_game": "无法识别这款游戏。请刷新游戏库后重试。",
  "games.collections.firstNote":
    "创建合辑，然后从游戏详情页添加游戏，或在游戏库中选择游戏。PC游戏和ROM可以放在同一个合辑中。",
  "games.collections.emptyNote":
    "从游戏详情页添加游戏，或在游戏库中选择游戏，然后选择“添加到合辑”。",
  "games.cache.saved": "已保存的数据 · {date}",
  "games.cache.refresh": "刷新",
  "games.cache.refreshing": "正在刷新…",
  "games.cache.price": "打开 Steam 查看当前价格。",
  ...mediaStart,
  ...spooktober,
  ...videoCast,
  ...music,
  ...contextActionsFallback,

  ...ebookSources,
  ...coverage,
  ...subtitles,
  ...sweepA,
  ...sweepB,
  ...sweepC,
  ...sweepD,
  ...sweepE,
  ...sweepF,
  ...residual,
  ...core,
  ...playback,
  ...discovery,
  ...library,
  ...settings,
  ...social,
  ...live,
  ...books,
  ...system,
  ...settingsRefinements,
  ...plugins,
  ...brands,
  ...sportsHub,
  ...sportsConsent,
  ...sportsStatistics,
  ...sportsApi,
  ...esportsArena,
  ...bpSports,
  ...listenTogether,
  ...nytTv,
  ...gameRetro,
  ...gameHackDiscovery,
  ...gameStudioCatalog,
  ...gameDiscoveryPicker,
  ...gameLibraryManagement,
  ...gameAtlasDiscovery,
  ...gameRoms,
  ...gameDetailFlow,
  ...gameExploreRows,
  ...gameSourceDiscovery,
  ...gameDownloadCenter,
  ...gameDownloadNotifications,
  ...gameSourceAlerts,
  ...gameModUpdates,
  ...gameMinecraft,
  ...gameGuides,
  ...gameMediaRelations,
  ...gameRecommendations,
  ...gameOverwatch,
  ...gameValorant,
  ...gameDota,
  ...gameLeague,
  ...gameWowEquipment,
  ...gameWowTalents,
  ...gameWowProgress,
  ...gameWowRuns,
  ...gameOwnedDiscovery,
  ...gameBackups,
  ...gameArchives,
  ...gameSetup,
  ...gameHydraImport,
  ...gameSteamShortcuts,
  ...gameGallery,
  ...gameAgeRatings,
  ...gameMetadataMatching,
  ...gameArtwork,
  ...gameUnifiedLibrary,
  ...gameStoreSearch,
  ...gameLibraryTitles,
  ...gameLibraryLinks,
  ...gamePlaytime,
  ...gameLaunchHealth,
  "games.torrent.share.title": "分享种子",
  "games.torrent.share.note":
    "与其他节点分享已验证的文件。达到任一限制或关闭 Harbor 时停止。修改文件前请停止分享。",
  "games.torrent.share.upload": "上传限速（KB/秒）",
  "games.torrent.share.ratio": "分享率（1–10）",
  "games.torrent.share.minutes": "时间限制（分钟）",
  "games.torrent.share.start": "开始分享",
  "games.torrent.share.stop": "停止分享",
  "games.torrent.share.resume": "继续分享",
  "games.torrent.share.checking": "正在检查分享文件",
  "games.torrent.share.seeding": "正在分享",
  "games.torrent.share.stopped": "分享已停止",
  "games.torrent.share.limitReached": "已达到分享限制",
  "games.torrent.share.failed": "分享失败。请检查文件后重试。",
  "games.torrent.share.stats": "已上传 {uploaded} · {minutes} 分钟",
  "games.torrent.torrent_seed_files":
    "已完成的文件丢失、发生变化或正在使用。分享前请检查下载文件夹。",
  "games.torrent.torrent_seed_limits": "请选择 32–1,048,576 KB/秒、1–10 的分享率及 1–1,440 分钟。",

  ...gamePokemonUi,
  ...customArtwork,
  ...gameLibraryRefinements,
  ...gameRomLibrary,
  ...gameNotes,
  ...playOrders,
  ...reviews,
  ...queueBasket,
  ...liveWeb,
  ...seekSteps,
  "Refract sync": "Refract 同步",
  "Sync watched history and Harbor watchlist changes with Refract.":
    "将观看记录和 Harbor 待看列表的变更同步到 Refract。",
  "Refract personal API key": "Refract 个人 API 密钥",
  "Verifying...": "正在验证…",
  "Connect Refract": "连接 Refract",
  "Refract key saved in Harbor's secret store": "Refract 密钥已保存在 Harbor 的安全凭据存储中",
  "Sync watched history and watchlist": "同步观看记录和待看列表",
  "Send watched history and watchlist changes from Harbor to Refract. Only the primary Harbor profile is synced.":
    "将 Harbor 的观看记录和待看列表变更发送到 Refract。仅同步 Harbor 的主用户档案。",
  "Retry pending watches": "重试待发送的观看记录",
  "Disconnect Refract": "断开 Refract 连接",
  "Connected to Refract ({identity}). Watched history sync is enabled.":
    "已连接到 Refract（{identity}）。观看记录同步已启用。",
  "Could not verify the key via Refract /v1/me. Check permissions and connectivity.":
    "无法通过 Refract /v1/me 验证密钥。请检查权限和网络连接。",
  "Disconnected from Refract.": "已断开与 Refract 的连接。",
  "Create a personal API key in Refract with profile:read, library:read, library:write and history:write. Never share or commit the key.":
    "在 Refract 中创建具有 profile:read、library:read、library:write 和 history:write 权限的个人 API 密钥。切勿分享密钥或将其提交到代码仓库。",
  "Automatic watch threshold": "自动记录观看的阈值",
  "After {count} minutes": "{count} 分钟后",
  "{count}% (default)": "{count}%（默认）",
  "Log a movie or episode in Refract when playback reaches the selected time or percentage. Seeking past it also qualifies. Early logging counts as watched in Refract, not partially watched. Harbor's own completion threshold is unchanged.":
    "播放达到所选时长或百分比时，将电影或剧集记录到 Refract。跳转至阈值之后也会触发记录。提前记录会在 Refract 中标记为已观看，而非部分观看。Harbor 自身的观看完成阈值保持不变。",
  "Harbor → Refract Plan to Watch": "Harbor → Refract 待看列表",
  "New watchlist additions and removals are sent automatically while sync is enabled. Requires library:write; reconnect with an updated key if needed. Existing Refract history and other library statuses are preserved.":
    "启用同步后，待看列表中的新增和移除操作会自动发送。需要 library:write 权限；如有必要，请使用更新后的密钥重新连接。现有 Refract 历史记录和其他媒体库状态将保留。",
  "{sent} sent · {pending} pending · {failed} unmatched":
    "已发送 {sent} 项 · 待发送 {pending} 项 · 未匹配 {failed} 项",
  "Unmatched items": "未匹配的项目",
  "Refract queue full; unable to save another watch": "Refract 队列已满，无法保存更多观看记录",
  "No verified IMDb/TMDB/TVDB identity": "没有经过验证的 IMDb/TMDB/TVDB 标识",
  "Movie not found in Refract": "在 Refract 中未找到该电影",
  "Episode not found; verify season numbering": "未找到该剧集，请检查季编号",
  "Last watched item sent successfully": "最近的观看记录已成功发送",
  "Unknown error": "未知错误",
  "Some items could not be matched or sent": "部分条目无法匹配或发送",
  "Refract denied access; check key and permissions": "Refract 拒绝访问，请检查密钥和权限",
  "Network error; retry scheduled": "网络错误，已安排重试",
  "No verified IMDb/TMDB/TVDB identity is available for this title.":
    "此作品没有经过验证的 IMDb/TMDB/TVDB 标识。",
  "Refract could not uniquely identify this title.": "Refract 无法唯一识别此作品。",
  "Refract preserved an existing library entry or viewing history.":
    "Refract 保留了现有的媒体库条目或观看历史。",
  "Added to Refract Plan to Watch.": "已添加到 Refract 的计划观看列表。",
  "Removed from Refract Plan to Watch.": "已从 Refract 的计划观看列表移除。",
  "Refract watchlist requires library:write. Reconnect with a key that has this scope.":
    "Refract 观看列表需要 library:write 权限。请使用具有此权限的密钥重新连接。",
  "Refract could not confirm the watchlist change. Try again.":
    "Refract 无法确认观看列表的更改，请重试。",
  "Refract HTTP {status}": "Refract HTTP {status}",
};

export default zh;
import videoCast from "./zh/video-cast";
