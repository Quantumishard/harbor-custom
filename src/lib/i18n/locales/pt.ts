import seekSteps from "./pt/seek-steps";
import reviews from "./pt/reviews";
import playOrders from "./pt/play-orders";
import gameRomLibrary from "./pt/game-rom-library";
import gameNotes from "./pt/game-notes";
import gameLibraryRefinements from "./pt/game-library-refinements";
import gamePokemonUi from "./pt/game-pokemon-ui";
import customArtwork from "./pt/custom-artwork";
import gameAtlasDiscovery from "./pt/game-atlas-discovery";
import gameDiscoveryPicker from "./pt/game-discovery-picker";
import gameLibraryManagement from "./pt/game-library-management";
import gameHydraImport from "./pt/game-hydra-import";
import gameStudioCatalog from "./pt/game-studio-catalog";
import gameArtwork from "./pt/game-artwork";
import gameCommunity from "./pt/game-community";
import gameMetadataMatching from "./pt/game-metadata-matching";
import gameAgeRatings from "./pt/game-age-ratings";
import gameLibraryLinks from "./pt/game-library-links";
import gameModHub from "./pt/game-mod-hub";
import gameLibraryTitles from "./pt/game-library-titles";
import gameStoreSearch from "./pt/game-store-search";
import gameSteamShortcuts from "./pt/game-steam-shortcuts";
import gameGallery from "./pt/game-gallery";
import gameStardew from "./pt/game-stardew";
import gamePokemon from "./pt/game-pokemon";
import gameSourceAlerts from "./pt/game-source-alerts";
import gameSims from "./pt/game-sims";
import gameTarkov from "./pt/game-tarkov";
import gameTft from "./pt/game-tft";
import gameEve from "./pt/game-eve";
import gameOsrs from "./pt/game-osrs";
import gameFfxiv from "./pt/game-ffxiv";
import gameFortnite from "./pt/game-fortnite";
import gameSetup from "./pt/game-setup";
import torrentDialog from "./pt/torrent-dialog";
import gameDownloadNotifications from "./pt/game-download-notifications";
import gameDownloadCenter from "./pt/game-download-center";
import warhammerUniverse from "./pt/warhammer-universe";
import gameLeague from "./pt/game-league";
import gameValorant from "./pt/game-valorant";
import gameAudience from "./pt/game-audience";
import gameDetailFlow from "./pt/game-detail-flow";
import gameWowTalents from "./pt/game-wow-talents";
import gameWowProgress from "./pt/game-wow-progress";
import gameWowRuns from "./pt/game-wow-runs";
import gameMediaRelations from "./pt/game-media-relations";
import gameDota from "./pt/game-dota";
import gameOverwatch from "./pt/game-overwatch";
import gameWowEquipment from "./pt/game-wow-equipment";
import gameRecommendations from "./pt/game-recommendations";
import gameOwnedDiscovery from "./pt/game-owned-discovery";
import gameBackups from "./pt/game-backups";
import gameArchives from "./pt/game-archives";
import gameUnifiedLibrary from "./pt/game-unified-library";
import gamePlaytime from "./pt/game-playtime";
import gameLaunchHealth from "./pt/game-launch-health";
import gameSourceDiscovery from "./pt/game-source-discovery";
import gameGuides from "./pt/game-guides";
import gameModUpdates from "./pt/game-mod-updates";
import gameMinecraft from "./pt/game-minecraft";
import gameRoms from "./pt/game-roms";
import gameExploreRows from "./pt/game-explore-rows";
import gameHackDiscovery from "./pt/game-hack-discovery";
import gameHub from "./pt/game-hub";
import gameRetro from "./pt/game-retro";
import floatingPlayer from "./pt/floating-player";
import gameAntiCheat from "./pt/game-anti-cheat";
import gameDock from "./pt/game-dock";
import gameCompanion from "./pt/game-companion";
import gameWow from "./pt/game-wow";
import gameSearch from "./pt/game-search";
import mediaStart from "./pt/media-start";
import spooktober from "./pt/spooktober";
import listenTogether from "./pt/listen-together";
import music from "./pt/music";
import sportsConsent from "./pt/sports-consent";
import sportsStatistics from "./pt/sports-statistics";
import sportsApi from "./pt/sports-api";
import esportsArena from "./pt/esports-arena";
import sportsHub from "./pt/sports-hub";
import contextActionsFallback from "./context-actions-fallback";

import ebookSources from "./pt/ebook-sources";
import settingsRefinements from "./pt/settings-refinements";
import experimentalUpdates from "./pt/experimental-updates";
import coverage from "./pt/coverage";
import subtitles from "./pt/subtitles";
import chrome from "./pt/chrome";
import common from "./pt/common";
import catalog from "./pt/catalog";
import detail from "./pt/detail";
import player from "./pt/player";
import live from "./pt/live";
import settings from "./pt/settings";
import settingsFill from "./pt/settings-fill";
import profileFill from "./pt/profile-fill";
import appFill from "./pt/app-fill";
import library from "./pt/library";
import sync from "./pt/sync";
import lists from "./pt/lists";
import downloads from "./pt/downloads";
import together from "./pt/together";
import rails from "./pt/rails";
import masthead from "./pt/masthead";
import discover from "./pt/discover";
import spotlights from "./pt/spotlights";
import misc from "./pt/misc";
import awards from "./pt/awards";
import addons from "./pt/addons";
import extra from "./pt/extra";
import manga from "./pt/manga";
import controllers from "./pt/controllers";

import bpSources from "./pt/bp-sources";
import used from "./pt/used";
import sweep from "./pt/sweep";
import sourceCoverage from "./pt/source-coverage";
import wired from "./pt/wired";
import wiringSweep from "./pt/wiring-sweep";
import wiringSweep2 from "./pt/wiring-sweep-2";
import wiringSweep3 from "./pt/wiring-sweep-3";
import wiringSweep4 from "./pt/wiring-sweep-4";
import plugins from "./pt/plugins";
import brands from "./pt/brands";
import bpSports from "./pt/bp-sports";
import queueBasket from "./pt/queue-basket";
import liveWeb from "./pt/live-web";

import nytTv from "./pt/nyt-tv";

import gameAchievements from "./pt/game-achievements";

const pt: Record<string, string> = {
  "collections.feed.more": "Carregar mais coleções",
  "collections.feed.error": "Não foi possível carregar as coleções. Tente novamente.",
  "Show content ratings?": "Mostrar classificações de conteúdo?",
  "Age ratings and content notes when playback starts.":
    "Classificação etária e avisos de conteúdo no início da reprodução.",
  ...gameCommunity,
  ...gamePokemon,
  ...torrentDialog,
  "nav.games": "Jogos",
  "games.explore": "Explorar",
  "games.library": "Biblioteca",
  "games.saved": "Favoritos",
  "games.download.nav": "Downloads",
  "games.search": "Buscar jogos",
  ...gameAudience,
  ...gameHub,
  ...floatingPlayer,
  ...gameAntiCheat,
  Translations: "Traduções",
  "Translating…": "Traduzindo…",
  "Showing {lang}": "Mostrando {lang}",
  "Show all": "Mostrar tudo",
  "games.download.speed.title": "Velocidade de download",
  "games.download.speed.note":
    "Compartilhada entre downloads diretos e torrents deste perfil. O limite individual de um torrent pode ser menor.",
  "games.download.speed.unlimited": "Sem limite",
  "games.download.speed.limited": "Limitar velocidade",
  "games.download.speed.rate": "Quilobytes por segundo",
  "games.download.speed.range": "Digite um número inteiro de {min} a {max}.",
  "games.download.speed.error":
    "Não foi possível carregar ou salvar o ajuste de velocidade. Tente novamente.",
  "games.download.speed.current": "Velocidade de download: {rate}",
  "games.discovery.sale.cards.included": "Cartas colecionáveis",
  "games.discovery.sale.cards.none": "Sem cartas da promoção",
  "games.discovery.sale.cards.unknown": "Cartas não confirmadas",
  "games.discovery.sale.cards.includedNote":
    "Incluídas nas regras atuais do Steam para cartas de promoções. Abra o Steam para ver como obtê-las.",
  "games.discovery.sale.cards.noneNote":
    "As regras atuais do Steam não incluem cartas para esta promoção sazonal. Outras recompensas do evento são separadas.",
  "games.discovery.sale.cards.unknownNote":
    "Não foi possível verificar as regras atuais do Steam para cartas. Abra o Steam para conferir a disponibilidade.",
  "games.discovery.sale.cards.badgeNote":
    "Reúna um conjunto para criar uma insígnia da promoção, um emoticon e um plano de fundo do perfil.",
  "games.download.storage.title": "Espaço para downloads",
  "games.download.storage.note":
    "As estimativas incluem downloads diretos, torrents e arquivos temporários, incluindo downloads pausados. Instaladores externos não estão incluídos.",
  "games.download.storage.error": "Não foi possível verificar o armazenamento.",
  "games.download.storage.unavailable": "Espaço livre indisponível",
  "games.download.storage.free": "{size} livres",
  "games.download.storage.remaining": "Espaço adicional: {size}",
  "games.download.storage.estimate":
    "Alguns arquivos existentes ainda não foram verificados. O espaço necessário pode ser menor.",
  "games.download.storage.unknown": "Tamanho desconhecido: {count} arquivos",
  "games.download.storage.other": "{size} reservados por outras operações do Harbor",
  "games.download.storage.shortfall": "São necessários mais {size} de espaço",
  "games.download.state.retrying": "Tentando conectar novamente",
  "games.download.queueOrder": "Posição na fila: {position}",
  "games.download.earlier": "Mover {name} para antes",
  "games.download.later": "Mover {name} para depois",
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
    "{count} de {total} jogos foram atualizados. Os demais jogos continuam selecionados; tente novamente.",
  "games.selection.failed": "Não foi possível atualizar os jogos selecionados. Tente novamente.",
  "games.custom.nav": "Jogos locais",
  "games.libraryPersonal.visibility": "Visibilidade na biblioteca",
  "games.libraryPersonal.visible": "Seus jogos",
  "games.libraryPersonal.pinned": "Fixados",
  "games.libraryPersonal.hidden": "Ocultos",
  "games.library.sort": "Ordenar biblioteca",
  "games.selection.start": "Selecionar",
  "games.selection.game": "Selecionar {name}",
  "games.selection.actions": "Ações dos jogos selecionados",
  "games.selection.count": "{count} selecionados",
  "games.selection.clear": "Limpar seleção",
  "games.selection.all": "Selecionar todos ({count})",
  "games.selection.pinned": "Jogos fixados: {count}.",
  "games.selection.unpinned": "Jogos desafixados: {count}.",
  "games.selection.hidden": "Jogos ocultados: {count}. Encontre-os em Ocultos.",
  "games.selection.shown": "Jogos exibidos na sua biblioteca: {count}.",
  "games.selection.show": "Mostrar na biblioteca",
  "games.selection.hide": "Ocultar",
  "games.selection.pin": "Fixar",
  "games.selection.unpin": "Desafixar",
  "games.selection.matchNote":
    "Alguns jogos selecionados estão indisponíveis. Atualize sua biblioteca e tente novamente.",
  "games.selection.collection": "Adicionar à coleção",
  "games.collections.localMissing": "Não está mais na biblioteca deste perfil",
  "games.collections.dynamic": "Coleção baseada em filtros",
  "games.collections.manual": "Escolher os jogos",
  "games.collections.type": "Tipo de coleção",
  "games.collections.filters": "Filtros da coleção",
  "games.collections.ruleQuery": "O título do jogo contém",
  "games.collections.autoNote":
    "Os jogos entram ou saem desta coleção automaticamente conforme correspondem aos filtros na sua biblioteca.",
  "games.collections.pickerAutoNote":
    "As coleções baseadas em filtros são atualizadas automaticamente. Gerencie seus filtros em Coleções.",
  "games.collections.matches": "Jogos correspondentes: {count}",
  "games.collections.emptyDynamic":
    "Nenhum jogo da biblioteca corresponde a estes filtros. Altere os filtros ou adicione mais jogos à biblioteca.",
  "games.collections.collections_rules":
    "Não foi possível ler os filtros desta coleção. Os dados salvos não foram substituídos.",
  "games.collections.collections_dynamic":
    "Esta coleção é atualizada automaticamente. Altere seus filtros em Coleções para mudar os jogos que aparecem.",
  "games.collections.title": "Coleções",
  "games.collections.personal": "Criadas por você",
  "games.collections.note":
    "Um lugar para cada tipo de jogo. Agrupe favoritos, jogos para depois e mundos que merecem outra visita.",
  "games.collections.addTo": "Adicionar à coleção",
  "games.collections.count": "{count} jogos",
  "games.collections.one": "1 jogo",
  "games.collections.search": "Buscar nas suas coleções",
  "games.collections.name": "Nome da coleção",
  "games.collections.newName": "Dê um nome à nova coleção",
  "games.collections.create": "Criar",
  "games.collections.first": "Sua primeira coleção começa aqui.",
  "games.collections.noMatches": "Nenhuma coleção correspondente.",
  "games.collections.pickerNote":
    "Escolha quantas quiser. As alterações são salvas conforme você faz as escolhas.",
  "games.collections.empty": "Espaço para sua próxima paixão.",
  "games.collections.findGames": "Encontrar jogos",
  "games.collections.description": "Algumas palavras sobre ela",
  "games.collections.edit": "Editar coleção",
  "games.collections.pin": "Fixar coleção",
  "games.collections.unpin": "Desafixar coleção",
  "games.collections.remove": "Remover coleção",
  "games.collections.removeNote":
    "Apenas esta coleção é removida. Seus jogos, arquivos salvos, downloads e outras coleções permanecem.",
  "games.collections.confirmRemove": "Remover esta coleção",
  "games.collections.removeGame": "Remover {name} desta coleção",
  "games.collections.removeShort": "Remover da coleção",
  "games.collections.added": "Adicionados recentemente primeiro",
  "games.collections.done": "Concluído",
  "games.collections.save": "Salvar alterações",
  "games.collections.collections_name":
    "Dê à coleção um nome de 1–80 caracteres e uma descrição de até 240 caracteres.",
  "games.collections.collections_duplicate": "Você já tem uma coleção com esse nome.",
  "games.collections.collections_limit":
    "Este perfil atingiu o limite de armazenamento de coleções. Remova coleções ou jogos que não usa e tente novamente.",
  "games.collections.collections_missing": "Esta coleção foi removida. Escolha outra.",
  "games.collections.collections_read":
    "Não foi possível ler suas coleções. Os dados salvos não foram substituídos. Tente carregá-las novamente.",
  "games.collections.collections_write":
    "Não foi possível salvar a alteração. Sua coleção anterior continua aqui. Libere espaço no dispositivo e tente novamente.",
  "games.collections.collections_game":
    "Não foi possível identificar este jogo. Atualize sua biblioteca e tente novamente.",
  "games.collections.firstNote":
    "Crie uma coleção e adicione jogos pelas páginas de detalhes ou selecione-os na sua biblioteca. Jogos de PC e ROMs podem ficar juntos.",
  "games.collections.emptyNote":
    "Adicione jogos pelas páginas de detalhes ou selecione jogos na sua biblioteca e escolha Adicionar à coleção.",
  "games.cache.saved": "Dados salvos · {date}",
  "games.cache.refresh": "Atualizar",
  "games.cache.refreshing": "Atualizando…",
  "games.cache.price": "Abra o Steam para conferir o preço atual.",
  ...mediaStart,
  ...spooktober,
  ...videoCast,
  ...music,
  ...contextActionsFallback,

  ...ebookSources,
  ...coverage,
  ...subtitles,
  ...chrome,
  ...common,
  ...catalog,
  ...detail,
  ...player,
  ...live,
  ...settings,
  ...settingsFill,
  ...profileFill,
  ...appFill,
  ...library,
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
  ...extra,
  ...manga,
  ...controllers,
  ...bpSources,
  ...used,
  ...sweep,
  ...sourceCoverage,
  ...wired,
  ...wiringSweep,
  ...wiringSweep2,
  ...wiringSweep3,
  ...wiringSweep4,
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
  "games.torrent.share.title": "Compartilhar torrent",
  "games.torrent.share.note":
    "Compartilhe arquivos verificados com outros pares. Para ao atingir um limite ou fechar o Harbor. Pare o compartilhamento antes de alterar os arquivos.",
  "games.torrent.share.upload": "Limite de envio (KB/s)",
  "games.torrent.share.ratio": "Proporção (1–10)",
  "games.torrent.share.minutes": "Limite de tempo (minutos)",
  "games.torrent.share.start": "Iniciar compartilhamento",
  "games.torrent.share.stop": "Parar compartilhamento",
  "games.torrent.share.resume": "Retomar compartilhamento",
  "games.torrent.share.checking": "Verificando arquivos",
  "games.torrent.share.seeding": "Compartilhando",
  "games.torrent.share.stopped": "Compartilhamento parado",
  "games.torrent.share.limitReached": "Limite atingido",
  "games.torrent.share.failed": "Falha ao compartilhar. Verifique os arquivos e tente novamente.",
  "games.torrent.share.stats": "{uploaded} enviados · {minutes} min",
  "games.torrent.torrent_seed_files":
    "Os arquivos estão ausentes, alterados ou em uso. Verifique a pasta de downloads antes de compartilhar.",
  "games.torrent.torrent_seed_limits":
    "Escolha 32–1.048.576 KB/s, proporção de 1–10 e tempo de 1–1.440 minutos.",

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
  "Refract sync": "Sincronização do Refract",
  "Sync watched history and Harbor watchlist changes with Refract.":
    "Sincronize o histórico de exibição e as alterações na lista de títulos para assistir do Harbor com o Refract.",
  "Refract personal API key": "Chave de API pessoal do Refract",
  "Verifying...": "Verificando…",
  "Connect Refract": "Conectar Refract",
  "Refract key saved in Harbor's secret store":
    "Chave do Refract salva no armazenamento seguro do Harbor",
  "Sync watched history and watchlist": "Sincronizar histórico e lista de títulos para assistir",
  "Send watched history and watchlist changes from Harbor to Refract. Only the primary Harbor profile is synced.":
    "Envie o histórico de exibição e as alterações na lista de títulos para assistir do Harbor ao Refract. Apenas o perfil principal do Harbor é sincronizado.",
  "Retry pending watches": "Tentar enviar novamente os registros pendentes",
  "Disconnect Refract": "Desconectar Refract",
  "Connected to Refract ({identity}). Watched history sync is enabled.":
    "Conectado ao Refract ({identity}). A sincronização do histórico de exibição está ativada.",
  "Could not verify the key via Refract /v1/me. Check permissions and connectivity.":
    "Não foi possível verificar a chave pelo Refract /v1/me. Verifique as permissões e a conexão.",
  "Disconnected from Refract.": "Refract desconectado.",
  "Create a personal API key in Refract with profile:read, library:read, library:write and history:write. Never share or commit the key.":
    "Crie uma chave de API pessoal no Refract com as permissões profile:read, library:read, library:write e history:write. Nunca compartilhe a chave nem a inclua em um commit.",
  "Automatic watch threshold": "Limite para registro automático de exibição",
  "After {count} minutes": "Após {count} minutos",
  "{count}% (default)": "{count}% (padrão)",
  "Log a movie or episode in Refract when playback reaches the selected time or percentage. Seeking past it also qualifies. Early logging counts as watched in Refract, not partially watched. Harbor's own completion threshold is unchanged.":
    "Registre um filme ou episódio no Refract quando a reprodução atingir o tempo ou a porcentagem selecionada. Avançar além do limite também conta. O registro antecipado marca o conteúdo como assistido, e não como parcialmente assistido. O limite de conclusão do Harbor permanece inalterado.",
  "Harbor → Refract Plan to Watch": "Harbor → Refract: quero assistir",
  "New watchlist additions and removals are sent automatically while sync is enabled. Requires library:write; reconnect with an updated key if needed. Existing Refract history and other library statuses are preserved.":
    "Adições e remoções da lista de títulos para assistir são enviadas automaticamente enquanto a sincronização está ativa. Requer library:write; reconecte com uma chave atualizada, se necessário. O histórico existente do Refract e os demais status da biblioteca são preservados.",
  "{sent} sent · {pending} pending · {failed} unmatched":
    "{sent} enviados · {pending} pendentes · {failed} sem correspondência",
  "Unmatched items": "Itens sem correspondência",
  "Refract queue full; unable to save another watch":
    "Fila do Refract cheia; não foi possível salvar outra visualização",
  "No verified IMDb/TMDB/TVDB identity": "Nenhum ID IMDb/TMDB/TVDB verificado",
  "Movie not found in Refract": "Filme não encontrado no Refract",
  "Episode not found; verify season numbering":
    "Episódio não encontrado; verifique a numeração das temporadas",
  "Last watched item sent successfully": "Última visualização enviada com sucesso",
  "Unknown error": "Erro desconhecido",
  "Some items could not be matched or sent":
    "Alguns itens não puderam ser identificados ou enviados",
  "Refract denied access; check key and permissions":
    "O Refract negou o acesso; verifique a chave e as permissões",
  "Network error; retry scheduled": "Erro de rede; nova tentativa agendada",
  "No verified IMDb/TMDB/TVDB identity is available for this title.":
    "Não há um ID IMDb/TMDB/TVDB verificado para este título.",
  "Refract could not uniquely identify this title.":
    "O Refract não conseguiu identificar este título de forma inequívoca.",
  "Refract preserved an existing library entry or viewing history.":
    "O Refract preservou um item existente da biblioteca ou do histórico.",
  "Added to Refract Plan to Watch.": "Adicionado à lista Quero assistir do Refract.",
  "Removed from Refract Plan to Watch.": "Removido da lista Quero assistir do Refract.",
  "Refract watchlist requires library:write. Reconnect with a key that has this scope.":
    "A lista do Refract exige library:write. Reconecte com uma chave que tenha essa permissão.",
  "Refract could not confirm the watchlist change. Try again.":
    "O Refract não conseguiu confirmar a alteração na lista. Tente novamente.",
  "Refract HTTP {status}": "Refract HTTP {status}",
};

export default pt;
import videoCast from "./pt/video-cast";
