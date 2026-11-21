import { HARBOR_TRAKT_BASE } from "@/lib/config/endpoints";

export const TRAKT_API_BASE = "https://api.trakt.tv";
export const TRAKT_API_VERSION = "2";
export const TRAKT_CLIENT_ID = "wL17DxIVWSRSKgCXLJGnRvwT2c8vUcqUtxSo5u4Mt7Q";
export const TRAKT_TOKEN_PROXY = `${HARBOR_TRAKT_BASE}/api/trakt/token`;
export const TRAKT_DEVICE_TOKEN_PROXY = `${HARBOR_TRAKT_BASE}/api/trakt/device-token`;
export const TRAKT_VERIFY_URL = "https://trakt.tv/activate";
export const REFRESH_THRESHOLD_SEC = 14 * 24 * 60 * 60;
export const WRITE_MIN_INTERVAL_MS = 1000;
