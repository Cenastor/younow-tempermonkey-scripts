// ==UserScript==
// @name         YouNow Viewer Toolkit
// @namespace    https://younow.com/
// @version      1.5
// @description  Resizable YouNow viewer panel with API broadcast, fan, activity, chest, and chat tools.
// @match        https://www.younow.com/*
// @match        https://younow.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const VERSION = "1.5";
    const ROOT_ID = "younow-viewer-toolkit-v11";
    const STORE_KEY = "younowViewerToolkit_v10";
    const API_ORIGIN = "https://api.younow.com/php/api";
    const AUDIENCE_API_URL = `${API_ORIGIN}/broadcast/audience`;
    const BROADCAST_INFO_API_URL = `${API_ORIGIN}/broadcast/info`;
    const BROADCAST_ACTIVITIES_API_URL = `${API_ORIGIN}/broadcast/activities`;
    const CHANNEL_INFO_API_URL = `${API_ORIGIN}/channel/getInfo`;
    const ONLINE_FANS_API_URL = `${API_ORIGIN}/channel/getLocationOnlineFansOf`;
    const GIFTS_API_URL = `${API_ORIGIN}/channel/gifts`;
    const CHEST_API_URL = `${API_ORIGIN}/props/getCurrentChest`;
    const CHEST_PARTICIPATE_API_URL = `${API_ORIGIN}/props/propsChestParticipate`;
    const CHEST_FIRST_PLAY_API_URL = `${API_ORIGIN}/props/propsChestFirstPlay`;
    const CHAT_API_URL = `${API_ORIGIN}/broadcast/chat`;
    const API_REFRESH_INTERVAL_MS = 3000;
    const EXTRA_API_REFRESH_INTERVAL_MS = 15000;
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const DEFAULTS = {
        minimized: false,
        left: null,
        top: 90,
        width: 340,
        height: 620,
        theatre: false,
        chatHidden: false,
        chatZoom: 1,
        autoChestEnabled: false
    };

    let settings = loadSettings();
    let panel = null;
    let chatTarget = null;
    let lastChatPreviewHash = "";
    let theatreTarget = null;
    let infoTimer = null;
    let apiTimer = null;
    let lastVideo = null;
    let apiSnapshot = null;
    let apiContextKey = "";
    let apiRequestInFlight = false;
    let apiLastFetchAt = 0;
    let extraApiLastFetchAt = 0;
    let apiPageUrl = String(location.href || "");
    let apiRequestError = "";
    let apiLastChestId = "";
    let chestActionPending = false;
    let previousApiChestReady = false;
    let apiChestReadyCycle = 0;
    let lastAutoChestCycle = 0;
    let participatedChestId = "";
    let firstPlayHandled = false;
    let lastChestWinner = "";
    let chatSendPending = false;
    let resizeSaveTimer = null;

    function loadSettings() {
        try {
            const saved = GM_getValue(STORE_KEY, {});
            return Object.assign({}, DEFAULTS, saved && typeof saved === "object" ? saved : {});
        } catch (_) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function saveSettings() {
        try { GM_setValue(STORE_KEY, settings); } catch (_) {}
    }

    function addStyle(css) {
        try {
            if (typeof GM_addStyle === "function") {
                GM_addStyle(css);
                return;
            }
        } catch (_) {}
        const style = document.createElement("style");
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function isVisible(element) {
        if (!element) return false;
        try {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" &&
                Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        } catch (_) {
            return false;
        }
    }

    function textOf(element) {
        return String(element?.innerText || element?.textContent || "")
            .replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }

    function findVideo() {
        const videos = Array.from(document.querySelectorAll("video"))
            .filter(video => isVisible(video) && video.getBoundingClientRect().width > 180);
        videos.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
        });
        lastVideo = videos[0] || null;
        return lastVideo;
    }

    // Prefer the exact chat input used by the existing chest helper, then fall back to labels.
    function findChatInput() {
        const exact = document.querySelector('textarea[aria-label="Chat input text"]');
        if (isVisible(exact) && !panel?.contains(exact)) return exact;
        return Array.from(document.querySelectorAll("textarea,input,[contenteditable='true']"))
            .find(element => {
                if (panel?.contains(element)) return false;
                if (!isVisible(element)) return false;
                const label = element.getAttribute("aria-label") || "";
                const placeholder = element.getAttribute("placeholder") || "";
                return /chat input/i.test(label) || /chat with/i.test(placeholder) ||
                    /chat/i.test(label + " " + placeholder);
            }) || null;
    }

    function findChatPanel() {
        const input = findChatInput();
        if (!input) return null;
        let node = input.parentElement;
        let best = null;
        for (let depth = 0; node && node !== document.body && depth < 9; depth++, node = node.parentElement) {
            if (!isVisible(node)) continue;
            const rect = node.getBoundingClientRect();
            const marker = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
            const named = /chat|sidebar|comment/i.test(marker);
            if (named && rect.width >= 180 && rect.height >= 150) {
                best = node;
                if (/chat/i.test(marker)) break;
            }
        }
        return best;
    }

    function getChatMessageRows(root) {
        if (!root) return [];
        const lists = [root, ...Array.from(root.querySelectorAll("ul,ol,[role='list']"))];
        const candidates = lists.map(list => ({
            list,
            rows: Array.from(list.children).filter(child =>
                child.tagName === "LI" || child.getAttribute("role") === "listitem")
        })).filter(candidate => candidate.rows.length);
        candidates.sort((a, b) => b.rows.length - a.rows.length);
        const rows = candidates[0]?.rows || [];
        return rows.filter(row => {
            const value = textOf(row);
            return value.length > 1 && !/^\d+$/.test(value);
        });
    }

    function renderChatPreview() {
        const output = panel?.querySelector('[data-field="chat-messages"]');
        if (!output) return;
        const root = chatTarget?.isConnected ? chatTarget : findChatPanel();
        const messages = getChatMessageRows(root).map(textOf).filter(Boolean).slice(-12);
        for (const message of messages) rememberChestWinner(message);
        if (!messages.length) {
            output.textContent = root ? "Waiting for chat messages…" : "Chat feed not detected";
            setField("chat-count", "0");
            lastChatPreviewHash = "";
            return;
        }
        const hash = messages.join("\n");
        if (hash === lastChatPreviewHash) return;
        const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
        output.replaceChildren(...messages.map(message => {
            const line = document.createElement("div");
            line.className = "ynvt-chat-line";
            line.textContent = message;
            return line;
        }));
        if (nearBottom) output.scrollTop = output.scrollHeight;
        else output.scrollTop = Math.min(output.scrollTop, output.scrollHeight);
        setField("chat-count", String(messages.length));
        lastChatPreviewHash = hash;
    }

    function rememberChestWinner(value, fromWinnersPanel = false) {
        const message = String(value || "").replace(/\s+/g, " ").trim();
        if (!message || message.length > 500) return;
        if (fromWinnersPanel && /\bwinners\b!?/i.test(message) && message.replace(/\bwinners\b!?/i, "").trim().length > 3) {
            lastChestWinner = `Chest results: ${message}`.slice(0, 180);
            return;
        }
        if (/\bchest\b/i.test(message) && /\b(won|winner|winning|congratulations|congrats|draw)\b/i.test(message)) {
            lastChestWinner = message.slice(0, 180);
        }
    }

    function readVisibleChestWinners() {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"],.modal,.dialog,[class*="modal"],[class*="drawer"],[class*="winner"]'))
            .filter(isVisible);
        const panelText = dialogs.map(textOf).find(text => /\bwinners\b!?/i.test(text) && text.length > 12 && text.length < 900);
        if (panelText) rememberChestWinner(panelText, true);
        if (lastChestWinner) return;
        const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
            .find(element => isVisible(element) && /^winners!?$/i.test(textOf(element)));
        if (!heading) return;
        let node = heading.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
            const text = textOf(node);
            if (/\bwinners\b!?/i.test(text) && text.length > 12 && text.length < 900) {
                rememberChestWinner(text, true);
                return;
            }
        }
    }

    function findNamedFan(value, depth = 0) {
        if (!value || typeof value !== "object" || depth > 3) return "";
        const keys = ["username", "userName", "displayName", "display_name", "screenName", "nickname", "handle", "name"];
        for (const key of keys) {
            const candidate = value[key];
            if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 60);
        }
        for (const key of ["user", "fan", "profile", "broadcaster", "channel"])
            if (value[key] && typeof value[key] === "object") {
                const nested = findNamedFan(value[key], depth + 1);
                if (nested) return nested;
            }
        return "";
    }

    function findFanScore(value) {
        if (!value || typeof value !== "object") return null;
        const keys = ["fanScore", "fanPoints", "score", "points", "likes", "likesCount", "bars", "pearls", "value"];
        for (const key of keys) {
            if (value[key] === null || value[key] === undefined || value[key] === "") continue;
            const score = Number(value[key]);
            if (Number.isFinite(score) && score >= 0) return score;
        }
        return null;
    }

    function collectArrays(value, keyPattern, result = [], seen = new Set(), depth = 0) {
        if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return result;
        seen.add(value);
        if (Array.isArray(value)) {
            result.push({ key: "", value });
            for (const item of value) collectArrays(item, keyPattern, result, seen, depth + 1);
            return result;
        }
        for (const [key, child] of Object.entries(value)) {
            if (Array.isArray(child) && keyPattern.test(key)) result.push({ key, value: child });
            collectArrays(child, keyPattern, result, seen, depth + 1);
        }
        return result;
    }

    function collectExplicitTopFans(value, result = [], seen = new Set(), depth = 0) {
        if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return result;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collectExplicitTopFans(item, result, seen, depth + 1);
            return result;
        }
        for (const [key, child] of Object.entries(value)) {
            if (/^top.?fans?$/i.test(key) && child && typeof child === "object") {
                const records = Array.isArray(child) ? child : [child];
                for (const item of records) {
                    const name = findNamedFan(item);
                    if (name) result.push({ name, score: findFanScore(item), source: "top" });
                }
            }
            if (child && typeof child === "object") collectExplicitTopFans(child, result, seen, depth + 1);
        }
        return result;
    }

    function extractTopFans(...payloads) {
        const entries = [];
        for (const payload of payloads) {
            if (!payload) continue;
            entries.push(...collectExplicitTopFans(payload));
            const arrays = collectArrays(payload, /top.?fans?|online.?fans?|fans|users|records|items/i);
            for (const group of arrays) {
                for (const item of group.value) {
                    const name = findNamedFan(item);
                    if (!name) continue;
                    entries.push({ name, score: findFanScore(item), source: "online" });
                }
            }
        }
        const byName = new Map();
        for (const item of entries) {
            const key = item.name.toLowerCase();
            const previous = byName.get(key);
            if (!previous || item.source === "top" ||
                (previous.source !== "top" && previous.score === null && item.score !== null)) byName.set(key, item);
        }
        const unique = Array.from(byName.values());
        if (unique.some(item => item.score !== null)) unique.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        return unique.slice(0, 5);
    }

    function extractTextEntries(value, result = [], seen = new Set(), depth = 0) {
        if (typeof value === "string") {
            const text = value.replace(/\s+/g, " ").trim();
            if (text && text.length <= 500) result.push(text);
            return result;
        }
        if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return result;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) extractTextEntries(item, result, seen, depth + 1);
            return result;
        }
        for (const [key, child] of Object.entries(value)) {
            if (typeof child === "string" && /^(message|text|description|activity|content|title|comment)$/i.test(key)) {
                const text = child.replace(/\s+/g, " ").trim();
                if (text && text.length <= 500) result.push(text);
            } else if (child && typeof child === "object") {
                extractTextEntries(child, result, seen, depth + 1);
            }
        }
        return result;
    }

    function findNumericValue(value, keyPattern, seen = new Set(), depth = 0) {
        if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return null;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            if (keyPattern.test(key)) {
                if (child === null || child === undefined || child === "" || typeof child === "object") continue;
                const number = Number(child);
                if (Number.isFinite(number) && number >= 0) return number;
            }
            if (child && typeof child === "object") {
                const nested = findNumericValue(child, keyPattern, seen, depth + 1);
                if (nested !== null) return nested;
            }
        }
        return null;
    }

    function extractGiftOptions(value, result = [], seen = new Set(), depth = 0) {
        if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return result;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) extractGiftOptions(item, result, seen, depth + 1);
            return result;
        }
        const gameType = String(value.itemGameType || value.gameType || "").toUpperCase();
        const costType = String(value.costType || value.currencyType || value.currency || "").toUpperCase();
        let name = [value.displayName, value.itemName, value.name, value.title]
            .find(candidate => typeof candidate === "string" && candidate.trim()) || "";
        if (!name && gameType.includes("PEARL_TIP")) name = "Pearl Tip";
        else if (!name && gameType === "TIP") name = "Tip";
        if (name && (costType || gameType) && /pearl\s*tip|\btip\b/i.test(name)) {
            const costValue = value.cost ?? value.price ?? value.amount ?? value.itemCost ?? value.costAmount;
            const cost = costValue === null || costValue === undefined || costValue === "" ? null : Number(costValue);
            result.push({
                name: name.trim().slice(0, 50),
                cost: Number.isFinite(cost) && cost >= 0 ? cost : null,
                currency: costType || (gameType.includes("PEARL") ? "PEARLS" : "BARS")
            });
        }
        for (const child of Object.values(value))
            if (child && typeof child === "object") extractGiftOptions(child, result, seen, depth + 1);
        return result;
    }

    function findPageFanButton() {
        const wrapper = document.getElementById("fanButtonWrapper");
        if (isVisible(wrapper)) {
            if (wrapper.matches("button,[role='button']")) return wrapper;
            const nested = wrapper.querySelector("button,[role='button']");
            if (isVisible(nested)) return nested;
        }
        return Array.from(document.querySelectorAll("button,[role='button']"))
            .filter(element => isVisible(element) && !panel?.contains(element))
            .find(element => /\bfan button\b/i.test([
                element.getAttribute("aria-label") || "",
                element.getAttribute("title") || "",
                textOf(element)
            ].join(" "))) || null;
    }

    function isAlreadyFan(button) {
        if (!button) return false;
        const label = [button.getAttribute("aria-label") || "", button.getAttribute("title") || "", textOf(button)].join(" ");
        const stateClass = typeof button.className === "string" ? button.className : "";
        return button.getAttribute("aria-pressed") === "true" ||
            /\b(unfan|following|already a fan)\b/i.test(label) ||
            /(?:is[-_]?fan|fanned|following)/i.test(stateClass);
    }

    function fanBroadcaster() {
        const button = findPageFanButton();
        if (!button) return setAction("YouNow Fan button not found on this broadcast");
        if (button.disabled) return setAction("YouNow has disabled the Fan button");
        if (isAlreadyFan(button)) return setAction("You are already a fan of this broadcaster");
        button.click();
        setAction("Fan action sent through YouNow");
    }

    function findPageGiftButton() {
        const controls = Array.from(document.querySelectorAll("button,[role='button']"))
            .filter(element => isVisible(element) && !panel?.contains(element));
        return controls.find(element => {
            const text = textOf(element).replace(/\bBONUS\b/gi, "").trim();
            const aria = String(element.getAttribute("aria-label") || "").trim();
            const title = String(element.getAttribute("title") || "").trim();
            return /^(gift|send gift|give a gift)$/i.test(text) ||
                /^(gift|send gift|give a gift)$/i.test(aria) ||
                /^(gift|send gift|give a gift)$/i.test(title);
        }) || null;
    }

    function openGiftPicker(currency) {
        const button = findPageGiftButton();
        if (!button) return setAction("YouNow Gift button not found on this page");
        button.click();
        const giftName = currency === "pearls" ? "Pearl Tip (Pearls)" : "Tip (Bars)";
        setAction(`Gift picker opened — choose ${giftName} and review the amount before sending`);
    }

    function findPlayerContainer(video) {
        if (!video) return null;
        let node = video.parentElement;
        let best = video;
        for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            const marker = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
            if (/player|broadcast|video/i.test(marker) && rect.width >= 220 && rect.height >= 120) {
                best = node;
                if (/player|broadcast/i.test(marker)) break;
            }
        }
        return best;
    }

    function isOwnBroadcast() {
        const context = apiSnapshot?.context || getApiContext();
        return Boolean(context && (context.broadcaster === "1" || context.userId === context.channelId));
    }

    function getChestIdentity(chest) {
        if (!chest) return "";
        const explicitId = String(chest.id || chest.chestId || "");
        if (explicitId) return explicitId;
        const channelId = String(chest.channelId || apiSnapshot?.context?.channelId || "");
        if (!channelId) return "";
        const state = String(chest.state || "").toUpperCase();
        return state === "CHEST_OPEN" ? `${channelId}:OPEN:${apiChestReadyCycle}` : `${channelId}:${state}`;
    }

    function getViewerChestInfo() {
        const chest = apiSnapshot?.chest || null;
        if (isOwnBroadcast()) return { label: "Your broadcast", chest, viewerReady: false, broadcasterReady: false, participated: false };
        if (!apiSnapshot?.chestLoaded) {
            return { label: apiRequestError ? "API unavailable" : "Loading API data", chest, viewerReady: false, broadcasterReady: false, participated: false };
        }
        if (!chest) return { label: "No chest", chest: null, viewerReady: false, broadcasterReady: false, participated: false };

        const chestId = getChestIdentity(chest);
        const participated = Boolean(chestId && participatedChestId === chestId);
        const state = String(chest.state || "").toUpperCase();
        const likes = Number.isFinite(Number(chest.likes)) ? Number(chest.likes) : null;
        const threshold = Number.isFinite(Number(chest.minLikesToAvailable)) ? Number(chest.minLikesToAvailable) : null;
        const count = likes === null ? "" : ` (${formatCount(likes)}${threshold === null ? "" : ` / ${formatCount(threshold)}`})`;
        if (participated) return { label: `Entered — waiting for results${count}`, chest, viewerReady: false, broadcasterReady: false, participated: true };
        if (state === "CHEST_OPEN") return { label: `Open to viewers${count}`, chest, viewerReady: true, broadcasterReady: false, participated: false };
        if (state === "CHEST_AVAILABLE") return { label: `Available to broadcaster${count}`, chest, viewerReady: false, broadcasterReady: true, participated: false };
        if (state === "WAITING_FOR_RESULTS") return { label: `Waiting for results${count}`, chest, viewerReady: false, broadcasterReady: false, participated: false };
        if (state === "CHEST_UNAVAILABLE") return { label: `Inactive${count}`, chest, viewerReady: false, broadcasterReady: false, participated: false };
        return { label: `${state || "Chest state unknown"}${count}`, chest, viewerReady: false, broadcasterReady: false, participated: false };
    }

    async function participateInOpenChest(context, chestId) {
        if (!firstPlayHandled) {
            const firstPlayUrl = `${CHEST_FIRST_PLAY_API_URL}/userId=${encodeURIComponent(context.userId)}`;
            const firstPlayPayload = await fetchApiJson(firstPlayUrl, {
                method: "GET",
                credentials: "include",
                cache: "no-store"
            });
            if (Number(firstPlayPayload.errorCode) === 0) {
                firstPlayHandled = true;
                return "first-play";
            }
            if (Number(firstPlayPayload.errorCode) !== 8004) {
                throw new Error(String(firstPlayPayload.errorMsg || firstPlayPayload.message || `First-play API error ${firstPlayPayload.errorCode}`));
            }
            firstPlayHandled = true;
        }
        const formData = new URLSearchParams();
        formData.set("userId", String(Number(context.userId)));
        formData.set("channelId", String(Number(context.channelId)));
        formData.set("lang", getApiLanguage());
        const trpxId = getStoredYouNowValue("TRPX_ID");
        const trpxDeviceId = getStoredYouNowValue("TRPX_DEVICE_ID");
        if (trpxId) formData.set("tsi", trpxId);
        if (trpxDeviceId) formData.set("tdi", trpxDeviceId);
        const headers = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
        const requestBy = getStoredYouNowValue("REQUEST_BY");
        if (requestBy) headers["X-Requested-By"] = requestBy;

        const payload = await fetchApiJson(CHEST_PARTICIPATE_API_URL, {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers,
            body: formData.toString()
        });
        if (Number(payload.errorCode) !== 0 || !Number(payload.participatingScore)) {
            throw new Error(String(payload.errorMsg || payload.errorMessage || payload.message || `Chest entry failed (${payload.errorCode ?? "no score"})`));
        }
        participatedChestId = String(chestId || payload.id || getChestIdentity(apiSnapshot?.chest));
        return "entered";
    }

    async function openViewerChest(automatic = false) {
        if (chestActionPending) return;
        const info = getViewerChestInfo();
        const context = apiSnapshot?.context || getApiContext();
        if (isOwnBroadcast()) {
            setAction("Viewer chest entry is disabled on your broadcast");
            return;
        }
        if (!context || !info.chest || info.participated || (automatic && !info.viewerReady)) {
            if (!automatic) setAction(!context
                ? "Waiting for a valid YouNow user and channel ID"
                : !info.chest
                    ? "YouNow has not returned chest data yet"
                    : info.participated
                        ? "You already entered this chest"
                        : "No chest entry is available yet");
            return;
        }
        if (automatic && (!settings.autoChestEnabled || apiChestReadyCycle === lastAutoChestCycle)) return;

        chestActionPending = true;
        lastAutoChestCycle = apiChestReadyCycle;
        syncButtons();
        try {
            let result = await participateInOpenChest(context, getChestIdentity(info.chest));
            if (result === "first-play") {
                result = await participateInOpenChest(context, getChestIdentity(info.chest));
            }
            setAction(result === "first-play"
                ? "First-time chest reward collected — tap again to enter"
                : "Entered the chest draw");
            await refreshApiInfo(true);
        } catch (error) {
            setAction(`Chest API action failed: ${String(error?.message || "unknown error")}`);
        } finally {
            chestActionPending = false;
            updateInfo();
        }
    }

    function pollViewerChest() {
        void refreshApiInfo(true);
    }

    function getApiRouteParameter(resourceName, parameterName) {
        try {
            const parsed = new URL(resourceName, pageWindow.location.href);
            const prefix = `${parameterName}=`;
            const segment = parsed.pathname.split("/").find(item => item.startsWith(prefix));
            if (segment) return decodeURIComponent(segment.slice(prefix.length));
            return parsed.searchParams.get(parameterName);
        } catch (_) {
            return null;
        }
    }

    function findLatestApiParameter(routePart, parameterName) {
        try {
            const entries = pageWindow.performance.getEntriesByType("resource")
                .filter(entry => typeof entry.name === "string" && entry.name.includes(routePart))
                .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
            for (const entry of entries) {
                const value = getApiRouteParameter(entry.name, parameterName);
                if (value) return value;
            }
        } catch (_) {}
        return null;
    }

    function findLatestNumericApiParameter(routePart, parameterName) {
        try {
            const entries = pageWindow.performance.getEntriesByType("resource")
                .filter(entry => typeof entry.name === "string" && entry.name.includes(routePart))
                .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
            for (const entry of entries) {
                const value = getApiRouteParameter(entry.name, parameterName);
                if (!/^\d+$/.test(String(value || ""))) continue;
                const number = Number(value);
                if (Number.isSafeInteger(number) && number > 0) return String(number);
            }
        } catch (_) {}
        return null;
    }

    function getApiContext() {
        const audienceRoute = "/php/api/broadcast/audience/";
        const userId = findLatestNumericApiParameter("/php/api/younow/notificationCount", "userId") ||
            findLatestNumericApiParameter(audienceRoute, "userId");
        const channelId = findLatestNumericApiParameter("/php/api/channel/getStickers", "channelId") ||
            findLatestNumericApiParameter(audienceRoute, "channelId");
        const broadcaster = findLatestApiParameter(audienceRoute, "broadcaster") || "0";
        if (!userId || !channelId) return null;
        const userNumber = Number(userId);
        const channelNumber = Number(channelId);
        if (!Number.isSafeInteger(userNumber) || userNumber <= 0 ||
            !Number.isSafeInteger(channelNumber) || channelNumber <= 0) return null;
        return { userId: String(userNumber), channelId: String(channelNumber), broadcaster: String(broadcaster) };
    }

    function getBroadcastSlug() {
        try {
            const first = decodeURIComponent(String(pageWindow.location.pathname || "").split("/").filter(Boolean)[0] || "");
            if (!first || /^(explore|broadcast|leaderboards|login|signup|settings|home)$/i.test(first)) return "";
            return /^[\w.-]+$/.test(first) ? first : "";
        } catch (_) {
            return "";
        }
    }
    function getStoredYouNowValue(key) {
        try {
            const raw = pageWindow.localStorage.getItem(key);
            if (raw === null || raw === undefined) return "";
            try { return String(JSON.parse(raw) ?? ""); } catch (_) { return String(raw); }
        } catch (_) {
            return "";
        }
    }

    function getApiLanguage() {
        const stored = getStoredYouNowValue("UI_LANGUAGE");
        const language = stored || String(document.documentElement.lang || "en");
        return /^[a-z]{2}(?:-[a-z]{2})?$/i.test(language) ? language : "en";
    }

    function formatCount(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.round(number).toLocaleString() : "—";
    }

    async function fetchApiJson(url, options) {
        const pageFetch = pageWindow.fetch;
        if (typeof pageFetch !== "function") throw new Error("Browser fetch is unavailable");
        const response = await pageFetch.call(pageWindow, url, options);
        let payload = null;
        try { payload = await response.json(); } catch (_) {}
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!payload || typeof payload !== "object") throw new Error("Invalid API response");
        return payload;
    }

    function updateChestReadiness() {
        const info = getViewerChestInfo();
        const chestId = String(info.chest?.id || "");
        const ready = Boolean(info.viewerReady && getChestIdentity(info.chest));
        const chestChanged = Boolean(chestId && chestId !== apiLastChestId);
        if (ready && (!previousApiChestReady || chestChanged)) apiChestReadyCycle++;
        previousApiChestReady = ready;
        apiLastChestId = chestId;
        if (settings.autoChestEnabled && ready && apiChestReadyCycle !== lastAutoChestCycle && !chestActionPending) {
            void openViewerChest(true);
        }
    }

    async function refreshApiInfo(force = false) {
        const pageUrl = String(pageWindow.location.href || "");
        if (pageUrl !== apiPageUrl) {
            apiPageUrl = pageUrl;
            apiSnapshot = null;
            apiContextKey = "";
            apiRequestError = "";
            previousApiChestReady = false;
            apiLastChestId = "";
            apiChestReadyCycle = 0;
            lastAutoChestCycle = 0;
            participatedChestId = "";
            firstPlayHandled = false;
            lastChestWinner = "";
            extraApiLastFetchAt = 0;
        }
        if (apiRequestInFlight || (!force && Date.now() - apiLastFetchAt < API_REFRESH_INTERVAL_MS)) return;
        apiLastFetchAt = Date.now();
        const context = getApiContext();
        if (!context) {
            apiRequestError = "Waiting for broadcast API context";
            updateInfo();
            return;
        }
        const contextKey = `${context.userId}:${context.channelId}`;
        if (contextKey !== apiContextKey) {
            apiContextKey = contextKey;
            apiSnapshot = null;
            participatedChestId = "";
            firstPlayHandled = false;
            lastChestWinner = "";
            extraApiLastFetchAt = 0;
            previousApiChestReady = false;
            apiLastChestId = "";
            apiChestReadyCycle = 0;
            lastAutoChestCycle = 0;
        }

        const language = encodeURIComponent(getApiLanguage());
        const audienceUrl = `${AUDIENCE_API_URL}/broadcaster=${encodeURIComponent(context.broadcaster)}` +
            `/channelId=${encodeURIComponent(context.channelId)}/lang=${language}/start=0/userId=${encodeURIComponent(context.userId)}`;
        const chestUrl = `${CHEST_API_URL}/userId=${encodeURIComponent(context.userId)}` +
            `/channelId=${encodeURIComponent(context.channelId)}`;
        const broadcastSlug = getBroadcastSlug();
        const broadcastInfoUrl = broadcastSlug
            ? `${BROADCAST_INFO_API_URL}/curId=0/lang=${language}/user=${encodeURIComponent(broadcastSlug)}`
            : "";
        const extraApiDue = force || Date.now() - extraApiLastFetchAt >= EXTRA_API_REFRESH_INTERVAL_MS;
        const channelInfoUrl = `${CHANNEL_INFO_API_URL}/channelId=${encodeURIComponent(context.channelId)}/lang=${language}`;
        const onlineFansUrl = `${ONLINE_FANS_API_URL}/channelId=${encodeURIComponent(context.channelId)}` +
            `/lang=${language}/numberOfRecords=50`;
        const activitiesUrl = `${BROADCAST_ACTIVITIES_API_URL}/channelId=${encodeURIComponent(context.channelId)}` +
            `/lang=${language}/userId=${encodeURIComponent(context.userId)}`;
        const giftsUrl = `${GIFTS_API_URL}/lang=${language}/userId=${encodeURIComponent(context.userId)}`;
        const requestPageUrl = pageUrl;
        apiRequestInFlight = true;
        if (extraApiDue) extraApiLastFetchAt = Date.now();
        try {
            const results = await Promise.allSettled([
                fetchApiJson(audienceUrl, { method: "GET", credentials: "include", cache: "no-store" }),
                fetchApiJson(chestUrl, { method: "GET", credentials: "include", cache: "no-store" }),
                broadcastInfoUrl
                    ? fetchApiJson(broadcastInfoUrl, { method: "GET", credentials: "include", cache: "no-store" })
                    : Promise.resolve(null),
                extraApiDue
                    ? fetchApiJson(channelInfoUrl, { method: "GET", credentials: "include", cache: "no-store" })
                    : Promise.resolve(null),
                extraApiDue
                    ? fetchApiJson(onlineFansUrl, { method: "GET", credentials: "include", cache: "no-store" })
                    : Promise.resolve(null),
                extraApiDue
                    ? fetchApiJson(activitiesUrl, { method: "GET", credentials: "include", cache: "no-store" })
                    : Promise.resolve(null),
                extraApiDue
                    ? fetchApiJson(giftsUrl, { method: "GET", credentials: "include", cache: "no-store" })
                    : Promise.resolve(null)
            ]);
            if (String(pageWindow.location.href || "") !== requestPageUrl || contextKey !== apiContextKey) return;

            const audiencePayload = results[0].status === "fulfilled" ? results[0].value : null;
            const chestPayload = results[1].status === "fulfilled" ? results[1].value : null;
            const broadcastInfoPayload = results[2].status === "fulfilled" ? results[2].value : null;
            const channelInfoPayload = extraApiDue && results[3].status === "fulfilled" ? results[3].value : null;
            const onlineFansPayload = extraApiDue && results[4].status === "fulfilled" ? results[4].value : null;
            const activitiesPayload = extraApiDue && results[5].status === "fulfilled" ? results[5].value : null;
            const giftsPayload = extraApiDue && results[6].status === "fulfilled" ? results[6].value : null;
            const audienceLoaded = Boolean(audiencePayload && Number(audiencePayload.errorCode) === 0);
            const chestLoaded = Boolean(chestPayload && Number(chestPayload.errorCode) === 0);
            const broadcastInfoLoaded = Boolean(broadcastInfoPayload && Number(broadcastInfoPayload.errorCode) === 0);
            const channelInfoLoaded = Boolean(channelInfoPayload && Number(channelInfoPayload.errorCode) === 0);
            const onlineFansLoaded = Boolean(onlineFansPayload && Number(onlineFansPayload.errorCode) === 0);
            const activitiesLoaded = Boolean(activitiesPayload && Number(activitiesPayload.errorCode) === 0);
            const giftsLoaded = Boolean(giftsPayload && Number(giftsPayload.errorCode) === 0);
            const audienceCount = audienceLoaded
                ? Number(audiencePayload.audienceCount)
                : null;
            const chest = chestLoaded && chestPayload.propsChest ? chestPayload.propsChest : null;
            if (participatedChestId && chest?.id && String(chest.id) !== participatedChestId) participatedChestId = "";

            const previousSnapshot = apiSnapshot || {};
            const extractedTopFans = extraApiDue
                ? extractTopFans(onlineFansLoaded ? onlineFansPayload : null,
                    broadcastInfoLoaded ? broadcastInfoPayload : null,
                    channelInfoLoaded ? channelInfoPayload : null)
                : [];
            const topFans = extraApiDue
                ? (extractedTopFans.length ? extractedTopFans : (previousSnapshot.topFans || []))
                : (previousSnapshot.topFans || []);
            const extractedActivities = extraApiDue && activitiesLoaded
                ? extractTextEntries(activitiesPayload).slice(0, 12)
                : [];
            const activityTexts = extraApiDue
                ? (extractedActivities.length ? extractedActivities : (previousSnapshot.activities || []))
                : (previousSnapshot.activities || []);
            for (const activity of activityTexts) rememberChestWinner(activity);
            const extractedFanCount = channelInfoLoaded
                ? findNumericValue(channelInfoPayload, /^(fanCount|fansCount|totalFans|followerCount|followersCount|numberOfFans|fans?)$/i)
                : null;
            const channelFanCount = extraApiDue
                ? (extractedFanCount !== null ? extractedFanCount : (previousSnapshot.channelFanCount ?? null))
                : (previousSnapshot.channelFanCount ?? null);
            const extractedGiftOptions = giftsLoaded ? extractGiftOptions(giftsPayload) : [];
            const giftOptions = extraApiDue
                ? (extractedGiftOptions.length ? extractedGiftOptions : (previousSnapshot.giftOptions || []))
                : (previousSnapshot.giftOptions || []);

            apiSnapshot = {
                context,
                audienceCount: Number.isFinite(audienceCount) ? audienceCount : null,
                audienceLoaded,
                broadcastInfo: broadcastInfoLoaded ? broadcastInfoPayload : null,
                broadcastInfoLoaded,
                topFans,
                channelFanCount,
                giftOptions,
                activities: activityTexts,
                activitiesLoaded: extraApiDue ? activitiesLoaded : Boolean(previousSnapshot.activitiesLoaded),
                giftsLoaded: extraApiDue ? giftsLoaded : Boolean(previousSnapshot.giftsLoaded),
                extraLoaded: extraApiDue
                    ? Boolean(channelInfoLoaded || onlineFansLoaded || activitiesLoaded || giftsLoaded)
                    : Boolean(previousSnapshot.extraLoaded),
                extraRefreshedAt: extraApiDue ? Date.now() : previousSnapshot.extraRefreshedAt,
                chest,
                chestLoaded,
                refreshedAt: Date.now()
            };
            const failures = results.slice(0, 2).filter(result => result.status === "rejected");
            apiRequestError = failures.length
                ? failures.map(result => String(result.reason?.message || "API request failed")).join("; ")
                : (!audienceLoaded || !chestLoaded ? "YouNow API returned an error" : "");
            updateChestReadiness();
        } catch (error) {
            apiRequestError = String(error?.message || "API refresh failed");
        } finally {
            apiRequestInFlight = false;
            updateInfo();
        }
    }

    async function sendChatMessage() {
        const input = panel?.querySelector('[data-field="chat-input"]');
        const message = String(input?.value || "").trim();
        const context = apiSnapshot?.context || getApiContext();
        if (!message) return setAction("Enter a chat message first");
        if (!context) return setAction("YouNow user and channel IDs are not available");
        const deviceId = getStoredYouNowValue("TRPX_DEVICE_ID");
        if (!deviceId) return setAction("YouNow device ID is not available — message not sent");
        if (chatSendPending) return;

        chatSendPending = true;
        syncButtons();
        const formData = new URLSearchParams();
        formData.set("userId", String(Number(context.userId)));
        formData.set("channelId", String(Number(context.channelId)));
        formData.set("comment", message.slice(0, 300));
        formData.set("tdi", deviceId);
        formData.set("lang", getApiLanguage());
        const headers = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
        const requestBy = getStoredYouNowValue("REQUEST_BY");
        if (requestBy) headers["X-Requested-By"] = requestBy;
        const requestPageUrl = String(pageWindow.location.href || "");

        try {
            const response = await pageWindow.fetch.call(pageWindow, CHAT_API_URL, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers,
                body: formData.toString()
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            let payload = null;
            try { payload = await response.clone().json(); } catch (_) {}
            if (payload && payload.errorCode !== undefined && Number(payload.errorCode) !== 0) {
                throw new Error(String(payload.errorMsg || payload.errorMessage || payload.message || `API error ${payload.errorCode}`));
            }
            if (String(pageWindow.location.href || "") !== requestPageUrl) {
                setAction("Chat request completed after the page changed");
                return;
            }
            if (input) input.value = "";
            setAction("Chat message sent");
            void refreshApiInfo(true);
        } catch (error) {
            setAction(`Chat API failed: ${String(error?.message || "request failed")}`);
        } finally {
            chatSendPending = false;
            syncButtons();
        }
    }

    function getBroadcastName() {
        const apiName = apiSnapshot?.broadcastInfoLoaded && typeof apiSnapshot.broadcastInfo?.username === "string"
            ? apiSnapshot.broadcastInfo.username.trim()
            : "";
        if (apiName) return apiName.slice(0, 80);
        const heading = Array.from(document.querySelectorAll("h1,[role='heading']"))
            .find(element => isVisible(element) && textOf(element));
        if (heading) return textOf(heading).slice(0, 80);
        return String(document.title || "YouNow broadcast")
            .replace(/\s*[|–-]\s*YouNow.*$/i, "").trim().slice(0, 80) || "YouNow broadcast";
    }

    function getBroadcastTitle(snapshot) {
        const title = snapshot?.broadcastInfo?.title;
        return typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : "—";
    }

    function formatFanSummary(snapshot) {
        const fans = Array.isArray(snapshot?.topFans) ? snapshot.topFans : [];
        if (!fans.length) return snapshot?.extraLoaded ? "No fan list returned" : "Loading API data";
        const ranked = fans.some(fan => fan.score !== null);
        const names = fans.slice(0, 3).map(fan => ranked && fan.score !== null
            ? `${fan.name} · ${formatCount(fan.score)}`
            : fan.name);
        const label = ranked ? "Ranked: " : fans.some(fan => fan.source === "top") ? "Top: " : "Online: ";
        return `${label}${names.join(", ")}`;
    }

    function formatActivitySummary(snapshot) {
        const activity = Array.isArray(snapshot?.activities) ? snapshot.activities[0] : "";
        if (activity) return activity.slice(0, 130);
        return snapshot?.activitiesLoaded ? "No recent activity returned" : snapshot?.extraLoaded ? "Activity API unavailable" : "Loading API data";
    }

    function formatGiftSummary(snapshot) {
        const options = Array.isArray(snapshot?.giftOptions) ? snapshot.giftOptions : [];
        if (!options.length) return snapshot?.giftsLoaded ? "No matching gifts returned" : snapshot?.extraLoaded ? "Gift catalog unavailable" : "Loading API data";
        return options.slice(0, 3).map(option =>
            `${option.name}${option.cost === null ? "" : ` · ${formatCount(option.cost)}`} ${option.currency.toLowerCase()}`
        ).join(" · ").slice(0, 120);
    }

    function setField(name, value) {
        const element = panel?.querySelector(`[data-field="${name}"]`);
        if (element) element.textContent = value || "—";
    }

    function updateInfo() {
        if (!panel) return;
        readVisibleChestWinners();
        const video = findVideo();
        const chest = getViewerChestInfo();
        const snapshot = apiSnapshot;
        const chestLikes = Number.isFinite(Number(chest.chest?.likes))
            ? formatCount(chest.chest.likes)
            : "—";
        const chestThreshold = Number.isFinite(Number(chest.chest?.minLikesToAvailable))
            ? formatCount(chest.chest.minLikesToAvailable)
            : "";
        const chestProgress = chestLikes !== "—" && chestThreshold ? `${chestLikes} / ${chestThreshold}` : chestLikes;
        setField("name", getBroadcastName());
        setField("title", snapshot?.broadcastInfoLoaded ? getBroadcastTitle(snapshot) : "API unavailable");
        setField("viewers", snapshot?.audienceLoaded && snapshot.audienceCount !== null
            ? formatCount(snapshot.audienceCount)
            : snapshot ? "API unavailable" : "Loading API data");
        setField("likes", snapshot?.chestLoaded ? chestProgress : "API unavailable");
        setField("topfans", formatFanSummary(snapshot));
        setField("fancount", snapshot?.channelFanCount !== null && snapshot?.channelFanCount !== undefined && Number.isFinite(Number(snapshot.channelFanCount))
            ? formatCount(snapshot.channelFanCount)
            : snapshot?.extraLoaded ? "Not provided" : "Loading API data");
        setField("winner", lastChestWinner || "No winner notice yet");
        setField("activity", formatActivitySummary(snapshot));
        setField("gifts", formatGiftSummary(snapshot));
        setField("status", isOwnBroadcast() ? "Your broadcast" : snapshot?.audienceLoaded
            ? (video && (video.paused || video.ended) ? "Live · video paused" : "Live · API")
            : "Waiting for API data");
        setField("chest", chest.label);
        setField("autochest", settings.autoChestEnabled ? "On" : "Off");
        setField("updated", snapshot?.refreshedAt
            ? new Date(snapshot.refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
            : "—");
        syncButtons();
        renderChatPreview();
    }
    function setAction(message) {
        setField("action", message);
        const output = panel?.querySelector("[data-field='action']");
        if (output) {
            clearTimeout(output._ynvtTimer);
            output._ynvtTimer = setTimeout(() => {
                if (output.textContent === message) output.textContent = "Ready";
            }, 2600);
        }
    }

    function applyTheatre(enabled) {
        settings.theatre = Boolean(enabled);
        document.body.classList.toggle("ynvt-theatre", settings.theatre);
        if (theatreTarget) theatreTarget.classList.remove("ynvt-player-target");
        theatreTarget = settings.theatre ? findPlayerContainer(findVideo()) : null;
        if (theatreTarget) theatreTarget.classList.add("ynvt-player-target");
        saveSettings();
        syncButtons();
    }

    function applyChatHidden(enabled) {
        settings.chatHidden = Boolean(enabled);
        if (chatTarget) chatTarget.classList.remove("ynvt-chat-hidden");
        chatTarget = settings.chatHidden ? findChatPanel() : null;
        if (chatTarget) chatTarget.classList.add("ynvt-chat-hidden");
        saveSettings();
        syncButtons();
        if (settings.chatHidden && !chatTarget) {
            settings.chatHidden = false;
            saveSettings();
            setAction("Chat panel not detected");
            syncButtons();
        }
    }

    function syncButtons() {
        if (!panel) return;
        const video = findVideo();
        const mute = panel.querySelector('[data-action="mute"]');
        const theatre = panel.querySelector('[data-action="theatre"]');
        const chat = panel.querySelector('[data-action="chat"]');
        const autoChest = panel.querySelector('[data-action="auto-chest"]');
        const openChest = panel.querySelector('[data-action="open-chest"]');
        const fan = panel.querySelector('[data-action="fan"]');
        const sendChat = panel.querySelector('[data-action="send-chat"]');
        const chest = getViewerChestInfo();
        if (mute) mute.textContent = video?.muted ? "Unmute" : "Mute";
        if (theatre) theatre.classList.toggle("active", settings.theatre);
        if (chat) {
            chat.textContent = settings.chatHidden ? "Show chat" : "Hide chat";
            chat.classList.toggle("active", settings.chatHidden);
        }
        if (autoChest) {
            autoChest.textContent = `Auto chest: ${settings.autoChestEnabled ? "ON" : "OFF"}`;
            autoChest.classList.toggle("active", settings.autoChestEnabled);
            autoChest.disabled = isOwnBroadcast();
        }
        if (fan) {
            const nativeFanButton = findPageFanButton();
            const alreadyFan = isAlreadyFan(nativeFanButton);
            fan.textContent = alreadyFan ? "Following ✓" : "Fan broadcaster";
            fan.disabled = !nativeFanButton || alreadyFan;
            fan.title = alreadyFan ? "You already follow this broadcaster" : "Use YouNow's Fan button";
        }
        if (openChest) {
            const context = apiSnapshot?.context || getApiContext();
            openChest.disabled = !context || !apiSnapshot?.chestLoaded || !chest.chest ||
                chest.participated || isOwnBroadcast() || chestActionPending;
            openChest.title = chest.viewerReady
                ? "Enter the chest currently open to viewers"
                : chest.chest
                    ? `Try the chest API action; YouNow reports ${String(chest.chest.state || "unknown")}`
                    : "Waiting for YouNow chest data";
        }
        if (sendChat) {
            sendChat.disabled = chatSendPending;
            sendChat.textContent = chatSendPending ? "Sending…" : "Send";
        }
    }

    function toggleMute() {
        const video = findVideo();
        if (!video) return setAction("No stream video found");
        video.muted = !video.muted;
        syncButtons();
        setAction(video.muted ? "Muted" : "Unmuted");
    }

    async function toggleFullscreen() {
        const video = findVideo();
        const target = findPlayerContainer(video) || video;
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else if (target?.requestFullscreen) await target.requestFullscreen();
            else setAction("Fullscreen is unavailable here");
        } catch (_) {
            setAction("Could not enter fullscreen");
        }
    }

    async function copyLink() {
        try {
            await navigator.clipboard.writeText(location.href);
            setAction("Broadcast link copied");
        } catch (_) {
            const input = document.createElement("textarea");
            input.value = location.href;
            input.style.cssText = "position:fixed;left:-9999px;top:0";
            document.body.appendChild(input);
            input.select();
            const copied = document.execCommand("copy");
            input.remove();
            setAction(copied ? "Broadcast link copied" : "Clipboard access was denied");
        }
    }

    function setChatZoom(delta) {
        const chat = findChatPanel();
        if (!chat) return setAction("Chat panel not detected");
        settings.chatZoom = Math.max(0.8, Math.min(1.5, Number(settings.chatZoom || 1) + delta));
        chat.style.setProperty("--ynvt-chat-zoom", String(settings.chatZoom));
        chat.classList.add("ynvt-chat-zoom");
        saveSettings();
        setAction(`Chat text ${Math.round(settings.chatZoom * 100)}%`);
    }

    function installStyles() {
        addStyle(`
            #${ROOT_ID} { position:fixed; right:16px; bottom:16px; width:340px; height:620px; min-width:290px; min-height:360px; max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); resize:both; z-index:2147483646; color:#eef4ff; background:#111827; border:1px solid #334155; border-radius:12px; box-shadow:0 12px 34px rgba(0,0,0,.45); font:13px/1.4 Arial,Helvetica,sans-serif; overflow:hidden; }
            #${ROOT_ID} * { box-sizing:border-box; }
            #${ROOT_ID} .ynvt-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 11px; background:#1e293b; cursor:move; user-select:none; }
            #${ROOT_ID} .ynvt-title { font-weight:700; letter-spacing:.2px; }
            #${ROOT_ID} .ynvt-version { color:#94a3b8; font-size:10px; margin-left:4px; font-weight:400; }
            #${ROOT_ID} .ynvt-min { border:0; background:transparent; color:#cbd5e1; font-size:20px; cursor:pointer; line-height:1; }
            #${ROOT_ID} .ynvt-body { height:calc(100% - 42px); padding:9px; overflow:auto; overscroll-behavior:contain; }
            #${ROOT_ID}.ynvt-minimized .ynvt-body { display:none; }
            #${ROOT_ID}.ynvt-minimized { height:auto !important; min-height:0; resize:none; }
            #${ROOT_ID} .ynvt-info { display:grid; grid-template-columns:82px minmax(0,1fr); gap:4px 7px; padding:8px; margin-bottom:8px; background:#0b1220; border-radius:8px; }
            #${ROOT_ID} .ynvt-label { color:#94a3b8; }
            #${ROOT_ID} .ynvt-value { min-width:0; overflow-wrap:anywhere; text-align:right; font-weight:600; }
            #${ROOT_ID} .ynvt-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
            #${ROOT_ID} button.ynvt-button { min-width:0; min-height:34px; padding:5px 7px; border:1px solid #3b4b62; border-radius:7px; color:#e2e8f0; background:#1e293b; cursor:pointer; font:600 12px Arial, sans-serif; }
            #${ROOT_ID} button.ynvt-button:hover { background:#29384e; border-color:#64748b; }
            #${ROOT_ID} button.ynvt-button:disabled { opacity:.48; cursor:not-allowed; }
            #${ROOT_ID} button.ynvt-button.active { background:#164e63; border-color:#22d3ee; color:#cffafe; }
            #${ROOT_ID} .ynvt-subrow { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin-top:6px; }
            #${ROOT_ID} .ynvt-subrow .ynvt-button { min-width:0; }
            #${ROOT_ID} .ynvt-fan-row .ynvt-button, #${ROOT_ID} .ynvt-actions [data-action="copy"] { grid-column:1/-1; }
            #${ROOT_ID} .ynvt-chest-actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:7px; }
            #${ROOT_ID} .ynvt-gift-actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:6px; }
            #${ROOT_ID} .ynvt-chat-preview { margin-top:8px; padding:7px; background:#0b1220; border-radius:8px; }
            #${ROOT_ID} .ynvt-chat-heading { display:flex; justify-content:space-between; color:#cbd5e1; font-size:11px; font-weight:700; margin-bottom:5px; }
            #${ROOT_ID} .ynvt-chat-list { max-height:128px; overflow:auto; display:flex; flex-direction:column; gap:4px; overscroll-behavior:contain; }
            #${ROOT_ID} .ynvt-chat-line { padding:4px 5px; color:#e2e8f0; background:#111827; border-left:2px solid #475569; border-radius:3px; font-size:10px; line-height:1.35; overflow-wrap:anywhere; }
            #${ROOT_ID} .ynvt-chat-empty { padding:6px 3px; color:#94a3b8; font-size:10px; }
            #${ROOT_ID} .ynvt-chat-compose { display:grid; grid-template-columns:minmax(0,1fr) 62px; gap:6px; margin-top:6px; }
            #${ROOT_ID} .ynvt-chat-compose textarea { width:100%; min-height:42px; max-height:100px; padding:7px; resize:vertical; border:1px solid #3b4b62; border-radius:7px; color:#eef4ff; background:#111827; font:12px/1.35 Arial, sans-serif; }
            #${ROOT_ID} .ynvt-chat-compose textarea:focus { outline:1px solid #22d3ee; }
            #${ROOT_ID} .ynvt-chat-compose button { min-height:42px; }
            #${ROOT_ID} .ynvt-shortcuts { margin-top:9px; color:#94a3b8; font-size:10px; text-align:center; }
            #${ROOT_ID} [data-field="action"] { min-height:18px; margin-top:7px; color:#67e8f9; text-align:center; font-size:11px; }
            #${ROOT_ID} .ynvt-foot { margin-top:5px; color:#64748b; font-size:9px; text-align:center; }
            .ynvt-player-target { position:fixed !important; left:50% !important; top:50% !important; transform:translate(-50%,-50%) !important; width:min(94vw,1600px) !important; max-height:88vh !important; z-index:2147483001 !important; margin:0 !important; background:#000 !important; }
            .ynvt-player-target video { display:block !important; width:100% !important; height:auto !important; max-height:88vh !important; object-fit:contain !important; }
            .ynvt-chat-hidden { display:none !important; }
            .ynvt-chat-zoom, .ynvt-chat-zoom * { font-size:calc(1rem * var(--ynvt-chat-zoom,1)) !important; }
            #${ROOT_ID} { z-index:2147483646; }
        `);
    }

    function createPanel() {
        if (document.getElementById(ROOT_ID)) return;
        panel = document.createElement("section");
        panel.id = ROOT_ID;
        const panelWidth = Number(settings.width);
        const panelHeight = Number(settings.height);
        panel.style.width = `${Math.max(290, Math.min(800, Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 340))}px`;
        panel.style.height = `${Math.max(360, Math.min(900, Number.isFinite(panelHeight) && panelHeight > 0 ? panelHeight : 620))}px`;
        panel.innerHTML = `
            <div class="ynvt-head">
                <div><span class="ynvt-title">YouNow Viewer</span><span class="ynvt-version">v${VERSION}</span></div>
                <button type="button" class="ynvt-min" data-action="minimize" title="Minimize">−</button>
            </div>
            <div class="ynvt-body">
                <div class="ynvt-info">
                    <span class="ynvt-label">Broadcast</span><span class="ynvt-value" data-field="name">—</span>
                    <span class="ynvt-label">Title</span><span class="ynvt-value" data-field="title">—</span>
                    <span class="ynvt-label">Status</span><span class="ynvt-value" data-field="status">—</span>
                    <span class="ynvt-label">Viewers</span><span class="ynvt-value" data-field="viewers">—</span>
                    <span class="ynvt-label">Top fans</span><span class="ynvt-value" data-field="topfans">—</span>
                    <span class="ynvt-label">Fan count</span><span class="ynvt-value" data-field="fancount">—</span>
                    <span class="ynvt-label">Chest likes</span><span class="ynvt-value" data-field="likes">—</span>
                    <span class="ynvt-label">Chest</span><span class="ynvt-value" data-field="chest">—</span>
                    <span class="ynvt-label">Chest winner</span><span class="ynvt-value" data-field="winner" title="Latest chest winner notice found in YouNow activity or live chat">No winner notice yet</span>
                    <span class="ynvt-label">Activity</span><span class="ynvt-value" data-field="activity">—</span>
                    <span class="ynvt-label">Gift catalog</span><span class="ynvt-value" data-field="gifts">—</span>
                    <span class="ynvt-label">Auto chest</span><span class="ynvt-value" data-field="autochest">Off</span>
                    <span class="ynvt-label">Updated</span><span class="ynvt-value" data-field="updated">—</span>
                </div>
                <div class="ynvt-actions">
                    <button type="button" class="ynvt-button" data-action="theatre">Theater mode</button>
                    <button type="button" class="ynvt-button" data-action="chat">Hide chat</button>
                    <button type="button" class="ynvt-button" data-action="mute">Mute</button>
                    <button type="button" class="ynvt-button" data-action="fullscreen">Fullscreen</button>
                    <button type="button" class="ynvt-button" data-action="copy">Copy link</button>
                </div>
                <div class="ynvt-chest-actions">
                    <button type="button" class="ynvt-button" data-action="open-chest">Tap chest</button>
                    <button type="button" class="ynvt-button" data-action="auto-chest">Auto chest: OFF</button>
                </div>
                <div class="ynvt-subrow ynvt-fan-row">
                    <button type="button" class="ynvt-button" data-action="fan">Fan broadcaster</button>
                </div>
                <div class="ynvt-gift-actions">
                    <button type="button" class="ynvt-button" data-action="pearl-gift">Pearl Tip</button>
                    <button type="button" class="ynvt-button" data-action="bar-gift">Tip (Bars)</button>
                </div>
                <div class="ynvt-subrow">
                    <button type="button" class="ynvt-button" data-action="zoom-out" title="Reduce chat text">Chat A−</button>
                    <button type="button" class="ynvt-button" data-action="zoom-in" title="Enlarge chat text">Chat A+</button>
                    <button type="button" class="ynvt-button" data-action="refresh">Refresh</button>
                </div>
                <div class="ynvt-chat-preview">
                    <div class="ynvt-chat-heading"><span>Live chat</span><span data-field="chat-count">0</span></div>
                    <div class="ynvt-chat-list" data-field="chat-messages" aria-live="polite">
                        <div class="ynvt-chat-empty">Waiting for chat messages…</div>
                    </div>
                </div>
                <div class="ynvt-chat-compose">
                    <textarea data-field="chat-input" maxlength="300" rows="2" placeholder="Write a chat message…" aria-label="Write a chat message"></textarea>
                    <button type="button" class="ynvt-button" data-action="send-chat">Send</button>
                </div>
                <div class="ynvt-shortcuts">T theater · C chat · M mute · F fullscreen</div>
                <div data-field="action">Ready</div>
                <div class="ynvt-foot">Broadcast and chest APIs refresh every 3 seconds; fan, activity, and gift catalog APIs refresh every 15 seconds. Winner notices come from activity, chat, or the results popup.</div>
            </div>`;
        document.body.appendChild(panel);
        if (settings.left !== null && Number.isFinite(Number(settings.left))) {
            panel.style.left = `${settings.left}px`;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
            panel.style.top = `${Math.max(5, Number(settings.top) || 90)}px`;
        } else {
            panel.style.top = "auto";
        }
        panel.classList.toggle("ynvt-minimized", Boolean(settings.minimized));
        panel.querySelector('[data-action="minimize"]').textContent = settings.minimized ? "+" : "−";
        attachPanelEvents();
        if (typeof ResizeObserver === "function") {
            const resizeObserver = new ResizeObserver(() => {
                if (settings.minimized) return;
                clearTimeout(resizeSaveTimer);
                resizeSaveTimer = setTimeout(() => {
                    if (!panel?.isConnected || settings.minimized) return;
                    if (settings.left !== null) {
                        const left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, Number(settings.left) || 0));
                        const top = Math.max(0, Math.min(innerHeight - panel.offsetHeight, Number(settings.top) || 0));
                        panel.style.left = `${left}px`;
                        panel.style.top = `${top}px`;
                        settings.left = left;
                        settings.top = top;
                    }
                    settings.width = Math.round(panel.getBoundingClientRect().width);
                    settings.height = Math.round(panel.getBoundingClientRect().height);
                    saveSettings();
                }, 350);
            });
            resizeObserver.observe(panel);
            window.addEventListener("pagehide", () => resizeObserver.disconnect(), { once: true });
        }
        updateInfo();
        void refreshApiInfo(true);
    }

    function attachPanelEvents() {
        panel.addEventListener("click", event => {
            const button = event.target.closest("[data-action]");
            if (!button) return;
            switch (button.dataset.action) {
                case "minimize":
                    settings.minimized = !settings.minimized;
                    panel.classList.toggle("ynvt-minimized", settings.minimized);
                    button.textContent = settings.minimized ? "+" : "−";
                    saveSettings();
                    break;
                case "theatre": applyTheatre(!settings.theatre); break;
                case "chat": applyChatHidden(!settings.chatHidden); break;
                case "mute": toggleMute(); break;
                case "fullscreen": toggleFullscreen(); break;
                case "copy": copyLink(); break;
                case "open-chest": openViewerChest(false); break;
                case "fan": fanBroadcaster(); syncButtons(); break;
                case "pearl-gift": openGiftPicker("pearls"); break;
                case "bar-gift": openGiftPicker("bars"); break;
                case "send-chat": void sendChatMessage(); break;
                case "auto-chest":
                    if (isOwnBroadcast()) {
                        setAction("Viewer chest auto mode is disabled on your broadcast");
                        break;
                    }
                    settings.autoChestEnabled = !settings.autoChestEnabled;
                    saveSettings();
                    syncButtons();
                    setAction(settings.autoChestEnabled ? "Auto chest enabled" : "Auto chest disabled");
                    pollViewerChest();
                    break;
                case "zoom-out": setChatZoom(-0.1); break;
                case "zoom-in": setChatZoom(0.1); break;
                case "refresh": pollViewerChest(); updateInfo(); setAction("Panel information refreshed"); break;
            }
        });

        panel.querySelector('[data-field="chat-input"]')?.addEventListener("keydown", event => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void sendChatMessage();
            }
        });

        const handle = panel.querySelector(".ynvt-head");
        handle.addEventListener("pointerdown", event => {
            if (event.target.closest("button")) return;
            const rect = panel.getBoundingClientRect();
            const startX = event.clientX;
            const startY = event.clientY;
            const offsetX = startX - rect.left;
            const offsetY = startY - rect.top;
            handle.setPointerCapture(event.pointerId);
            const move = moveEvent => {
                const left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, moveEvent.clientX - offsetX));
                const top = Math.max(0, Math.min(innerHeight - panel.offsetHeight, moveEvent.clientY - offsetY));
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
                panel.style.right = "auto";
                panel.style.bottom = "auto";
                settings.left = left;
                settings.top = top;
            };
            const end = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
                handle.removeEventListener("pointercancel", end);
                saveSettings();
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
        });
    }

    function onKeyDown(event) {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "") || event.target?.isContentEditable) return;
        const key = event.key.toLowerCase();
        if (key === "t") { event.preventDefault(); applyTheatre(!settings.theatre); }
        else if (key === "c") { event.preventDefault(); applyChatHidden(!settings.chatHidden); }
        else if (key === "m") { event.preventDefault(); toggleMute(); }
        else if (key === "f") { event.preventDefault(); toggleFullscreen(); }
    }

    function maintainTargets() {
        if (settings.theatre) {
            const nextTarget = findPlayerContainer(findVideo());
            if (nextTarget && nextTarget !== theatreTarget) {
                theatreTarget?.classList.remove("ynvt-player-target");
                theatreTarget = nextTarget;
                theatreTarget.classList.add("ynvt-player-target");
            }
        }
        if (settings.chatHidden) {
            const nextTarget = findChatPanel();
            if (nextTarget && nextTarget !== chatTarget) {
                chatTarget?.classList.remove("ynvt-chat-hidden");
                chatTarget = nextTarget;
                chatTarget.classList.add("ynvt-chat-hidden");
            }
        }
        if (Number(settings.chatZoom) !== 1) {
            const zoomTarget = findChatPanel();
            if (zoomTarget) {
                zoomTarget.style.setProperty("--ynvt-chat-zoom", String(settings.chatZoom));
                zoomTarget.classList.add("ynvt-chat-zoom");
            }
        }
    }

    function start() {
        if (!document.body || document.getElementById(ROOT_ID)) return;
        installStyles();
        createPanel();
        document.addEventListener("keydown", onKeyDown, true);
        const observer = new MutationObserver(() => maintainTargets());
        observer.observe(document.body, { childList: true, subtree: true });
        maintainTargets();
        infoTimer = setInterval(updateInfo, 1000);
        apiTimer = setInterval(() => void refreshApiInfo(), API_REFRESH_INTERVAL_MS);
        window.addEventListener("pagehide", () => {
            clearInterval(infoTimer);
            clearInterval(apiTimer);
            if (theatreTarget) theatreTarget.classList.remove("ynvt-player-target");
            if (chatTarget) chatTarget.classList.remove("ynvt-chat-hidden");
            document.body.classList.remove("ynvt-theatre");
        }, { once: true });
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();
