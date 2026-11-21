import seekSteps from "./ar/seek-steps";
import reviews from "./ar/reviews";
import playOrders from "./ar/play-orders";
import gameRomLibrary from "./ar/game-rom-library";
import gameNotes from "./ar/game-notes";
import gameLibraryRefinements from "./ar/game-library-refinements";
import gamePokemonUi from "./ar/game-pokemon-ui";
import customArtwork from "./ar/custom-artwork";
import gameAtlasDiscovery from "./ar/game-atlas-discovery";
import gameDiscoveryPicker from "./ar/game-discovery-picker";
import gameLibraryManagement from "./ar/game-library-management";
import gameHydraImport from "./ar/game-hydra-import";
import gameStudioCatalog from "./ar/game-studio-catalog";
import gameArtwork from "./ar/game-artwork";
import gameCommunity from "./ar/game-community";
import gameMetadataMatching from "./ar/game-metadata-matching";
import gameAgeRatings from "./ar/game-age-ratings";
import gameLibraryLinks from "./ar/game-library-links";
import gameModHub from "./ar/game-mod-hub";
import gameLibraryTitles from "./ar/game-library-titles";
import gameStoreSearch from "./ar/game-store-search";
import gameSteamShortcuts from "./ar/game-steam-shortcuts";
import gameGallery from "./ar/game-gallery";
import gameStardew from "./ar/game-stardew";
import gamePokemon from "./ar/game-pokemon";
import gameSourceAlerts from "./ar/game-source-alerts";
import gameSims from "./ar/game-sims";
import gameTarkov from "./ar/game-tarkov";
import gameTft from "./ar/game-tft";
import gameEve from "./ar/game-eve";
import gameOsrs from "./ar/game-osrs";
import gameFfxiv from "./ar/game-ffxiv";
import gameFortnite from "./ar/game-fortnite";
import gameSetup from "./ar/game-setup";
import torrentDialog from "./ar/torrent-dialog";
import gameDownloadNotifications from "./ar/game-download-notifications";
import gameDownloadCenter from "./ar/game-download-center";
import warhammerUniverse from "./ar/warhammer-universe";
import gameLeague from "./ar/game-league";
import gameValorant from "./ar/game-valorant";
import gameAudience from "./ar/game-audience";
import gameDetailFlow from "./ar/game-detail-flow";
import gameWowTalents from "./ar/game-wow-talents";
import gameWowProgress from "./ar/game-wow-progress";
import gameWowRuns from "./ar/game-wow-runs";
import gameMediaRelations from "./ar/game-media-relations";
import gameDota from "./ar/game-dota";
import gameOverwatch from "./ar/game-overwatch";
import gameWowEquipment from "./ar/game-wow-equipment";
import gameRecommendations from "./ar/game-recommendations";
import gameOwnedDiscovery from "./ar/game-owned-discovery";
import gameBackups from "./ar/game-backups";
import gameArchives from "./ar/game-archives";
import gameUnifiedLibrary from "./ar/game-unified-library";
import gamePlaytime from "./ar/game-playtime";
import gameLaunchHealth from "./ar/game-launch-health";
import gameSourceDiscovery from "./ar/game-source-discovery";
import gameGuides from "./ar/game-guides";
import gameModUpdates from "./ar/game-mod-updates";
import gameMinecraft from "./ar/game-minecraft";
import gameRoms from "./ar/game-roms";
import gameExploreRows from "./ar/game-explore-rows";
import gameHackDiscovery from "./ar/game-hack-discovery";
import gameHub from "./ar/game-hub";
import gameRetro from "./ar/game-retro";
import floatingPlayer from "./ar/floating-player";
import gameAntiCheat from "./ar/game-anti-cheat";
import gameDock from "./ar/game-dock";
import gameCompanion from "./ar/game-companion";
import gameWow from "./ar/game-wow";
import gameSearch from "./ar/game-search";
import mediaStart from "./ar/media-start";
import spooktober from "./ar/spooktober";
import listenTogether from "./ar/listen-together";
import music from "./ar/music";
import sportsConsent from "./ar/sports-consent";
import sportsStatistics from "./ar/sports-statistics";
import sportsApi from "./ar/sports-api";
import esportsArena from "./ar/esports-arena";
import sportsHub from "./ar/sports-hub";
import bpSports from "./ar/bp-sports";
import contextActionsFallback from "./context-actions-fallback";

import ebookSources from "./ar/ebook-sources";
import settingsRefinements from "./ar/settings-refinements";
import uiFallback from "./ui-fallback";
import experimentalUpdates from "./ar/experimental-updates";
import coverage from "./ar/coverage";
import subtitles from "./ar/subtitles";
import settingsFill from "./ar/settings-fill";
import profileFill from "./ar/profile-fill";
import appFill from "./ar/app-fill";
import used from "./ar/used";
import sweep from "./ar/sweep";
import wired from "./ar/wired";

import chrome from "./ar/chrome";
import common from "./ar/common";
import catalog from "./ar/catalog";
import detail from "./ar/detail";
import player from "./ar/player";
import live from "./ar/live";
import settings from "./ar/settings";
import library from "./ar/library";
import manga from "./ar/manga";
import sync from "./ar/sync";
import lists from "./ar/lists";
import downloads from "./ar/downloads";
import together from "./ar/together";
import rails from "./ar/rails";
import masthead from "./ar/masthead";
import discover from "./ar/discover";
import spotlights from "./ar/spotlights";
import misc from "./ar/misc";
import awards from "./ar/awards";
import addons from "./ar/addons";
import controllers from "./ar/controllers";
import bpSources from "./ar/bp-sources";
import ageGate from "./ar/age-gate";
import dynamic from "./ar/dynamic";
import plurals from "./ar/plurals";
import audit from "./ar/audit";
import plugins from "./ar/plugins";
import brands from "./ar/brands";
import contextActions from "./ar/context-actions";

import nytTv from "./ar/nyt-tv";

import gameAchievements from "./ar/game-achievements";

import queueBasket from "./ar/queue-basket";
import liveWeb from "./ar/live-web";

const ar: Record<string, string> = {
  "collections.feed.more": "تحميل المزيد من المجموعات",
  "collections.feed.error": "تعذر تحميل المجموعات. حاول مرة أخرى.",
  "Show content ratings?": "عرض تصنيفات المحتوى؟",
  "Age ratings and content notes when playback starts.":
    "التصنيف العمري وملاحظات المحتوى عند بدء التشغيل.",
  ...gameCommunity,
  ...gamePokemon,
  ...torrentDialog,
  "nav.games": "الألعاب",
  "games.explore": "استكشف",
  "games.library": "المكتبة",
  "games.saved": "المفضلة",
  "games.download.nav": "التنزيلات",
  "games.search": "ابحث عن ألعاب",
  ...gameAudience,
  ...gameHub,
  ...floatingPlayer,
  ...gameAntiCheat,
  Translations: "الترجمات",
  "Translating…": "جارٍ الترجمة…",
  "Showing {lang}": "عرض {lang}",
  "Show all": "عرض الكل",
  "games.download.speed.title": "سرعة التنزيل",
  "games.download.speed.note":
    "حد مشترك للتنزيلات المباشرة والتورنت في هذا الملف الشخصي. قد يكون حد التورنت الخاص أقل.",
  "games.download.speed.unlimited": "بلا حد",
  "games.download.speed.limited": "تحديد السرعة",
  "games.download.speed.rate": "كيلوبايت في الثانية",
  "games.download.speed.range": "أدخل عددًا صحيحًا من {min} إلى {max}.",
  "games.download.speed.error": "تعذّر تحميل إعداد السرعة أو حفظه. حاول مرة أخرى.",
  "games.download.speed.current": "سرعة تنزيل الملفات: {rate}",
  "games.discovery.sale.cards.included": "بطاقات التداول",
  "games.discovery.sale.cards.none": "لا توجد بطاقات للتخفيضات",
  "games.discovery.sale.cards.unknown": "البطاقات غير مؤكدة",
  "games.discovery.sale.cards.includedNote":
    "مشمولة وفق قواعد Steam الحالية لبطاقات التخفيضات. افتح Steam لمعرفة شروط الحصول عليها.",
  "games.discovery.sale.cards.noneNote":
    "قواعد Steam الحالية لا تشمل بطاقات تداول لهذه التخفيضات الموسمية. مكافآت الفعالية الأخرى منفصلة.",
  "games.discovery.sale.cards.unknownNote":
    "تعذّر التحقق من قواعد Steam الحالية للبطاقات. افتح Steam للتحقق من توفرها.",
  "games.discovery.sale.cards.badgeNote":
    "اجمع مجموعة كاملة لصنع شارة للتخفيضات ورمز تعبيري وخلفية للملف الشخصي.",
  "games.download.storage.title": "مساحة التنزيل",
  "games.download.storage.note":
    "تشمل التقديرات التنزيلات المباشرة والتورنت والملفات المؤقتة، بما فيها التنزيلات المتوقفة مؤقتًا. لا تشمل برامج التثبيت الخارجية.",
  "games.download.storage.error": "تعذّر التحقق من مساحة التخزين.",
  "games.download.storage.unavailable": "المساحة الخالية غير متاحة",
  "games.download.storage.free": "{size} متاحة",
  "games.download.storage.remaining": "المساحة الإضافية: {size}",
  "games.download.storage.estimate":
    "لم تُفحص بعض الملفات الموجودة بعد. قد تكون المساحة المطلوبة أقل.",
  "games.download.storage.unknown": "الحجم غير معروف: {count} ملفات",
  "games.download.storage.other": "المحجوز لعمليات Harbor الأخرى: {size}",
  "games.download.storage.shortfall": "تحتاج إلى مساحة إضافية قدرها {size}",
  "games.download.state.retrying": "جارٍ إعادة الاتصال",
  "games.download.queueOrder": "الترتيب في القائمة: {position}",
  "games.download.earlier": "تقديم {name} في القائمة",
  "games.download.later": "تأخير {name} في القائمة",
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
  "games.selection.partial":
    "تم تحديث {count} من أصل {total} لعبة. لا تزال الألعاب المتبقية محددة؛ حاول مجددًا.",
  "games.selection.failed": "تعذّر تحديث الألعاب المحددة. حاول مجددًا.",
  "games.custom.nav": "الألعاب المحلية",
  "games.libraryPersonal.visibility": "ظهور الألعاب في المكتبة",
  "games.libraryPersonal.visible": "ألعابك",
  "games.libraryPersonal.pinned": "المثبتة في الأعلى",
  "games.libraryPersonal.hidden": "المخفية",
  "games.library.sort": "ترتيب المكتبة",
  "games.selection.start": "تحديد",
  "games.selection.game": "تحديد {name}",
  "games.selection.actions": "إجراءات الألعاب المحددة",
  "games.selection.count": "تم تحديد {count}",
  "games.selection.clear": "إلغاء التحديد",
  "games.selection.all": "تحديد الكل ({count})",
  "games.selection.pinned": "الألعاب المثبتة في الأعلى: {count}.",
  "games.selection.unpinned": "الألعاب التي أُلغي تثبيتها في الأعلى: {count}.",
  "games.selection.hidden": "الألعاب المخفية: {count}. ستجدها ضمن الألعاب المخفية.",
  "games.selection.shown": "الألعاب التي أُظهرت في مكتبتك: {count}.",
  "games.selection.show": "إظهار في المكتبة",
  "games.selection.hide": "إخفاء",
  "games.selection.pin": "تثبيت في الأعلى",
  "games.selection.unpin": "إلغاء التثبيت في الأعلى",
  "games.selection.matchNote": "بعض الألعاب المحددة غير متاحة. حدّث مكتبتك وحاول مجددًا.",
  "games.selection.collection": "إضافة إلى مجموعة",
  "games.collections.localMissing": "لم تعد موجودة في مكتبة هذا الملف الشخصي",
  "games.collections.dynamic": "مجموعة تعتمد على الفلاتر",
  "games.collections.manual": "اختر الألعاب بنفسك",
  "games.collections.type": "نوع المجموعة",
  "games.collections.filters": "فلاتر المجموعة",
  "games.collections.ruleQuery": "عنوان اللعبة يحتوي على",
  "games.collections.autoNote":
    "تُضاف الألعاب إلى هذه المجموعة أو تُزال منها تلقائيًا بحسب مطابقتها لفلاتر المجموعة في مكتبتك.",
  "games.collections.pickerAutoNote":
    "تُحدَّث المجموعات التي تعتمد على الفلاتر تلقائيًا. يمكنك إدارة فلاترها في المجموعات.",
  "games.collections.matches": "الألعاب المطابقة: {count}",
  "games.collections.emptyDynamic":
    "لا توجد ألعاب في مكتبتك تطابق هذه الفلاتر. غيّر الفلاتر أو أضف مزيدًا من الألعاب إلى مكتبتك.",
  "games.collections.collections_rules":
    "تعذّرت قراءة فلاتر هذه المجموعة. لم تُستبدل البيانات المحفوظة.",
  "games.collections.collections_dynamic":
    "تُحدّث هذه المجموعة تلقائيًا. غيّر فلاترها في المجموعات لتغيير الألعاب التي تظهر.",
  "games.collections.title": "المجموعات",
  "games.collections.personal": "من إنشائك",
  "games.collections.note":
    "مكان لكل نوع من الألعاب. اجمع ألعابك المفضلة وما تنوي لعبه والعوالم التي تستحق العودة إليها.",
  "games.collections.addTo": "إضافة إلى مجموعة",
  "games.collections.count": "الألعاب: {count}",
  "games.collections.one": "لعبة واحدة",
  "games.collections.search": "البحث في مجموعاتك",
  "games.collections.name": "اسم المجموعة",
  "games.collections.newName": "سمِّ مجموعة جديدة",
  "games.collections.create": "إنشاء",
  "games.collections.first": "مجموعتك الأولى تبدأ هنا.",
  "games.collections.noMatches": "لا توجد مجموعات مطابقة.",
  "games.collections.pickerNote": "اختر أي عدد تريده. تُحفظ التغييرات أثناء الاختيار.",
  "games.collections.empty": "مساحة للعبة القادمة التي ستأسرك.",
  "games.collections.findGames": "البحث عن ألعاب",
  "games.collections.description": "بضع كلمات عنها",
  "games.collections.edit": "تعديل المجموعة",
  "games.collections.pin": "تثبيت المجموعة في الأعلى",
  "games.collections.unpin": "إلغاء تثبيت المجموعة في الأعلى",
  "games.collections.remove": "إزالة المجموعة",
  "games.collections.removeNote":
    "تُزال هذه المجموعة فقط. تبقى ألعابك وملفات حفظ اللعب والتنزيلات والمجموعات الأخرى كما هي.",
  "games.collections.confirmRemove": "إزالة هذه المجموعة",
  "games.collections.removeGame": "إزالة {name} من هذه المجموعة",
  "games.collections.removeShort": "إزالة من المجموعة",
  "games.collections.added": "الأحدث إضافةً أولًا",
  "games.collections.done": "تم",
  "games.collections.save": "حفظ التغييرات",
  "games.collections.collections_name": "أدخل للمجموعة اسمًا من 1–80 حرفًا ووصفًا لا يتجاوز 240 حرفًا.",
  "games.collections.collections_duplicate": "لديك مجموعة بهذا الاسم بالفعل.",
  "games.collections.collections_limit":
    "بلغ هذا الملف الشخصي الحد الأقصى لتخزين المجموعات. أزل المجموعات أو الألعاب غير المستخدمة وحاول مجددًا.",
  "games.collections.collections_missing": "تمت إزالة هذه المجموعة. اختر مجموعة أخرى.",
  "games.collections.collections_read":
    "تعذّرت قراءة مجموعاتك. لم تُستبدل البيانات المحفوظة. حاول تحميلها مجددًا.",
  "games.collections.collections_write":
    "تعذّر حفظ التغيير. لا تزال مجموعتك السابقة موجودة. وفّر مساحة تخزين على الجهاز وحاول مجددًا.",
  "games.collections.collections_game": "تعذّر التعرف على هذه اللعبة. حدّث مكتبتك وحاول مجددًا.",
  "games.collections.firstNote":
    "أنشئ مجموعة، ثم أضف الألعاب من صفحات تفاصيلها أو حددها في مكتبتك. يمكن أن تضم المجموعة ألعاب الكمبيوتر وملفات ROM معًا.",
  "games.collections.emptyNote":
    "أضف الألعاب من صفحات تفاصيلها، أو حدد الألعاب في مكتبتك واختر إضافة إلى مجموعة.",
  "games.cache.saved": "بيانات محفوظة · {date}",
  "games.cache.refresh": "تحديث",
  "games.cache.refreshing": "جارٍ التحديث…",
  "games.cache.price": "افتح Steam للتحقق من السعر الحالي.",
  ...mediaStart,
  ...spooktober,
  ...videoCast,
  ...music,
  ...contextActionsFallback,

  ...ebookSources,
  ...uiFallback,
  ...coverage,
  ...subtitles,
  ...settingsFill,
  ...profileFill,
  ...appFill,
  ...used,
  ...sweep,
  ...wired,

  ...chrome,
  ...common,
  ...catalog,
  ...detail,
  ...player,
  ...live,
  ...settings,
  ...library,
  ...manga,
  ...sync,
  ...lists,
  ...downloads,
  ...together,
  ...rails,
  ...masthead,
  ...discover,
  ...spotlights,
  ...misc,
  ...awards,
  ...addons,
  ...controllers,
  ...bpSources,
  ...ageGate,
  ...dynamic,
  ...plurals,
  ...audit,
  ...experimentalUpdates,
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
  "games.torrent.share.title": "مشاركة التورنت",
  "games.torrent.share.note":
    "شارك الملفات المتحقق منها مع الأقران. تتوقف المشاركة عند بلوغ أي حد أو إغلاق Harbor. أوقفها قبل تغيير الملفات.",
  "games.torrent.share.upload": "حد الرفع (كيلوبايت/ث)",
  "games.torrent.share.ratio": "نسبة المشاركة (1–10)",
  "games.torrent.share.minutes": "الحد الزمني (دقائق)",
  "games.torrent.share.start": "بدء المشاركة",
  "games.torrent.share.stop": "إيقاف المشاركة",
  "games.torrent.share.resume": "استئناف المشاركة",
  "games.torrent.share.checking": "جارٍ فحص ملفات المشاركة",
  "games.torrent.share.seeding": "تتم المشاركة",
  "games.torrent.share.stopped": "توقفت المشاركة",
  "games.torrent.share.limitReached": "تم بلوغ حد المشاركة",
  "games.torrent.share.failed": "فشلت المشاركة. افحص الملفات وحاول مجددًا.",
  "games.torrent.share.stats": "تم رفع {uploaded} · {minutes} دقيقة",
  "games.torrent.torrent_seed_files":
    "الملفات المكتملة مفقودة أو تغيرت أو قيد الاستخدام. افحص مجلد التنزيل قبل المشاركة.",
  "games.torrent.torrent_seed_limits":
    "اختر حد رفع 32–1,048,576 كيلوبايت/ث، ونسبة 1–10، ومدة 1–1,440 دقيقة.",

  ...gamePokemonUi,
  ...customArtwork,
  ...gameLibraryRefinements,
  ...gameRomLibrary,
  ...gameNotes,
  ...playOrders,
  ...contextActions,
  ...reviews,
  ...queueBasket,
  ...liveWeb,
  ...seekSteps,
  "Refract sync": "مزامنة Refract",
  "Sync watched history and Harbor watchlist changes with Refract.":
    "زامن سجل المشاهدة والتغييرات في قائمة المشاهدة في Harbor مع Refract.",
  "Refract personal API key": "مفتاح API شخصي لـ Refract",
  "Verifying...": "جارٍ التحقق…",
  "Connect Refract": "ربط Refract",
  "Refract key saved in Harbor's secret store": "تم حفظ مفتاح Refract في مخزن الأسرار في Harbor",
  "Sync watched history and watchlist": "مزامنة سجل المشاهدة وقائمة المشاهدة",
  "Send watched history and watchlist changes from Harbor to Refract. Only the primary Harbor profile is synced.":
    "أرسل سجل المشاهدة والتغييرات في قائمة المشاهدة من Harbor إلى Refract. تتم مزامنة الملف الشخصي الأساسي في Harbor فقط.",
  "Retry pending watches": "إعادة إرسال سجلات المشاهدة المعلقة",
  "Disconnect Refract": "قطع اتصال Refract",
  "Connected to Refract ({identity}). Watched history sync is enabled.":
    "تم الاتصال بـ Refract ({identity}). تم تفعيل مزامنة سجل المشاهدة.",
  "Could not verify the key via Refract /v1/me. Check permissions and connectivity.":
    "تعذر التحقق من المفتاح عبر Refract /v1/me. تحقق من الأذونات والاتصال.",
  "Disconnected from Refract.": "تم قطع الاتصال بـ Refract.",
  "Create a personal API key in Refract with profile:read, library:read, library:write and history:write. Never share or commit the key.":
    "أنشئ مفتاح API شخصيًا في Refract بالأذونات profile:read وlibrary:read وlibrary:write وhistory:write. لا تشارك المفتاح ولا تحفظه في مستودع برمجي.",
  "Automatic watch threshold": "عتبة تسجيل المشاهدة تلقائيًا",
  "After {count} minutes": "بعد {count} دقائق",
  "{count}% (default)": "{count}% (افتراضي)",
  "Log a movie or episode in Refract when playback reaches the selected time or percentage. Seeking past it also qualifies. Early logging counts as watched in Refract, not partially watched. Harbor's own completion threshold is unchanged.":
    "سجّل الفيلم أو الحلقة في Refract عندما يصل التشغيل إلى المدة أو النسبة المحددة. يُحتسب أيضًا تجاوز العتبة بالتقديم. يُسجّل المحتوى مبكرًا كمُشاهَد، وليس كمُشاهَد جزئيًا. تبقى عتبة إكمال المشاهدة في Harbor دون تغيير.",
  "Harbor → Refract Plan to Watch": "Harbor → Refract: مخطط للمشاهدة",
  "New watchlist additions and removals are sent automatically while sync is enabled. Requires library:write; reconnect with an updated key if needed. Existing Refract history and other library statuses are preserved.":
    "تُرسل الإضافات والإزالات من قائمة المشاهدة تلقائيًا أثناء تفعيل المزامنة. يتطلب ذلك إذن library:write؛ أعد الاتصال بمفتاح محدّث عند الحاجة. يبقى سجل Refract الحالي وحالات المكتبة الأخرى محفوظة.",
  "{sent} sent · {pending} pending · {failed} unmatched":
    "تم الإرسال: {sent} · معلق: {pending} · غير مطابق: {failed}",
  "Unmatched items": "عناصر غير مطابقة",
  "Refract queue full; unable to save another watch":
    "قائمة انتظار Refract ممتلئة؛ تعذر حفظ مشاهدة أخرى",
  "No verified IMDb/TMDB/TVDB identity": "لا يوجد معرّف IMDb/TMDB/TVDB موثّق",
  "Movie not found in Refract": "لم يتم العثور على الفيلم في Refract",
  "Episode not found; verify season numbering": "لم يتم العثور على الحلقة؛ تحقق من ترقيم المواسم",
  "Last watched item sent successfully": "تم إرسال آخر سجل مشاهدة بنجاح",
  "Unknown error": "خطأ غير معروف",
  "Some items could not be matched or sent": "تعذرت مطابقة بعض العناصر أو إرسالها",
  "Refract denied access; check key and permissions":
    "رفض Refract الوصول؛ تحقق من المفتاح والأذونات",
  "Network error; retry scheduled": "خطأ في الشبكة؛ تمت جدولة إعادة المحاولة",
  "No verified IMDb/TMDB/TVDB identity is available for this title.":
    "لا يوجد معرّف IMDb/TMDB/TVDB موثّق لهذا العنوان.",
  "Refract could not uniquely identify this title.":
    "تعذر على Refract تحديد هذا العنوان بشكل فريد.",
  "Refract preserved an existing library entry or viewing history.":
    "احتفظ Refract بعنصر موجود في المكتبة أو سجل المشاهدة.",
  "Added to Refract Plan to Watch.": "تمت الإضافة إلى قائمة المشاهدة لاحقًا في Refract.",
  "Removed from Refract Plan to Watch.": "تمت الإزالة من قائمة المشاهدة لاحقًا في Refract.",
  "Refract watchlist requires library:write. Reconnect with a key that has this scope.":
    "تتطلب قائمة المشاهدة في Refract إذن library:write. أعد الاتصال بمفتاح يملك هذا الإذن.",
  "Refract could not confirm the watchlist change. Try again.":
    "تعذر على Refract تأكيد تغيير قائمة المشاهدة. حاول مجددًا.",
  "Refract HTTP {status}": "Refract HTTP {status}",
};

export default ar;
import videoCast from "./ar/video-cast";
