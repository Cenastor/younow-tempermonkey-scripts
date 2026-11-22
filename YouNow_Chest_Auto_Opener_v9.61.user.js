// ==UserScript==
// @name         YouNow Treasure Chest Auto Opener
// @namespace    https://younow.com/
// @version      9.77
// @description  YouNow Treasure Chest automation with API-driven chat and chest actions, one opening announcement per chest, configured like targets, optional audio, Winners cleanup, persistent chest history, and an optional clearable action log.
// @author       Cenastor
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

    const VERSION = "9.77";

    /*
     * Keep the existing storage key for compatibility.
     */
    const STORAGE_KEY =
        "younowTreasureChestAutoOpener_v920";

    /*
     * Opened chest history is stored separately from settings so
     * RESET LOG never changes automation settings.
     */
    const LOG_STORAGE_KEY =
        STORAGE_KEY + "_openedChestLog";

    const MAX_LOG_ENTRIES = 100;
    const ACTION_LOG_STORAGE_KEY =
        STORAGE_KEY + "_actionLog";
    const MAX_ACTION_LOG_ENTRIES = 250;

    /*
     * Keep sampling the read-only chest API briefly during each check so
     * likes arriving during the check are included.
     */
    const LIVE_LIKES_CHECK_WINDOW_MS = 5000;

    /*
     * The chest API is refreshed while the user's own broadcast is live.
     * A fresh API snapshot drives chest state, likes, and the direct open.
     */
    const CHEST_API_URL =
        "https://api.younow.com/php/api/props/getCurrentChest";

    const CHEST_API_OPEN_URL =
        "https://api.younow.com/php/api/props/propsChestOpen";

    const CHAT_API_URL =
        "https://api.younow.com/php/api/broadcast/chat";

    const OPENING_ANNOUNCEMENT_REGISTRY_KEY =
        "__younowChestHelperOpeningAnnouncementKeys_v1";

    const CHEST_API_REFRESH_INTERVAL_MS = 3000;

    const CHEST_API_SNAPSHOT_MAX_AGE_MS = 10000;

    const pageWindow =
        typeof unsafeWindow !== "undefined"
            ? unsafeWindow
            : window;

    const DEFAULTS = {
        enabled: true,

        threshold: 1000,

        recheckSeconds: 30,

        openingDelaySeconds: 30,

        timerEnabled: true,

        openingChatEnabled: true,

        openingChatMessage:
            "Treasure Chest has reached {likes} likes! Opening in {delay} seconds! ❤️",

        openSoundEnabled: true,

        openSoundVolume: 0.80,

        autoInfoEnabled: true,

        autoInfoMinutes: 5,

        autoInfoMessage:
            "Auto Chest: The chest opens automatically at {threshold} likes. Current target: {threshold} likes! ❤️",

        actionLogEnabled: false,

        minimized: false,

        maximized: false,

        panelX: null,

        panelY: null
    };

    let settings = loadSettings();

    /*
     * ============================================================
     * CUSTOM CHEST-OPEN SOUND
     * ============================================================
     * Selected audio is stored in IndexedDB so it survives reloads.
     * Audio initialization never controls whether the helper panel
     * itself is created or shown.
     */
    const SOUND_DB_NAME = "YouNowChestHelperSoundDB";
    const SOUND_DB_VERSION = 1;
    const SOUND_STORE_NAME = "sound";
    const SOUND_RECORD_KEY = "openSound";

    let customOpenSoundName = "";
    let customOpenSoundObjectUrl = null;
    let soundAudio = null;
    let soundReady = false;
    let soundPlayedForCycle = false;

    function openSoundDatabase() {
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(SOUND_DB_NAME, SOUND_DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(SOUND_STORE_NAME)) {
                        db.createObjectStore(SOUND_STORE_NAME);
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    async function saveCustomOpenSound(file) {
        if (!file) return false;
        try {
            const db = await openSoundDatabase();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(SOUND_STORE_NAME, "readwrite");
                tx.objectStore(SOUND_STORE_NAME).put({
                    blob: file,
                    name: file.name || "Custom sound",
                    type: file.type || "audio/mpeg",
                    updated: Date.now()
                }, SOUND_RECORD_KEY);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            db.close();
            await loadCustomOpenSound();
            setAction(`Custom sound loaded: ${customOpenSoundName}`);
            return true;
        } catch (error) {
            console.error("[Chest Helper] Sound save failed:", error);
            setAction("Could not save custom sound");
            return false;
        }
    }

    async function loadCustomOpenSound() {
        try {
            const db = await openSoundDatabase();
            const record = await new Promise((resolve, reject) => {
                const tx = db.transaction(SOUND_STORE_NAME, "readonly");
                const request = tx.objectStore(SOUND_STORE_NAME).get(SOUND_RECORD_KEY);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error);
            });
            db.close();
            if (!record || !record.blob) {
                customOpenSoundName = "";
                soundReady = false;
                return false;
            }
            if (customOpenSoundObjectUrl) {
                try { URL.revokeObjectURL(customOpenSoundObjectUrl); } catch (_) {}
            }
            customOpenSoundName = record.name || "Custom sound";
            customOpenSoundObjectUrl = URL.createObjectURL(record.blob);
            soundAudio = new Audio(customOpenSoundObjectUrl);
            soundAudio.preload = "auto";
            soundAudio.volume = clamp(Number(settings.openSoundVolume), 0, 1);
            soundReady = true;
            return true;
        } catch (error) {
            console.warn("[Chest Helper] Could not load saved sound:", error);
            soundReady = false;
            return false;
        }
    }

    async function clearCustomOpenSound() {
        try {
            const db = await openSoundDatabase();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(SOUND_STORE_NAME, "readwrite");
                tx.objectStore(SOUND_STORE_NAME).delete(SOUND_RECORD_KEY);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            db.close();
        } catch (error) {
            console.warn("[Chest Helper] Could not clear sound:", error);
        }
        if (customOpenSoundObjectUrl) {
            try { URL.revokeObjectURL(customOpenSoundObjectUrl); } catch (_) {}
        }
        customOpenSoundName = "";
        customOpenSoundObjectUrl = null;
        soundAudio = null;
        soundReady = false;
        setAction("Custom chest-open sound removed");
        updateUI();
    }

    async function playCustomOpenSound(force = false) {
        if (!updateBroadcastSafety()) return false;
        if (!force && !settings.openSoundEnabled) return false;
        if (!soundReady) await loadCustomOpenSound();
        if (!soundReady || !customOpenSoundObjectUrl) {
            setAction("No custom chest-open sound selected");
            return false;
        }
        try {
            if (!soundAudio) soundAudio = new Audio(customOpenSoundObjectUrl);
            soundAudio.volume = clamp(Number(settings.openSoundVolume), 0, 1);
            soundAudio.currentTime = 0;
            const promise = soundAudio.play();
            if (promise && typeof promise.then === "function") await promise;
            setAction(`Playing chest-open sound: ${customOpenSoundName}`);
            return true;
        } catch (error) {
            console.warn("[Chest Helper] Sound playback failed:", error);
            setAction("Sound playback was blocked — use TEST SOUND once");
            return false;
        }
    }

    async function handleOpenSoundFile(event) {
        const file = event?.target?.files?.[0];
        if (!file) return;
        if (!file.type || !file.type.startsWith("audio/")) {
            setAction("Please select an audio file");
            event.target.value = "";
            return;
        }
        await saveCustomOpenSound(file);
        event.target.value = "";
        await playCustomOpenSound(true);
    }

    async function testOpenSound() {
        await playCustomOpenSound(true);
    }

    /*
     * ============================================================
     * STATES
     * ============================================================
     */

    const STATES = {
        OFF:
            "OFF",

        WAITING_FOR_CHEST:
            "WAITING_FOR_CHEST",

        OPENING_PANEL:
            "OPENING_PANEL",

        READING_LIKES:
            "READING_LIKES",

        CLOSING_BELOW_TARGET:
            "CLOSING_BELOW_TARGET",

        WAITING_FOR_RECHECK:
            "WAITING_FOR_RECHECK",

        WAITING_FOR_OPEN_DELAY:
            "WAITING_FOR_OPEN_DELAY",

        OPENING_VIA_API:
            "OPENING_VIA_API",

        WAITING_FOR_RAIN:
            "WAITING_FOR_RAIN",

        WAITING_FOR_TELL_THEM:
            "WAITING_FOR_TELL_THEM",

        WAITING_FOR_CHEST_RESET:
            "WAITING_FOR_CHEST_RESET",

        WAITING_FOR_WINNERS:
            "WAITING_FOR_WINNERS",

        CLOSING_WINNERS:
            "CLOSING_WINNERS",

        CLEANUP:
            "CLEANUP"
    };

    let state =
        settings.enabled
            ? STATES.WAITING_FOR_CHEST
            : STATES.OFF;

    /*
     * ============================================================
     * CYCLE DATA
     * ============================================================
     */

    /*
     * Completed chest-opening cycle number.
     * A likes check is NOT a cycle. The number advances only after
     * the complete chest opening and cleanup sequence succeeds.
     */
    let cycle = loadCompletedCycleCount();

    function loadCompletedCycleCount() {
        try {
            const stored = parseInt(
                GM_getValue(
                    STORAGE_KEY + "_completedCycleCount",
                    0
                ),
                10
            );

            return Number.isFinite(stored) && stored >= 0
                ? stored
                : 0;
        } catch (_) {
            return 0;
        }
    }

    function saveCompletedCycleCount() {
        try {
            GM_setValue(
                STORAGE_KEY + "_completedCycleCount",
                cycle
            );
        } catch (_) {}
    }

    function completeChestCycle() {
        cycle += 1;
        saveCompletedCycleCount();
    }

    /*
     * Current live value from the most recent successful
     * chest-panel read.
     */
    let lastCheckedLikes = null;

    /*
     * Current value displayed during the cycle.
     */
    let currentLikes = null;

    /*
     * Value locked when the threshold is reached.
     */
    let lockedLikes = null;

    let likesLockedForCycle =
        false;

    let cycleLocked =
        false;

    /*
     * A check cycle is one complete timer-driven operation:
     * timer expires -> open panel -> READ the real likes -> close panel.
     * It prevents the panel from being opened/closed repeatedly while
     * waiting for the next scheduled check.
     */
    let checkCycleInProgress =
        false;

    let likesReadThisCheck =
        false;

    /* End time for the short live likes-check window. */
    let likesCheckDeadline = null;

    let localOpeningAnnouncementKeys = [];

    /*
     * Opened-chest history.  Entries are added only after the
     * complete opening/Winners cleanup sequence succeeds.
     */
    let chestLog =
        loadChestLog();

    let actionLog =
        loadActionLog();

    let openedChestRecordedForCycle =
        false;

    /*
     * ============================================================
     * TIMERS
     * ============================================================
     */

    let chestTimerEnd = null;

    let openingTimerEnd = null;

    let autoInfoNextAt = null;

    /*
     * ============================================================
     * STATUS
     * ============================================================
     */

    let lastAction =
        "Starting...";

    let stateStartedAt =
        Date.now();

    let recoveryStartedAt =
        Date.now();

    /*
     * ============================================================
     * WINNERS
     * ============================================================
     */

    let winnerCloseAttempts = 0;

    /*
     * ============================================================
     * UI
     * ============================================================
     */

    let helperPanel = null;

    let dragState = {
        active: false,
        offsetX: 0,
        offsetY: 0
    };

    /*
     * ============================================================
     * ASYNC PROCESS LOCK
     *
     * processState() contains awaited DOM operations. The 500 ms
     * polling loop must never run a second processState() while the
     * previous one is still waiting on a panel open/close/read.
     * Without this lock, overlapping calls can click the chest
     * button repeatedly and create an open/close loop.
     * ============================================================
     */
    let processStateBusy = false;

    /* BROADCAST SAFETY: visible YouNow END button = live. */
    let ownBroadcastActive = false;
    let broadcastDetectionInitialized = false;

    let chestApiSnapshot = null;
    let chestApiSnapshotAt = 0;
    let chestApiLastFetchAt = 0;
    let chestApiRequestInFlight = false;
    let chestApiContextKey = "";
    let chestApiSnapshotPageUrl = String(pageWindow.location.href || "");
    let chestApiOpenAttemptedId = "";
    let chestOpenConfirmedForCycle = false;
    let chatSendQueue = Promise.resolve();
    let testChatSendInProgress = false;

    /* TIMER-OFF CONTROL: no timer; check once on AVAILABLE and once before opening. */
    let lastObservedChestState = "UNKNOWN";
    let offModeCheckedForAvailableChest = false;
    let preOpenVerification = false;

    /*
     * ============================================================
     * SETTINGS
     * ============================================================
     */

    function loadSettings() {
        let stored = {};

        try {
            stored =
                GM_getValue(
                    STORAGE_KEY,
                    {}
                ) || {};
        } catch (error) {
            console.warn(
                "[Chest Helper] Could not load settings:",
                error
            );
        }

        const result = {
            ...DEFAULTS,
            ...stored
        };

        result.threshold =
            clampThreshold(
                result.threshold
            );

        result.recheckSeconds =
            Math.max(
                1,
                parseInt(
                    result.recheckSeconds,
                    10
                ) || 30
            );

        result.openingDelaySeconds =
            Math.max(
                0,
                parseInt(
                    result.openingDelaySeconds,
                    10
                ) || 0
            );

        result.autoInfoMinutes =
            Math.max(
                1,
                parseInt(
                    result.autoInfoMinutes,
                    10
                ) || 5
            );

        result.openSoundEnabled =
            result.openSoundEnabled !== false;

        result.actionLogEnabled =
            result.actionLogEnabled === true;

        result.openSoundVolume =
            clamp(
                Number(result.openSoundVolume),
                0,
                1
            );

        return result;
    }

    function saveSettings() {
        try {
            GM_setValue(
                STORAGE_KEY,
                settings
            );
        } catch (error) {
            console.warn(
                "[Chest Helper] Could not save settings:",
                error
            );
        }
    }

    function clampThreshold(value) {
        const number =
            parseInt(
                value,
                10
            );

        if (
            !Number.isFinite(number) ||
            number < 500
        ) {
            return 500;
        }

        return number;
    }

    /*
     * ============================================================
     * OPENED CHEST HISTORY / LOG
     * ============================================================
     */

    function loadChestLog() {
        try {
            const stored =
                GM_getValue(
                    LOG_STORAGE_KEY,
                    []
                );

            if (!Array.isArray(stored)) {
                return [];
            }

            return stored
                .filter(entry => entry && typeof entry === "object")
                .slice(0, MAX_LOG_ENTRIES);
        } catch (error) {
            console.warn(
                "[Chest Helper] Could not load chest history:",
                error
            );

            return [];
        }
    }

    function saveChestLog() {
        try {
            GM_setValue(
                LOG_STORAGE_KEY,
                chestLog.slice(0, MAX_LOG_ENTRIES)
            );
        } catch (error) {
            console.warn(
                "[Chest Helper] Could not save chest history:",
                error
            );
        }
    }

    function loadActionLog() {
        try {
            const stored =
                GM_getValue(
                    ACTION_LOG_STORAGE_KEY,
                    []
                );

            if (!Array.isArray(stored)) {
                return [];
            }

            return stored
                .filter(
                    entry =>
                        entry &&
                        typeof entry === "object" &&
                        String(entry.message || "")
                )
                .map(
                    entry => ({
                        timestamp:
                            Number(entry.timestamp) || Date.now(),
                        type:
                            String(entry.type || "ACTION"),
                        message:
                            String(entry.message || "").slice(0, 500)
                    })
                )
                .slice(0, MAX_ACTION_LOG_ENTRIES);
        } catch (error) {
            console.warn(
                "[Chest Helper] Could not load action log:",
                error
            );

            return [];
        }
    }

    function saveActionLog() {
        try {
            GM_setValue(
                ACTION_LOG_STORAGE_KEY,
                actionLog.slice(0, MAX_ACTION_LOG_ENTRIES)
            );
        } catch (error) {
            console.warn(
                "[Chest Helper] Could not save action log:",
                error
            );
        }
    }

    function addActionLog(
        message,
        type = "ACTION"
    ) {
        if (!settings.actionLogEnabled) {
            return;
        }

        const text =
            String(message || "").trim();

        if (!text) {
            return;
        }

        actionLog.unshift({
            timestamp: Date.now(),
            type: String(type || "ACTION"),
            message: text.slice(0, 500)
        });

        actionLog =
            actionLog.slice(0, MAX_ACTION_LOG_ENTRIES);

        saveActionLog();
        renderActionLog();
    }

    function clearActionLog() {
        actionLog = [];
        saveActionLog();
        renderActionLog();

        /* Keep the clear confirmation in the status line without re-adding it to the log. */
        lastAction = "Action log cleared";

        if (settings.actionLogEnabled) {
            console.log(
                `[Chest Helper ${VERSION}] ${lastAction}`
            );
        }

        updateUI();
    }

    function addOpenedChestLog() {
        if (openedChestRecordedForCycle) {
            return;
        }

        const likes =
            lockedLikes !== null
                ? lockedLikes
                : lastCheckedLikes;

        chestLog.unshift({
            timestamp: Date.now(),
            cycle: cycle,
            likes: likes,
            threshold: Number(settings.threshold),
            openingDelay: Number(settings.openingDelaySeconds),
            result: "Opened"
        });

        chestLog =
            chestLog.slice(0, MAX_LOG_ENTRIES);

        saveChestLog();

        openedChestRecordedForCycle =
            true;

        setAction(
            `Cycle ${cycle} recorded in Chest History`
        );
    }

    function resetChestLog() {
        chestLog = [];
        saveChestLog();
        renderChestLog();

        setAction(
            "Chest History reset"
        );
    }

    function formatLogDate(timestamp) {
        const date =
            new Date(timestamp);

        if (Number.isNaN(date.getTime())) {
            return "Unknown date";
        }

        return date.toLocaleString(
            undefined,
            {
                dateStyle: "short",
                timeStyle: "medium"
            }
        );
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function renderChestLog() {
        if (!helperPanel) {
            return;
        }

        const container =
            helperPanel.querySelector(
                '[data-field="chest-log"]'
            );

        const count =
            helperPanel.querySelector(
                '[data-field="chest-log-count"]'
            );

        if (!container) {
            return;
        }

        if (count) {
            count.textContent =
                String(chestLog.length);
        }

        if (!chestLog.length) {
            container.innerHTML =
                '<div class="ych-log-empty">No opened chests recorded yet.</div>';
            return;
        }

        container.innerHTML =
            chestLog
                .map((entry, index) => {
                    const likes =
                        Number.isFinite(Number(entry.likes))
                            ? formatLikes(Number(entry.likes))
                            : "—";

                    const threshold =
                        Number.isFinite(Number(entry.threshold))
                            ? formatLikes(Number(entry.threshold))
                            : "—";

                    const delay =
                        Number.isFinite(Number(entry.openingDelay))
                            ? `${Number(entry.openingDelay)}s`
                            : "—";

                    return `
                        <div class="ych-log-entry">
                            <div class="ych-log-top">
                                <strong>Chest #${escapeHtml(entry.cycle)}</strong>
                                <span>${escapeHtml(entry.result || "Opened")}</span>
                            </div>
                            <div class="ych-log-time">${escapeHtml(formatLogDate(entry.timestamp))}</div>
                            <div class="ych-log-details">
                                <span>Likes: <b>${escapeHtml(likes)}</b></span>
                                <span>Target: <b>${escapeHtml(threshold)}</b></span>
                                <span>Delay: <b>${escapeHtml(delay)}</b></span>
                            </div>
                        </div>
                    `;
                })
                .join("");
    }

    function renderActionLog() {
        if (!helperPanel) {
            return;
        }

        const container =
            helperPanel.querySelector(
                '[data-field="action-log"]'
            );

        const count =
            helperPanel.querySelector(
                '[data-field="action-log-count"]'
            );

        if (!container) {
            return;
        }

        if (count) {
            count.textContent =
                String(actionLog.length);
        }

        if (!actionLog.length) {
            container.innerHTML =
                '<div class="ych-action-log-empty">No actions recorded yet.</div>';
            return;
        }

        container.innerHTML =
            actionLog
                .map(
                    entry => `
                        <div class="ych-action-log-entry">
                            <div class="ych-action-log-top">
                                <span class="ych-action-log-type">${escapeHtml(entry.type)}</span>
                                <time>${escapeHtml(formatLogDate(entry.timestamp))}</time>
                            </div>
                            <div class="ych-action-log-message">${escapeHtml(entry.message)}</div>
                        </div>
                    `
                )
                .join("");
    }

    /*
     * ============================================================
     * BASIC HELPERS
     * ============================================================
     */

    function sleep(ms) {
        return new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    ms
                )
        );
    }

    function normalizeText(value) {
        return String(
            value || ""
        )
            .replace(
                /\u00a0/g,
                " "
            )
            .replace(
                /\s+/g,
                " "
            )
            .trim()
            .toLowerCase();
    }

    function isVisible(element) {
        if (!element) {
            return false;
        }

        try {
            const style =
                window.getComputedStyle(
                    element
                );

            if (
                style.display ===
                    "none" ||
                style.visibility ===
                    "hidden" ||
                style.opacity ===
                    "0"
            ) {
                return false;
            }

            const rect =
                element.getBoundingClientRect();

            return (
                rect.width > 0 &&
                rect.height > 0
            );
        } catch (_) {
            return false;
        }
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, Number(value) || 0));
    }

    function formatLikes(value) {
        if (
            value === null ||
            value === undefined ||
            !Number.isFinite(
                Number(value)
            )
        ) {
            return "—";
        }

        return Number(value)
            .toLocaleString(
                "en-US"
            );
    }

    function remainingSeconds(
        end
    ) {
        if (!end) {
            return null;
        }

        return Math.max(
            0,
            Math.ceil(
                (
                    end -
                    Date.now()
                ) / 1000
            )
        );
    }

    function formatTimer(
        seconds
    ) {
        if (
            seconds === null ||
            seconds === undefined
        ) {
            return "—";
        }

        const total =
            Math.max(
                0,
                Math.ceil(
                    seconds
                )
            );

        const minutes =
            Math.floor(
                total / 60
            );

        const secondsPart =
            total % 60;

        if (minutes > 0) {
            return (
                `${minutes}m ` +
                `${String(
                    secondsPart
                ).padStart(
                    2,
                    "0"
                )}s`
            );
        }

        return `${secondsPart}s`;
    }

    function setAction(message) {
        lastAction =
            String(
                message || ""
            );

        addActionLog(
            lastAction,
            "ACTION"
        );

        if (settings.actionLogEnabled) {
            console.log(
                `[Chest Helper ${VERSION}] ${lastAction}`
            );
        }

        updateUI();
    }

    function setState(
        newState
    ) {
        const previousState =
            state;

        state =
            newState;

        stateStartedAt =
            Date.now();

        if (previousState !== newState) {
            addActionLog(
                `State changed: ${previousState} → ${newState}`,
                "STATE"
            );
        }

        updateUI();
    }

    /*
     * ============================================================
     * NUMBER PARSING
     * ============================================================
     */

    function parseYouNowNumber(
        value
    ) {
        if (
            value === null ||
            value === undefined
        ) {
            return null;
        }

        let text =
            String(value)
                .trim()
                .replace(
                    /\u00a0/g,
                    " "
                )
                .replace(
                    /\s+/g,
                    ""
                )
                .toUpperCase();

        if (!text) {
            return null;
        }

        let multiplier = 1;

        if (
            text.endsWith("K")
        ) {
            multiplier = 1000;

            text =
                text.slice(
                    0,
                    -1
                );
        } else if (
            text.endsWith("M")
        ) {
            multiplier = 1000000;

            text =
                text.slice(
                    0,
                    -1
                );
        } else if (
            text.endsWith("B")
        ) {
            multiplier = 1000000000;

            text =
                text.slice(
                    0,
                    -1
                );
        }

        text =
            text.replace(
                /[^0-9.,+-]/g,
                ""
            );

        if (!text) {
            return null;
        }

        if (
            text.includes(".") &&
            text.includes(",")
        ) {
            const dot =
                text.lastIndexOf(".");

            const comma =
                text.lastIndexOf(",");

            if (
                dot > comma
            ) {
                text =
                    text.replace(
                        /,/g,
                        ""
                    );
            } else {
                text =
                    text.replace(
                        /\./g,
                        ""
                    );

                text =
                    text.replace(
                        ",",
                        "."
                    );
            }
        } else if (
            text.includes(",")
        ) {
            const pieces =
                text.split(",");

            if (
                pieces.length > 2 ||
                pieces[
                    pieces.length - 1
                ].length === 3
            ) {
                text =
                    text.replace(
                        /,/g,
                        ""
                    );
            }
        } else if (
            text.includes(".")
        ) {
            const pieces =
                text.split(".");

            if (
                pieces.length > 2 ||
                pieces[
                    pieces.length - 1
                ].length === 3
            ) {
                text =
                    text.replace(
                        /\./g,
                        ""
                    );
            }
        }

        const number =
            parseFloat(
                text
            );

        if (
            !Number.isFinite(
                number
            )
        ) {
            return null;
        }

        return Math.round(
            number *
                multiplier
        );
    }

    /*
     * ============================================================
     * BROADCAST DETECTION / SAFETY
     * ============================================================
     */

    function findBroadcastEndButton() {
        const candidates = Array.from(
            document.querySelectorAll(
                'button.button.button--small.button--red'
            )
        );

        return candidates.find(
            button =>
                isVisible(button) &&
                String(button.textContent || "").trim() === "END"
        ) || null;
    }

    function detectOwnBroadcasting() {
        return Boolean(findBroadcastEndButton());
    }

    function resetAutomationForNonBroadcast() {
        chestTimerEnd = null;
        openingTimerEnd = null;
        autoInfoNextAt = null;
        checkCycleInProgress = false;
        likesReadThisCheck = false;
        likesCheckDeadline = null;
        soundPlayedForCycle = false;
        currentLikes = null;
        lockedLikes = null;
        likesLockedForCycle = false;
        cycleLocked = false;
        preOpenVerification = false;
        openedChestRecordedForCycle = false;
        winnerCloseAttempts = 0;
        lastObservedChestState = getChestState();
        offModeCheckedForAvailableChest = false;
        state = STATES.OFF;
    }

    function updateBroadcastSafety() {
        const live = detectOwnBroadcasting();

        if (!live) {
            if (ownBroadcastActive || !broadcastDetectionInitialized) {
                ownBroadcastActive = false;
                broadcastDetectionInitialized = true;
                resetChestApiSnapshot();
                resetAutomationForNonBroadcast();
                if (settings.enabled) {
                    setAction("NOT LIVE — automation stopped (END button not found)");
                } else {
                    addActionLog(
                        "NOT LIVE — END button not found",
                        "SAFETY"
                    );
                }
            }
            return false;
        }

        if (!ownBroadcastActive) {
            ownBroadcastActive = true;
            broadcastDetectionInitialized = true;
            resetChestApiSnapshot();
            chestTimerEnd = null;
            openingTimerEnd = null;
            autoInfoNextAt = null;
            checkCycleInProgress = false;
            likesReadThisCheck = false;
            likesCheckDeadline = null;
            soundPlayedForCycle = false;
            currentLikes = null;
            lockedLikes = null;
            likesLockedForCycle = false;
            cycleLocked = false;
            preOpenVerification = false;
            openedChestRecordedForCycle = false;
            winnerCloseAttempts = 0;
            stateStartedAt = Date.now();
            recoveryStartedAt = Date.now();
            /* Force a fresh AVAILABLE check after going live. */
            lastObservedChestState = "UNKNOWN";
            offModeCheckedForAvailableChest = false;
            if (settings.enabled) {
                state = STATES.WAITING_FOR_CHEST;
                scheduleAutoInfo();
                setAction("LIVE — END button detected; automation active");
            } else {
                addActionLog(
                    "LIVE — END button detected; automation is OFF",
                    "SAFETY"
                );
            }
        }
        return true;
    }

    function canPerformAutomatedAction(requireAvailableChest = false) {
        if (!updateBroadcastSafety()) {
            return false;
        }

        const chestState = getChestState();

        if (chestState === "UNKNOWN") {
            if (lastAction !== "Chest state UNKNOWN — waiting before automated action") {
                setAction("Chest state UNKNOWN — waiting before automated action");
            }
            return false;
        }

        if (requireAvailableChest && chestState !== "AVAILABLE") {
            if (lastAction !== "Chest UNAVAILABLE — waiting before chest action") {
                setAction("Chest UNAVAILABLE — waiting before chest action");
            }
            return false;
        }

        return true;
    }

    /*
     * ============================================================
     * ACTUAL CHEST BUTTON
     * ============================================================
     */

    function getChestButton() {
        const buttons =
            Array.from(
                document.querySelectorAll(
                    'button.chest-button[aria-label="Chest button"]'
                )
            );

        return buttons.find(isVisible) || null;
    }

    function getChestApiParameter(resourceName, parameterName) {
        try {
            const parsed =
                new URL(
                    resourceName,
                    pageWindow.location.href
                );

            const prefix =
                `${parameterName}=`;

            const pathSegment =
                parsed.pathname
                    .split("/")
                    .find(
                        segment =>
                            segment.startsWith(prefix)
                    );

            if (pathSegment) {
                const value =
                    pathSegment.slice(prefix.length);

                try {
                    return decodeURIComponent(value);
                } catch (_) {
                    return value;
                }
            }

            return parsed.searchParams.get(parameterName);
        } catch (_) {
            return null;
        }
    }

    function findLatestChestApiParameter(routePart, parameterName) {
        try {
            const entries =
                pageWindow.performance
                    .getEntriesByType("resource")
                    .filter(
                        entry =>
                            typeof entry.name === "string" &&
                            entry.name.includes(routePart)
                    )
                    .sort(
                        (a, b) =>
                            (b.startTime || 0) -
                            (a.startTime || 0)
                    );

            for (const entry of entries) {
                const value =
                    getChestApiParameter(
                        entry.name,
                        parameterName
                    );

                if (value) {
                    return value;
                }
            }
        } catch (_) {}

        return null;
    }

    function getChestApiContext() {
        const userId =
            findLatestChestApiParameter(
                "/php/api/younow/notificationCount",
                "userId"
            );

        const channelId =
            findLatestChestApiParameter(
                "/php/api/channel/getStickers",
                "channelId"
            );

        if (!userId || !channelId) {
            return null;
        }

        return {
            userId,
            channelId
        };
    }

    function resetChestApiSnapshot() {
        chestApiSnapshot = null;
        chestApiSnapshotAt = 0;
        chestApiLastFetchAt = 0;
        chestApiContextKey = "";
        chestApiSnapshotPageUrl =
            String(pageWindow.location.href || "");
    }

    function getFreshChestApiSnapshot() {
        if (
            !ownBroadcastActive ||
            !chestApiSnapshot ||
            Date.now() - chestApiSnapshotAt >
                CHEST_API_SNAPSHOT_MAX_AGE_MS ||
            String(pageWindow.location.href || "") !==
                chestApiSnapshotPageUrl
        ) {
            return null;
        }

        return chestApiSnapshot;
    }

    async function refreshChestApiSnapshot(force = false) {
        const currentPageUrl =
            String(pageWindow.location.href || "");

        if (
            currentPageUrl !==
            chestApiSnapshotPageUrl
        ) {
            resetChestApiSnapshot();
        }

        if (
            !ownBroadcastActive ||
            chestApiRequestInFlight ||
            (!force &&
                Date.now() - chestApiLastFetchAt <
                    CHEST_API_REFRESH_INTERVAL_MS)
        ) {
            return;
        }

        chestApiLastFetchAt = Date.now();

        const context =
            getChestApiContext();

        if (!context) {
            return;
        }

        const contextKey =
            `${context.userId}:${context.channelId}`;

        if (contextKey !== chestApiContextKey) {
            chestApiSnapshot = null;
            chestApiSnapshotAt = 0;
            chestApiContextKey = contextKey;
        }

        const pageFetch =
            pageWindow.fetch;

        if (typeof pageFetch !== "function") {
            return;
        }

        const endpoint =
            `${CHEST_API_URL}/userId=${encodeURIComponent(context.userId)}` +
            `/channelId=${encodeURIComponent(context.channelId)}`;

        const requestPageUrl =
            currentPageUrl;

        chestApiRequestInFlight = true;

        try {
            const response =
                await pageFetch.call(
                    pageWindow,
                    endpoint,
                    {
                        method: "GET",
                        credentials: "include",
                        cache: "no-store"
                    }
                );

            if (!response.ok) {
                return;
            }

            const payload =
                await response.json();

            if (
                String(pageWindow.location.href || "") !==
                    requestPageUrl ||
                contextKey !== chestApiContextKey ||
                Number(payload?.errorCode) !== 0
            ) {
                return;
            }

            const chest =
                payload?.propsChest;

            if (!chest || typeof chest !== "object") {
                chestApiSnapshot = {
                    hasChest: false,
                    chestId: "",
                    state: "CHEST_UNAVAILABLE",
                    likes: null,
                    minLikesToAvailable: null
                };
                chestApiSnapshotAt = Date.now();
                return;
            }

            const likes =
                chest.likes === null ||
                chest.likes === undefined
                    ? null
                    : Number(chest.likes);

            const minLikesToAvailable =
                chest.minLikesToAvailable === null ||
                chest.minLikesToAvailable === undefined
                    ? null
                    : Number(chest.minLikesToAvailable);

            chestApiSnapshot = {
                hasChest: true,
                chestId: String(chest.id ?? ""),
                state: String(chest.state || ""),
                likes: Number.isFinite(likes) ? likes : null,
                minLikesToAvailable:
                    Number.isFinite(minLikesToAvailable)
                        ? minLikesToAvailable
                        : null
            };

            chestApiSnapshotAt = Date.now();
        } catch (_) {
            /* Keep using the existing DOM detector if the API is unavailable. */
        } finally {
            chestApiRequestInFlight = false;
        }
    }

    function getChestApiState(snapshot) {
        if (!snapshot) {
            return "UNKNOWN";
        }

        if (!snapshot.hasChest) {
            return "UNAVAILABLE";
        }

        const apiState =
            String(snapshot.state || "")
                .trim()
                .toUpperCase();

        if (
            apiState === "CHEST_UNAVAILABLE" ||
            apiState === "UNAVAILABLE" ||
            apiState === "CHEST_OPEN" ||
            apiState === "WAITING_FOR_RESULTS"
        ) {
            return "UNAVAILABLE";
        }

        if (
            apiState === "CHEST_AVAILABLE" ||
            apiState === "AVAILABLE" ||
            /^CHEST_OVERFLOWING_[1-5]$/.test(apiState)
        ) {
            return "AVAILABLE";
        }

        return "UNKNOWN";
    }

    function getChestStateFromDOM() {
        const button =
            getChestButton();

        if (!button) {
            return "UNKNOWN";
        }

        const image =
            button.querySelector(
                'img[alt="Chest state image"]'
            );

        if (!image) {
            return "UNKNOWN";
        }

        const src =
            String(image.getAttribute("src") || "")
                .replace(/\s+/g, "");

        if (
            src.includes("/unavailable.svg")
        ) {
            return "UNAVAILABLE";
        }

        if (
            src.includes("/available.svg")
        ) {
            return "AVAILABLE";
        }

        return "UNKNOWN";
    }

    function getChestState() {
        const apiState =
            getChestApiState(
                getFreshChestApiSnapshot()
            );

        if (apiState !== "UNKNOWN") {
            return apiState;
        }

        return getChestStateFromDOM();
    }

    function getChestStateLabel() {
        const chestState =
            getChestState();

        const snapshot =
            getFreshChestApiSnapshot();

        if (
            !snapshot ||
            !snapshot.hasChest ||
            snapshot.likes === null ||
            snapshot.minLikesToAvailable === null
        ) {
            return chestState;
        }

        return `${chestState} (${formatLikes(snapshot.likes)} / ${formatLikes(snapshot.minLikesToAvailable)})`;
    }

    function isChestAvailable() {
        return (
            getChestState() ===
            "AVAILABLE"
        );
    }

    /*
     * ============================================================
     * TREASURE CHEST MODAL
     * ============================================================
     */

    function getTreasureChestModal() {
        const candidates =
            Array.from(
                document.querySelectorAll(
                    '[role="dialog"], .modal, .dialog, [class*="modal"]'
                )
            ).filter(
                isVisible
            );

        const chestModal =
            candidates.find(
                element => {
                    const text =
                        normalizeText(
                            element.textContent
                        );

                    return (
                        text.includes(
                            "treasure chest"
                        ) &&
                        text.includes(
                            "open"
                        ) &&
                        text.includes(
                            "cancel"
                        )
                    );
                }
            );

        return (
            chestModal ||
            null
        );
    }

    function isChestModalOpen() {
        return Boolean(
            getTreasureChestModal()
        );
    }

    /*
     * ============================================================
     * ACTUAL TREASURE CHEST OPEN/CANCEL MODAL
     *
     * This is NOT the sidebar check panel.
     *
     * It appears after the actual chest is clicked and contains
     * the live reward preview plus Open / Cancel.
     * ============================================================
     */

    function findChestCancelButton() {
        const modal =
            getTreasureChestModal();

        if (!modal) {
            return null;
        }

        const buttons =
            Array.from(
                modal.querySelectorAll(
                    'button'
                )
            ).filter(
                isVisible
            );

        const exact =
            buttons.find(
                button =>
                    normalizeText(
                        button.textContent
                    ) ===
                    "cancel"
            );

        if (exact) {
            return exact;
        }

        return (
            buttons.find(
                button => {
                    const aria =
                        normalizeText(
                            button.getAttribute(
                                "aria-label"
                            )
                        );

                    const title =
                        normalizeText(
                            button.getAttribute(
                                "title"
                            )
                        );

                    return (
                        aria === "cancel" ||
                        title === "cancel"
                    );
                }
            ) ||
            null
        );
    }

    async function closeTreasureChestModal() {
        for (
            let attempt = 0;
            attempt < 3;
            attempt++
        ) {
            if (
                !isChestModalOpen()
            ) {
                return true;
            }

            const cancel =
                findChestCancelButton();

            if (!cancel) {
                setAction(
                    `Treasure Chest modal: Cancel not found (${attempt + 1}/3)`
                );

                await sleep(150);
                continue;
            }

            if (!canPerformAutomatedAction()) {
                return false;
            }

            try {
                cancel.click();

                setAction(
                    `Treasure Chest modal: clicked "Cancel" (${attempt + 1}/3)`
                );
            } catch (error) {
                console.warn(
                    "[Chest Helper] Treasure Chest modal Cancel failed:",
                    error
                );
            }

            const started =
                Date.now();

            while (
                Date.now() -
                    started <
                1200
            ) {
                if (
                    !isChestModalOpen()
                ) {
                    setAction(
                        "Treasure Chest modal CLOSED with Cancel"
                    );

                    return true;
                }

                await sleep(100);
            }
        }

        /*
         * Final Escape fallback for the actual Open/Cancel modal only.
         * Never click the chest button to close it.
         */
        try {
            if (!canPerformAutomatedAction()) {
                return false;
            }

            document.dispatchEvent(
                new KeyboardEvent(
                    "keydown",
                    {
                        key: "Escape",
                        code: "Escape",
                        keyCode: 27,
                        which: 27,
                        bubbles: true
                    }
                )
            );

            await sleep(250);

            if (
                !isChestModalOpen()
            ) {
                setAction(
                    "Treasure Chest modal CLOSED with Escape"
                );

                return true;
            }
        } catch (error) {
            console.warn(
                "[Chest Helper] Treasure Chest modal Escape failed:",
                error
            );
        }

        return !isChestModalOpen();
    }

    /*
     * ============================================================
     * CHEST CHECK PANEL
     *
     * This is the sidebar panel opened by the normal chest button.
     * It is different from the later Treasure Chest Open/Cancel
     * dialog used during the actual opening sequence.
     *
     * The UNAVAILABLE chest can show the education panel with:
     *   - Treasure Chest title
     *   - live likes value
     *   - "Got it" button
     *
     * Therefore availability must NOT be used to decide whether the
     * check panel exists or whether its likes can be read.
     * ============================================================
     */

    function getChestCheckPanel() {
        const panels =
            Array.from(
                document.querySelectorAll(
                    '.sidebar-modal-chest, app-sidebar-modal-chest-broadcaster-education'
                )
            ).filter(
                isVisible
            );

        if (!panels.length) {
            return null;
        }

        /* Prefer the panel that actually contains the live counter. */
        const counterPanel =
            panels.find(
                panel =>
                    panel.querySelector(
                        '.total-likes .value'
                    )
            );

        if (counterPanel) {
            return counterPanel;
        }

        return panels[0];
    }

    function isChestCheckPanelOpen() {
        return Boolean(
            getChestCheckPanel()
        );
    }

    /*
     * ============================================================
     * CHEST LIKES
     *
     * Use only the fresh read-only API snapshot. The page's displayed
     * counter is not used to decide whether an API open may be sent.
     * ============================================================
     */

    function getChestLikes() {
        if (
            state !==
                STATES.READING_LIKES ||
            likesLockedForCycle
        ) {
            return null;
        }

        const apiSnapshot =
            getFreshChestApiSnapshot();

        if (
            apiSnapshot &&
            apiSnapshot.likes !== null
        ) {
            lastCheckedLikes =
                apiSnapshot.likes;

            currentLikes =
                apiSnapshot.likes;

            return apiSnapshot.likes;
        }

        return null;
    }

    /*
     * ============================================================
     * CLOSE CHEST CHECK PANEL
     *
     * For an UNAVAILABLE chest the visible close control is the
     * "Got it" button shown in the education panel. For the normal
     * chest panel, Cancel is supported as before.
     *
     * IMPORTANT: Never click the chest button as a close fallback.
     * ============================================================
     */

    function findChestPanelCloseButton() {
        const panel =
            getChestCheckPanel();

        if (!panel) {
            return null;
        }

        const buttons =
            Array.from(
                panel.querySelectorAll(
                    'button'
                )
            ).filter(
                isVisible
            );

        /* Unavailable education panel shown in the supplied screenshot. */
        const gotIt =
            buttons.find(
                button =>
                    normalizeText(
                        button.textContent
                    ) ===
                    'got it'
            );

        /*
         * The unavailable chest screenshot shows this exact control.
         * Prefer it over every other close control.
         */
        if (gotIt) {
            return gotIt;
        }

        /* Normal panel / legacy close control. */
        const cancel =
            buttons.find(
                button =>
                    normalizeText(
                        button.textContent
                    ) ===
                    'cancel'
            );

        if (cancel) {
            return cancel;
        }

        const labelledClose =
            buttons.find(
                button => {
                    const aria =
                        normalizeText(
                            button.getAttribute(
                                'aria-label'
                            )
                        );

                    const title =
                        normalizeText(
                            button.getAttribute(
                                'title'
                            )
                        );

                    return (
                        aria === 'close' ||
                        title === 'close'
                    );
                }
            );

        return labelledClose || null;
    }

    async function closeChestPanel() {
        for (
            let attempt = 0;
            attempt < 3;
            attempt++
        ) {
            if (
                !isChestCheckPanelOpen()
            ) {
                return true;
            }

            const closeButton =
                findChestPanelCloseButton();

            if (!closeButton) {
                setAction(
                    `Chest panel close control not found (${attempt + 1}/3)`
                );

                await sleep(150);
                continue;
            }

            const label =
                normalizeText(
                    closeButton.textContent
                ) ||
                closeButton.getAttribute(
                    'aria-label'
                ) ||
                'close';

            const isGotIt =
                label === 'got it';

            if (!canPerformAutomatedAction()) {
                return false;
            }

            try {
                closeButton.click();

                setAction(
                    isGotIt
                        ? `Unavailable chest: clicked "Got it" after reading likes`
                        : `Chest panel: clicked "${label}" (${attempt + 1}/3)`
                );
            } catch (error) {
                console.warn(
                    '[Chest Helper] Chest panel close click failed:',
                    error
                );
            }

            const started =
                Date.now();

            while (
                Date.now() -
                    started <
                1500
            ) {
                if (
                    !isChestCheckPanelOpen()
                ) {
                    setAction(
                        `Chest panel CLOSED with "${label}"`
                    );

                    return true;
                }

                await sleep(100);
            }
        }

        /*
         * Escape is only a final fallback after the panel's own close
         * control has been attempted. The chest button is NEVER used.
         */
        setAction(
            'Chest panel did not close with its close control — using Escape fallback'
        );

        if (!canPerformAutomatedAction()) {
            return false;
        }

        document.dispatchEvent(
            new KeyboardEvent(
                'keydown',
                {
                    key: 'Escape',
                    code: 'Escape',
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true
                }
            )
        );

        await sleep(600);

        const closed =
            !isChestCheckPanelOpen();

        if (closed) {
            setAction(
                'Chest panel CLOSED with Escape'
            );
        } else {
            setAction(
                'Chest panel remains open after Escape'
            );
        }

        return closed;
    }

    /*
     * Open the broadcaster's current chest through the same first-party
     * API action used by YouNow's client. The API snapshot is checked again
     * immediately before sending the POST so stale page state cannot gate
     * or trigger an open.
     */
    function getStoredYouNowValue(key) {
        try {
            const raw =
                pageWindow.localStorage.getItem(key);

            if (raw === null || raw === undefined) {
                return "";
            }

            try {
                const parsed = JSON.parse(raw);
                return String(parsed ?? "");
            } catch (_) {
                return String(raw);
            }
        } catch (_) {
            return "";
        }
    }

    async function openChestViaApi() {
        if (!updateBroadcastSafety()) {
            return "blocked";
        }

        const context =
            getChestApiContext();

        const apiUserId =
            Number(context?.userId);

        const snapshot =
            getFreshChestApiSnapshot();

        if (
            !context ||
            !Number.isSafeInteger(apiUserId) ||
            apiUserId <= 0
        ) {
            setAction(
                "Signed-in user ID is invalid — API open request not sent"
            );
            return "blocked";
        }

        if (
            !snapshot ||
            !snapshot.hasChest ||
            !snapshot.chestId
        ) {
            setAction(
                "API chest data is missing or stale — open request not sent"
            );
            return "blocked";
        }

        if (
            chestApiOpenAttemptedId ===
            snapshot.chestId
        ) {
            setAction(
                "Open already attempted for this chest — waiting for its API state to change"
            );
            return "blocked";
        }

        if (snapshot.likes === null) {
            setAction(
                "Final API likes are unavailable — open request not sent"
            );

            return "blocked";
        }

        if (snapshot.likes < settings.threshold) {
            setAction(
                `Final API likes ${formatLikes(snapshot.likes)} are below the configured target ${formatLikes(settings.threshold)} — open request not sent`
            );

            return "blocked";
        }

        if (
            getChestApiState(snapshot) !== "AVAILABLE" ||
            snapshot.minLikesToAvailable === null ||
            snapshot.likes < snapshot.minLikesToAvailable
        ) {
            setAction(
                "API says chest is not ready — open request not sent"
            );
            return "blocked";
        }

        const pageFetch =
            pageWindow.fetch;

        if (typeof pageFetch !== "function") {
            setAction(
                "Browser fetch is unavailable — API open request not sent"
            );
            return "blocked";
        }

        const requestPageUrl =
            String(pageWindow.location.href || "");

        const formData =
            new URLSearchParams();

        formData.set(
            "userId",
            String(apiUserId)
        );

        const trpxId =
            getStoredYouNowValue("TRPX_ID");

        const trpxDeviceId =
            getStoredYouNowValue("TRPX_DEVICE_ID");

        const language =
            getStoredYouNowValue("UI_LANGUAGE") ||
            String(document.documentElement.lang || "en");

        if (trpxId) {
            formData.set("tsi", trpxId);
        }

        if (trpxDeviceId) {
            formData.set("tdi", trpxDeviceId);
        }

        formData.set("lang", language);

        const headers = {
            "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8"
        };

        const requestBy =
            getStoredYouNowValue("REQUEST_BY");

        if (requestBy) {
            headers["X-Requested-By"] = requestBy;
        }

        /* Lock this chest before sending; a lost response must not cause a duplicate open. */
        chestApiOpenAttemptedId =
            snapshot.chestId;

        try {
            const response =
                await pageFetch.call(
                    pageWindow,
                    CHEST_API_OPEN_URL,
                    {
                        method: "POST",
                        credentials: "include",
                        cache: "no-store",
                        headers,
                        body: formData.toString()
                    }
                );

            let payload = null;

            try {
                payload = await response.json();
            } catch (_) {}

            const apiErrorMessage =
                String(
                    payload?.errorMsg ||
                    payload?.errorMessage ||
                    payload?.message ||
                    payload?.error ||
                    ""
                )
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 120);

            const apiErrorSuffix =
                apiErrorMessage
                    ? ` — ${apiErrorMessage}`
                    : "";

            if (!response.ok) {
                setAction(
                    `YouNow API open failed (${response.status})${apiErrorSuffix} — no automatic retry for this chest`
                );
                return "failed";
            }

            if (Number(payload?.errorCode) !== 0) {
                setAction(
                    `YouNow rejected the API open request (error ${payload?.errorCode ?? "unknown"})${apiErrorSuffix}`
                );
                return "failed";
            }

            if (
                String(pageWindow.location.href || "") !==
                requestPageUrl
            ) {
                setAction(
                    "API open succeeded after the page changed — stopped automation"
                );
                return "failed";
            }

            chestApiSnapshot = {
                ...snapshot,
                state: "CHEST_OPEN"
            };
            chestApiSnapshotAt = Date.now();
            chestOpenConfirmedForCycle = true;

            setAction(
                `Chest opened through YouNow API (${formatLikes(snapshot.likes)} likes)`
            );

            return "opened";
        } catch (error) {
            console.warn(
                "[Chest Helper] API chest open failed:",
                error
            );

            setAction(
                "API open response was uncertain — no automatic retry for this chest"
            );

            return "failed";
        }
    }

    /*
     * ============================================================
     * MAKE IT RAIN
     * ============================================================
     */

    function findMakeItRainButton() {
        return (
            Array.from(
                document.querySelectorAll(
                    "button"
                )
            )
                .filter(
                    isVisible
                )
                .find(
                    button =>
                        normalizeText(
                            button.textContent
                        ) ===
                        "make it rain"
                ) ||
            null
        );
    }

    function clickMakeItRain() {
        if (!canPerformAutomatedAction()) return false;

        const button =
            findMakeItRainButton();

        if (!button) {
            return false;
        }

        try {
            button.click();

            setAction(
                "Make It Rain clicked"
            );

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Make It Rain failed:",
                error
            );

            return false;
        }
    }

    /*
     * ============================================================
     * I'LL TELL THEM
     * ============================================================
     */

    function findTellThemButton() {
        return (
            Array.from(
                document.querySelectorAll(
                    "button"
                )
            )
                .filter(
                    isVisible
                )
                .find(
                    button =>
                        normalizeText(
                            button.textContent
                        ) ===
                        "i'll tell them!"
                ) ||
            null
        );
    }

    function clickTellThem() {
        if (!canPerformAutomatedAction()) return false;

        const button =
            findTellThemButton();

        if (!button) {
            return false;
        }

        try {
            button.click();

            setAction(
                "I'll tell them clicked"
            );

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Tell Them failed:",
                error
            );

            return false;
        }
    }

    /*
     * ============================================================
     * WINNERS PANEL
     * ============================================================
     * YouNow's Winners/Experience overlay is not consistently exposed
     * as one particular class.  Find it from its visible text and then
     * locate the Close control inside that exact element/ancestor.
     */

    function getVisibleElementsWithExactText(text) {
        const wanted = normalizeText(text);

        return Array.from(
            document.querySelectorAll(
                "body *"
            )
        ).filter(element => {
            if (!isVisible(element)) {
                return false;
            }

            return normalizeText(
                element.textContent
            ) === wanted;
        });
    }

    function findClickableCloseIn(root) {
        if (!root) {
            return null;
        }

        const controls = Array.from(
            root.querySelectorAll(
                "button, [role='button'], a, [tabindex], [aria-label], [title]"
            )
        ).filter(isVisible);

        for (const control of controls) {
            const text = normalizeText(
                control.textContent
            );
            const aria = normalizeText(
                control.getAttribute("aria-label")
            );
            const title = normalizeText(
                control.getAttribute("title")
            );

            if (
                text === "close" ||
                aria === "close" ||
                title === "close"
            ) {
                return control;
            }
        }

        /* Some builds render Close as a non-button element. */
        const exactClose =
            getVisibleElementsWithExactText("Close")
                .find(element =>
                    root === element ||
                    root.contains(element)
                );

        if (exactClose) {
            return findClickableAncestor(
                exactClose,
                root
            );
        }

        return null;
    }

    function findClickableAncestor(element, limitRoot = null) {
        let current = element;
        let depth = 0;

        while (
            current &&
            current !== document.body &&
            depth < 8
        ) {
            if (
                current.matches &&
                current.matches(
                    "button, [role='button'], a, [tabindex]"
                ) &&
                isVisible(current)
            ) {
                return current;
            }

            if (
                limitRoot &&
                current === limitRoot
            ) {
                break;
            }

            current = current.parentElement;
            depth++;
        }

        return element && isVisible(element)
            ? element
            : null;
    }

    function findWinnersPanel() {
        /* First choice: the literal Winners! heading. */
        const winnerLabels =
            getVisibleElementsWithExactText("Winners!");

        const candidates = [];

        for (const label of winnerLabels) {
            let current = label.parentElement;
            let depth = 0;

            while (
                current &&
                current !== document.body &&
                depth < 10
            ) {
                const close =
                    findClickableCloseIn(current);

                if (close) {
                    candidates.push({
                        panel: current,
                        close,
                        depth,
                        area: (() => {
                            const r = current.getBoundingClientRect();
                            return r.width * r.height;
                        })()
                    });

                    /* Stop at the first useful containing panel. */
                    break;
                }

                current = current.parentElement;
                depth++;
            }
        }

        /* Fallback for builds that omit the literal Winners! heading. */
        const generic = Array.from(
            document.querySelectorAll(
                '[role="dialog"], .modal, .dialog, [class*="modal"], [class*="drawer"], [class*="panel"]'
            )
        ).filter(isVisible);

        for (const element of generic) {
            const text = normalizeText(
                element.textContent
            );

            if (
                !text.includes("winners") &&
                !text.includes("experience") &&
                !text.includes("reward")
            ) {
                continue;
            }

            const close =
                findClickableCloseIn(element);

            if (close) {
                const r = element.getBoundingClientRect();
                candidates.push({
                    panel: element,
                    close,
                    depth: 99,
                    area: r.width * r.height
                });
            }
        }

        if (!candidates.length) {
            return null;
        }

        candidates.sort((a, b) => {
            if (a.depth !== b.depth) {
                return a.depth - b.depth;
            }

            return a.area - b.area;
        });

        return candidates[0].panel;
    }

    function findWinnerCloseButton(panel) {
        if (!panel) {
            return null;
        }

        const direct =
            findClickableCloseIn(panel);

        if (direct) {
            return direct;
        }

        /* Last-resort search for a visible exact Close element inside panel. */
        const exactClose =
            getVisibleElementsWithExactText("Close")
                .find(element =>
                    panel === element ||
                    panel.contains(element)
                );

        return exactClose
            ? findClickableAncestor(
                exactClose,
                panel
            )
            : null;
    }

    function clickWinnerCloseControl(button) {
        if (!button || !canPerformAutomatedAction()) {
            return false;
        }

        try {
            if (typeof PointerEvent === "function") {
                button.dispatchEvent(
                    new PointerEvent("pointerdown", {
                        bubbles: true,
                        cancelable: true,
                        button: 0
                    })
                );
            }

            button.dispatchEvent(
                new MouseEvent("mousedown", {
                    bubbles: true,
                    cancelable: true,
                    button: 0
                })
            );

            if (typeof PointerEvent === "function") {
                button.dispatchEvent(
                    new PointerEvent("pointerup", {
                        bubbles: true,
                        cancelable: true,
                        button: 0
                    })
                );
            }

            button.dispatchEvent(
                new MouseEvent("mouseup", {
                    bubbles: true,
                    cancelable: true,
                    button: 0
                })
            );

            if (!canPerformAutomatedAction()) {
                return false;
            }

            button.click();

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Winners close dispatch failed:",
                error
            );

            try {
                if (!canPerformAutomatedAction()) {
                    return false;
                }

                button.click();
                return true;
            } catch (_) {
                return false;
            }
        }
    }

    async function closeWinnersPanel() {
        const panel = findWinnersPanel();

        if (!panel) {
            winnerCloseAttempts = 0;
            return true;
        }

        const close =
            findWinnerCloseButton(panel);

        if (!close) {
            winnerCloseAttempts++;
            setAction(
                `Winners panel found — Close control not found (${winnerCloseAttempts})`
            );

            if (winnerCloseAttempts >= 4) {
                setAction(
                    "Winners Close control unavailable — using Escape"
                );

                if (!canPerformAutomatedAction()) {
                    return false;
                }

                document.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: "Escape",
                        code: "Escape",
                        keyCode: 27,
                        which: 27,
                        bubbles: true,
                        cancelable: true
                    })
                );

                await sleep(500);

                if (!findWinnersPanel()) {
                    winnerCloseAttempts = 0;
                    return true;
                }
            }

            return false;
        }

        winnerCloseAttempts++;

        const clicked =
            clickWinnerCloseControl(close);

        setAction(
            clicked
                ? `Winners Close clicked (${winnerCloseAttempts})`
                : `Winners Close click failed (${winnerCloseAttempts})`
        );

        await sleep(500);

        if (!findWinnersPanel()) {
            winnerCloseAttempts = 0;
            setAction("Winners panel CLOSED");
            return true;
        }

        if (winnerCloseAttempts >= 4) {
            if (!canPerformAutomatedAction()) {
                return false;
            }

            document.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    code: "Escape",
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true
                })
            );

            await sleep(500);

            if (!findWinnersPanel()) {
                winnerCloseAttempts = 0;
                setAction("Winners panel CLOSED with Escape");
                return true;
            }
        }

        return false;
    }

    /*
     * ============================================================
     * CHAT
     * ============================================================
     */

    function getChatInput() {
        const exact =
            document.querySelector(
                'textarea[aria-label="Chat input text"]'
            );

        if (
            exact &&
            isVisible(exact)
        ) {
            return exact;
        }

        return (
            Array.from(
                document.querySelectorAll(
                    "textarea"
                )
            ).find(
                textarea => {
                    if (
                        !isVisible(
                            textarea
                        )
                    ) {
                        return false;
                    }

                    const aria =
                        textarea.getAttribute(
                            "aria-label"
                        ) || "";

                    const placeholder =
                        textarea.getAttribute(
                            "placeholder"
                        ) || "";

                    return (
                        /chat input/i.test(
                            aria
                        ) ||
                        /chat with/i.test(
                            placeholder
                        )
                    );
                }
            ) ||
            null
        );
    }

    function sendChatMessage(
        message
    ) {
        const queuedSend =
            chatSendQueue.then(
                () => sendChatMessageNow(message)
            ).catch(
                error => {
                    console.warn(
                        "[Chest Helper] Chat send failed:",
                        error
                    );

                    setAction(
                        "YouNow chat API request failed"
                    );

                    return false;
                }
            );

        /* Keep later messages moving even if one send fails unexpectedly. */
        chatSendQueue = queuedSend;

        return queuedSend;
    }

    async function sendChatMessageNow(
        message
    ) {
        const chatMessage =
            String(message || "").trim();

        if (!chatMessage) {
            setAction("Chat message is empty — not sent");
            return false;
        }

        if (!updateBroadcastSafety()) {
            setAction("Chat blocked — END button not found");
            return false;
        }

        const context =
            getChestApiContext();

        const apiUserId =
            Number(context?.userId);

        const apiChannelId =
            Number(context?.channelId);

        if (
            !context ||
            !Number.isSafeInteger(apiUserId) ||
            apiUserId <= 0 ||
            !Number.isSafeInteger(apiChannelId) ||
            apiChannelId <= 0
        ) {
            setAction(
                "YouNow chat IDs are unavailable — message not sent"
            );
            return false;
        }

        const trpxDeviceId =
            getStoredYouNowValue("TRPX_DEVICE_ID");

        if (!trpxDeviceId) {
            setAction(
                "YouNow device ID is unavailable — message not sent"
            );
            return false;
        }

        const pageFetch =
            pageWindow.fetch;

        if (typeof pageFetch !== "function") {
            setAction(
                "Browser fetch is unavailable — chat message not sent"
            );
            return false;
        }

        const language =
            getStoredYouNowValue("UI_LANGUAGE") ||
            String(document.documentElement.lang || "en");

        const formData =
            new URLSearchParams();

        formData.set(
            "userId",
            String(apiUserId)
        );

        formData.set(
            "channelId",
            String(apiChannelId)
        );

        formData.set(
            "comment",
            chatMessage
        );

        formData.set(
            "tdi",
            trpxDeviceId
        );

        formData.set(
            "lang",
            language
        );

        const headers = {
            "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8"
        };

        const requestBy =
            getStoredYouNowValue("REQUEST_BY");

        if (requestBy) {
            headers["X-Requested-By"] =
                requestBy;
        }

        const requestPageUrl =
            String(pageWindow.location.href || "");

        try {
            if (!updateBroadcastSafety()) {
                setAction("Chat blocked — END button not found");
                return false;
            }

            const response =
                await pageFetch.call(
                    pageWindow,
                    CHAT_API_URL,
                    {
                        method: "POST",
                        credentials: "include",
                        cache: "no-store",
                        headers,
                        body: formData.toString()
                    }
                );

            if (!response.ok) {
                setAction(
                    "YouNow chat API failed (HTTP " +
                    response.status +
                    ")"
                );
                return false;
            }

            if (
                String(pageWindow.location.href || "") !==
                requestPageUrl
            ) {
                setAction(
                    "Chat request completed after the page changed"
                );
                return false;
            }

            setAction(
                "Chat POST returned HTTP " +
                response.status
            );

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Chat failed:",
                error
            );

            setAction("YouNow chat API request failed");
            return false;
        }
    }

    async function waitForChatMessageVisible(
        message,
        timeoutMs = 5000
    ) {
        const expected =
            normalizeText(message);

        const deadline =
            Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
            if (
                normalizeText(
                    document.body?.innerText || ""
                ).includes(expected)
            ) {
                return true;
            }

            await sleep(250);
        }

        return false;
    }

    async function sendTestChatMessage() {
        if (testChatSendInProgress) {
            return;
        }

        const button =
            helperPanel?.querySelector(
                '[data-action="test-chat"]'
            );

        if (!button) {
            return;
        }

        testChatSendInProgress = true;
        button.disabled = true;

        try {
            const timestamp =
                new Date().toLocaleTimeString(
                    [],
                    {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit"
                    }
                );

            const message =
                "Chest Helper test message " +
                timestamp;

            setAction(
                "Sending one test chat message"
            );

            const sent =
                await sendChatMessage(message);

            if (!sent) {
                return;
            }

            const visible =
                await waitForChatMessageVisible(
                    message
                );

            setAction(
                visible
                    ? "Test message is visible in this chat"
                    : "Chat POST returned HTTP 200; message is not visible here yet"
            );
        } catch (error) {
            console.warn(
                "[Chest Helper] Test chat failed:",
                error
            );

            setAction("Test chat message failed");
        } finally {
            button.disabled = false;
            testChatSendInProgress = false;
        }
    }

    /*
     * ============================================================
     * CHAT VARIABLES
     * ============================================================
     *
     * {likes}
     *     = actual likes from the most recent successful chest
     *       panel check.
     *
     * {threshold}
     *     = the target configured by the user.
     *
     * {lockedLikes}
     *     = likes value locked when threshold was reached.
     *
     * {delay}
     *     = configured opening delay.
     *
     * {cycle}
     *     = current cycle number.
     *
     * {remaining}
     *     = current timer remaining.
     * ============================================================
     */

    function getCurrentChestThreshold() {
        return settings.threshold;
    }

    function replaceVariables(
        message
    ) {

        /*
         * IMPORTANT:
         *
         * {likes} deliberately uses lastCheckedLikes.
         *
         * It does NOT use threshold.
         * It does NOT use the configured target.
         * It does NOT scan the page.
         */
        const likes =
            lastCheckedLikes !==
                null
                ? lastCheckedLikes
                : currentLikes;

        const remaining =
            remainingSeconds(
                openingTimerEnd
            ) ??
            remainingSeconds(
                chestTimerEnd
            ) ??
            0;

        return String(
            message || ""
        )
            .replace(
                /\{likes\}/gi,
                formatLikes(
                    likes
                )
            )
            .replace(
                /\{threshold\}/gi,
                formatLikes(
                    getCurrentChestThreshold()
                )
            )
            .replace(
                /\{lockedLikes\}/gi,
                formatLikes(
                    lockedLikes
                )
            )
            .replace(
                /\{delay\}/gi,
                String(
                    settings.openingDelaySeconds
                )
            )
            .replace(
                /\{cycle\}/gi,
                String(cycle)
            )
            .replace(
                /\{remaining\}/gi,
                String(remaining)
            );
    }

    async function sendOpeningAnnouncement() {
        if (!settings.openingChatEnabled) {
            return false;
        }

        const snapshot =
            getFreshChestApiSnapshot();

        const context =
            getChestApiContext();

        if (
            !snapshot?.chestId ||
            !context?.channelId
        ) {
            setAction(
                "Opening announcement not sent — chest ID is unavailable"
            );
            return false;
        }

        const announcementKey =
            `${context.channelId}:${snapshot.chestId}`;

        if (!claimOpeningAnnouncement(announcementKey)) {
            return false;
        }

        const message =
            replaceVariables(
                settings.openingChatMessage
            );

        return await sendChatMessage(
            message
        );
    }

    function claimOpeningAnnouncement(key) {
        let registry;

        try {
            registry =
                pageWindow[
                    OPENING_ANNOUNCEMENT_REGISTRY_KEY
                ];

            if (!Array.isArray(registry)) {
                registry = [];
                pageWindow[
                    OPENING_ANNOUNCEMENT_REGISTRY_KEY
                ] = registry;
            }
        } catch (_) {
            registry =
                localOpeningAnnouncementKeys;
        }

        if (!Array.isArray(registry)) {
            registry =
                localOpeningAnnouncementKeys;
        }

        if (registry.includes(key)) {
            return false;
        }

        registry.push(key);

        if (
            registry.length >
            MAX_ACTION_LOG_ENTRIES
        ) {
            registry.splice(
                0,
                registry.length - MAX_ACTION_LOG_ENTRIES
            );
        }

        localOpeningAnnouncementKeys =
            registry;

        return true;
    }

    /*
     * ============================================================
     * AUTO INFO
     * ============================================================
     *
     * This timer is completely independent of the chest-opening
     * cycle.
     * ============================================================
     */

    function scheduleAutoInfo() {
        if (
            !settings.autoInfoEnabled ||
            !ownBroadcastActive ||
            !detectOwnBroadcasting()
        ) {
            autoInfoNextAt =
                null;

            return;
        }

        autoInfoNextAt =
            Date.now() +
            settings.autoInfoMinutes *
                60 *
                1000;
    }

    function processAutoInfo() {
        if (!updateBroadcastSafety()) {
            return;
        }

        if (
            !settings.autoInfoEnabled
        ) {
            return;
        }

        if (!autoInfoNextAt) {
            scheduleAutoInfo();

            return;
        }

        if (
            Date.now() <
            autoInfoNextAt
        ) {
            return;
        }

        const message =
            replaceVariables(
                settings.autoInfoMessage
            );

        void sendChatMessage(
            message
        );

        if (ownBroadcastActive) {
            scheduleAutoInfo();
        } else {
            autoInfoNextAt = null;
        }
    }

    /*
     * ============================================================
     * TIMERS
     * ============================================================
     */

    function startRecheckTimer() {
        if (!settings.timerEnabled) {
            chestTimerEnd = null;
            return;
        }

        chestTimerEnd =
            Date.now() +
            settings.recheckSeconds *
                1000;

        setAction(
            `Recheck timer started: ${settings.recheckSeconds}s`
        );
    }

    function startImmediateRecheck() {
        /* Timer OFF is intentionally a real OFF state, not a 0/1-second timer. */
        if (!settings.timerEnabled) {
            chestTimerEnd = null;
            return;
        }

        chestTimerEnd = Date.now();
        setAction("Immediate chest recheck started");
    }

    function startOpenDelay() {
        openingTimerEnd =
            Date.now() +
            settings.openingDelaySeconds *
                1000;

        setAction(
            `Opening delay started: ${settings.openingDelaySeconds}s`
        );
    }

    /*
     * ============================================================
     * BEGIN FRESH CHEST CYCLE
     * ============================================================
     */

    function beginFreshCycle() {
        /*
         * This is a likes-check/opening cycle, not a completed chest
         * cycle. The completed cycle number advances only after the
         * full opening and cleanup sequence succeeds.
         *
         * Start each chest with a clean last-check value.
         */
        lastCheckedLikes =
            null;

        currentLikes =
            null;

        lockedLikes =
            null;

        likesLockedForCycle =
            false;

        cycleLocked =
            true;

        checkCycleInProgress =
            true;

        likesReadThisCheck =
            false;

        likesCheckDeadline =
            null;

        openedChestRecordedForCycle =
            false;

        chestOpenConfirmedForCycle =
            false;

        soundPlayedForCycle =
            false;

        preOpenVerification = false;

        chestTimerEnd =
            null;

        openingTimerEnd =
            null;

        winnerCloseAttempts =
            0;

        recoveryStartedAt =
            Date.now();

        setAction(
            `Fresh chest cycle ${cycle} started`
        );

        setState(
            STATES.OPENING_PANEL
        );
    }

    /*
     * ============================================================
     * LOCK LIKES
     * ============================================================
     */

    function lockLikes(
        likes
    ) {
        if (
            likesLockedForCycle
        ) {
            return;
        }

        /*
         * Preserve the actual last checked number.
         */
        lastCheckedLikes =
            likes;

        currentLikes =
            likes;

        lockedLikes =
            likes;

        likesLockedForCycle =
            true;

        cycleLocked =
            true;

        setAction(
            `Locked ${formatLikes(likes)} likes for cycle ${cycle}`
        );
    }

    /*
     * ============================================================
     * STATE MACHINE
     * ============================================================
     */

    async function processState() {

        if (!updateBroadcastSafety()) {
            return;
        }

        void refreshChestApiSnapshot();

        if (
            !settings.enabled
        ) {
            state =
                STATES.OFF;

            return;
        }

        /*
         * Independent Auto Info.
         */
        processAutoInfo();

        switch (state) {

            case STATES.WAITING_FOR_CHEST:

                {
                    const chestState = getChestState();
                    const apiSnapshot =
                        getFreshChestApiSnapshot();
                    const apiChestState =
                        getChestApiState(apiSnapshot);
                    const attemptedChestId =
                        chestApiOpenAttemptedId;

                    if (
                        chestApiOpenAttemptedId &&
                        apiSnapshot &&
                        (
                            apiSnapshot.chestId !==
                                chestApiOpenAttemptedId ||
                            apiChestState === "UNAVAILABLE"
                        )
                    ) {
                        chestApiOpenAttemptedId = "";

                        if (
                            apiSnapshot.chestId &&
                            apiSnapshot.chestId !==
                                attemptedChestId
                        ) {
                            offModeCheckedForAvailableChest = false;
                            lastObservedChestState = "UNAVAILABLE";
                        }
                    }

                    if (
                        chestApiOpenAttemptedId &&
                        apiSnapshot &&
                        apiSnapshot.chestId ===
                            chestApiOpenAttemptedId
                    ) {
                        lastObservedChestState =
                            chestState;
                        return;
                    }

                    /* Preserve existing behavior when the recheck timer is ON. */
                    if (settings.timerEnabled) {
                        if (chestState !== "UNKNOWN" && !cycleLocked) {
                            beginFreshCycle();
                        }
                        lastObservedChestState = chestState;
                        return;
                    }

                    /* Timer OFF: one check only when the chest becomes AVAILABLE. */
                    if (chestState === "UNAVAILABLE") {
                        offModeCheckedForAvailableChest = false;
                    }

                    const becameAvailable =
                        chestState === "AVAILABLE" &&
                        lastObservedChestState !== "AVAILABLE";

                    if (
                        chestState === "AVAILABLE" &&
                        !offModeCheckedForAvailableChest &&
                        (becameAvailable || lastObservedChestState === "UNKNOWN") &&
                        !cycleLocked
                    ) {
                        offModeCheckedForAvailableChest = true;
                        beginFreshCycle();
                    }

                    lastObservedChestState = chestState;
                }

                return;

            case STATES.OPENING_PANEL:

                /*
                 * This state is entered ONLY when the scheduled check
                 * timer expires. Do not run this continuously.
                 */
                if (!checkCycleInProgress) {
                    return;
                }

                const apiSnapshot =
                    getFreshChestApiSnapshot();

                if (
                    apiSnapshot &&
                    apiSnapshot.hasChest &&
                    apiSnapshot.likes !== null
                ) {
                    setAction(
                        "Checking live chest likes through the API"
                    );

                    likesCheckDeadline =
                        Date.now() +
                        LIVE_LIKES_CHECK_WINDOW_MS;

                    setState(
                        STATES.READING_LIKES
                    );

                    return;
                }

                setAction(
                    "Waiting for a fresh chest API reading"
                );

                return;

            case STATES.READING_LIKES:
                {
                    if (
                        likesLockedForCycle
                    ) {
                        return;
                    }

                    const likes =
                        getChestLikes();

                    if (
                        likes === null
                    ) {
                        setAction(
                            "Waiting for live chest likes"
                        );

                        return;
                    }

                    /*
                     * getChestLikes() has already updated:
                     *
                     * lastCheckedLikes
                     * currentLikes
                     *
                     * using the actual chest-panel value.
                     */
                    likesReadThisCheck =
                        true;

                    const effectiveThreshold =
                        getCurrentChestThreshold();

                    if (
                        likes < effectiveThreshold
                    ) {
                        /*
                         * Keep the actual chest panel open briefly while
                         * likes are arriving. YouNow updates .total-likes
                         * live, so the next 500 ms poll can catch the
                         * threshold being reached during this same check.
                         *
                         * This is NOT the recheck timer: once this bounded
                         * window expires, the panel closes and the normal
                         * timer/AVAILABLE-transition rules take over.
                         */
                        if (!likesCheckDeadline) {
                            likesCheckDeadline =
                                Date.now() +
                                LIVE_LIKES_CHECK_WINDOW_MS;
                        }

                        const remaining =
                            Math.max(
                                0,
                                likesCheckDeadline -
                                Date.now()
                            );

                        if (remaining > 0 && isChestAvailable()) {
                            setAction(
                                `Watching live chest likes: ${formatLikes(likes)} / ${formatLikes(effectiveThreshold)} — ${Math.ceil(remaining / 1000)}s left`
                            );

                            return;
                        }

                        likesCheckDeadline =
                            null;

                        setAction(
                            `Chest likes ${formatLikes(likes)} / ${formatLikes(effectiveThreshold)} — check complete`
                        );

                        setState(
                            STATES.CLOSING_BELOW_TARGET
                        );

                        return;
                    }

                    /*
                     * The threshold may be reached while the chest is
                     * still unavailable.  Record the real likes value,
                     * close the panel, and wait for the next recheck.
                     * Do not lock the cycle or send an opening message
                     * until the chest itself is AVAILABLE.
                     */
                    if (!isChestAvailable()) {
                        setAction(
                            `Chest likes ${formatLikes(likes)} reached target, but chest is UNAVAILABLE — waiting for next check`
                        );

                        if (!likesReadThisCheck) {
                            return;
                        }

                        const closed =
                            await closeChestPanel();

                        if (!closed) {
                            return;
                        }

                        likesCheckDeadline =
                            null;

                        checkCycleInProgress =
                            false;

                        cycleLocked =
                            false;

                        likesLockedForCycle =
                            false;

                        lockedLikes =
                            null;

                        if (settings.timerEnabled) {
                            startRecheckTimer();
                            setState(STATES.WAITING_FOR_RECHECK);
                        } else {
                            chestTimerEnd = null;
                            preOpenVerification = false;
                            setState(STATES.WAITING_FOR_CHEST);
                        }

                        return;
                    }

                    likesCheckDeadline =
                        null;

                    /* Final verification: do not restart the delay or announcement. */
                    if (preOpenVerification) {
                        lockLikes(likes);
                        const finalClosed = await closeChestPanel();
                        if (!finalClosed) {
                            setAction("Final likes check passed, but chest panel could not close yet — retrying");
                            return;
                        }
                        preOpenVerification = false;
                        checkCycleInProgress = false;
                        setAction(`Final likes check passed: ${formatLikes(likes)} — opening now`);
                        setState(STATES.OPENING_VIA_API);
                        return;
                    }

                    /*
                     * Threshold reached while the chest is AVAILABLE.
                     */
                    lockLikes(
                        likes
                    );

                    /*
                     * Opening announcement uses lastCheckedLikes.
                     */
                    if (settings.openingChatEnabled) {
                        await sendOpeningAnnouncement();
                    }

                    /*
                     * Close using the chest panel close control (Got it/Cancel).
                     */
                    const closed =
                        await closeChestPanel();

                    if (!closed) {
                        setAction(
                            "Chest panel could not be closed yet — retrying"
                        );

                        return;
                    }

                    startOpenDelay();

                    setState(
                        STATES.WAITING_FOR_OPEN_DELAY
                    );

                    return;
                }

            case STATES.CLOSING_BELOW_TARGET:
                {
                    if (
                        isChestCheckPanelOpen()
                    ) {
                        const closed =
                            await closeChestPanel();

                        if (!closed) {
                            return;
                        }
                    }

                    checkCycleInProgress =
                        false;

                    likesReadThisCheck =
                        false;

                    likesCheckDeadline =
                        null;

                    cycleLocked =
                        false;

                    preOpenVerification = false;

                    likesLockedForCycle =
                        false;

                    lockedLikes =
                        null;

                    /*
                     * Keep lastCheckedLikes so {likes} continues to
                     * represent the last actual chest check until
                     * the next fresh cycle starts.
                     */

                    if (settings.timerEnabled) {
                        startRecheckTimer();
                        setState(STATES.WAITING_FOR_RECHECK);
                    } else {
                        /* No timer: wait for the next AVAILABLE transition. */
                        chestTimerEnd = null;
                        setState(STATES.WAITING_FOR_CHEST);
                    }

                    return;
                }

            case STATES.WAITING_FOR_RECHECK:

                /*
                 * NEVER close/open the chest panel here. The panel is
                 * handled only by the active timer-driven check cycle.
                 */
                if (
                    checkCycleInProgress
                ) {
                    return;
                }

                if (
                    chestTimerEnd &&
                    Date.now() >=
                        chestTimerEnd
                ) {
                    if (getChestState() === "UNKNOWN") {
                        if (lastAction !== "Chest state UNKNOWN — recheck is waiting") {
                            setAction("Chest state UNKNOWN — recheck is waiting");
                        }
                        return;
                    }

                    chestTimerEnd =
                        null;

                    /*
                     * New cycle begins with a clean lastCheckedLikes.
                     */
                    lastCheckedLikes =
                        null;

                    currentLikes =
                        null;

                    lockedLikes =
                        null;

                    likesLockedForCycle =
                        false;

                    cycleLocked =
                        true;

                    checkCycleInProgress =
                        true;

                    likesReadThisCheck =
                        false;

                    setAction(
                        "Recheck timer expired — checking chest again"
                    );

                    setState(
                        STATES.OPENING_PANEL
                    );
                }

                return;

            case STATES.WAITING_FOR_OPEN_DELAY:

                if (
                    isChestModalOpen()
                ) {
                    await closeTreasureChestModal();

                    return;
                }

                if (
                    openingTimerEnd &&
                    Date.now() >=
                        openingTimerEnd
                ) {
                    if (!canPerformAutomatedAction(true)) {
                        return;
                    }

                    openingTimerEnd = null;

                    /* Timer OFF: one final live likes check immediately before opening. */
                    if (!settings.timerEnabled && !preOpenVerification) {
                        preOpenVerification = true;
                        checkCycleInProgress = true;
                        likesReadThisCheck = false;
                        likesCheckDeadline = null;
                        /* Unlock the previous value so this is a real fresh read. */
                        likesLockedForCycle = false;
                        lockedLikes = null;
                        lastCheckedLikes = null;
                        currentLikes = null;
                        setAction("Opening delay complete — final chest likes check before opening");
                        setState(STATES.OPENING_PANEL);
                        return;
                    }

                    setAction("Opening delay complete");
                    setState(STATES.OPENING_VIA_API);
                }

                return;

            case STATES.OPENING_VIA_API:

                if (
                    isChestModalOpen()
                ) {
                    await closeTreasureChestModal();

                    return;
                }

                if (
                    !cycleLocked ||
                    !likesLockedForCycle
                ) {
                    setState(
                        STATES.WAITING_FOR_CHEST
                    );

                    return;
                }

                if (!updateBroadcastSafety()) {
                    return;
                }

                if (settings.openingChatEnabled) {
                    await sendOpeningAnnouncement();
                }

                /* Never reread likes here. The API snapshot below is the
                 * authority for this direct server-side open. */
                if (
                    !soundPlayedForCycle &&
                    settings.openSoundEnabled
                ) {
                    await playCustomOpenSound();
                    soundPlayedForCycle = true;
                }

                if (chestApiRequestInFlight) {
                    return;
                }

                await refreshChestApiSnapshot(true);

                const openResult =
                    await openChestViaApi();

                if (openResult === "opened") {
                    setState(
                        STATES.WAITING_FOR_RAIN
                    );

                    return;
                }

                cycleLocked = false;
                likesLockedForCycle = false;
                currentLikes = null;
                lockedLikes = null;
                preOpenVerification = false;
                setState(
                    STATES.WAITING_FOR_CHEST
                );

                return;

            case STATES.WAITING_FOR_RAIN:

                if (
                    clickMakeItRain()
                ) {
                    setState(
                        STATES.WAITING_FOR_TELL_THEM
                    );

                    return;
                }

                if (
                    Date.now() -
                        stateStartedAt >
                    15000
                ) {
                    setAction(
                        "Make It Rain timeout — continuing"
                    );

                    setState(
                        STATES.WAITING_FOR_TELL_THEM
                    );
                }

                return;

            case STATES.WAITING_FOR_TELL_THEM:

                if (
                    clickTellThem()
                ) {
                    await sleep(
                        500
                    );

                    setState(
                        STATES.WAITING_FOR_CHEST_RESET
                    );

                    return;
                }

                if (
                    Date.now() -
                        stateStartedAt >
                    8000
                ) {
                    setAction(
                        "Tell Them timeout — waiting for chest reset"
                    );

                    setState(
                        STATES.WAITING_FOR_CHEST_RESET
                    );
                }

                return;

            case STATES.WAITING_FOR_CHEST_RESET: {

                /*
                 * Do not reread likes.
                 */
                const resetState = getChestState();

                if (resetState === "UNKNOWN") {
                    if (chestOpenConfirmedForCycle) {
                        if (lastAction !== "API open confirmed — continuing Winners cleanup despite unknown chest state") {
                            setAction(
                                "API open confirmed — continuing Winners cleanup despite unknown chest state"
                            );
                        }
                        setState(
                            STATES.WAITING_FOR_WINNERS
                        );
                        return;
                    }

                    if (lastAction !== "Chest state UNKNOWN — waiting for reset detection") {
                        setAction("Chest state UNKNOWN — waiting for reset detection");
                    }
                    return;
                }

                if (
                    resetState === "UNAVAILABLE"
                ) {
                    setAction(
                        "Chest reset detected"
                    );

                    setState(
                        STATES.WAITING_FOR_WINNERS
                    );

                    return;
                }

                if (
                    findWinnersPanel()
                ) {
                    setState(
                        STATES.CLOSING_WINNERS
                    );

                    return;
                }

                if (
                    Date.now() -
                        stateStartedAt >
                    15000
                ) {
                    setAction(
                        "Chest reset timeout — checking Winners"
                    );

                    setState(
                        STATES.WAITING_FOR_WINNERS
                    );
                }

                return;
            }

            case STATES.WAITING_FOR_WINNERS:
                {
                    if (
                        getChestState() === "UNKNOWN" &&
                        !chestOpenConfirmedForCycle
                    ) {
                        if (lastAction !== "Chest state UNKNOWN — waiting for Winners cleanup") {
                            setAction("Chest state UNKNOWN — waiting for Winners cleanup");
                        }
                        return;
                    }

                    const winners =
                        findWinnersPanel();

                    if (winners) {
                        winnerCloseAttempts =
                            0;

                        setState(
                            STATES.CLOSING_WINNERS
                        );

                        return;
                    }

                    if (
                        Date.now() -
                            stateStartedAt >
                        12000
                    ) {
                        setAction(
                            "No Winners panel detected — cleanup"
                        );

                        setState(
                            STATES.CLEANUP
                        );
                    }

                    return;
                }

            case STATES.CLOSING_WINNERS:

                if (
                    await closeWinnersPanel()
                ) {
                    setState(
                        STATES.CLEANUP
                    );
                }

                return;

            case STATES.CLEANUP:

                if (
                    getChestState() === "UNKNOWN" &&
                    !chestOpenConfirmedForCycle
                ) {
                    if (lastAction !== "Chest state UNKNOWN — waiting for cleanup") {
                        setAction("Chest state UNKNOWN — waiting for cleanup");
                    }
                    return;
                }

                if (
                    isChestModalOpen()
                ) {
                    const closed =
                        await closeTreasureChestModal();

                    if (!closed) {
                        return;
                    }
                }

                if (
                    findWinnersPanel()
                ) {
                    const closed =
                        await closeWinnersPanel();

                    if (!closed) {
                        return;
                    }
                }

                /*
                 * At this point the chest panel and Winners panel are
                 * both confirmed closed, so this is a completed chest.
                 * Record it once, before clearing the cycle values.
                 */
                completeChestCycle();
                addOpenedChestLog();
                renderChestLog();

                openedChestRecordedForCycle =
                    false;

                currentLikes =
                    null;

                lockedLikes =
                    null;

                likesLockedForCycle =
                    false;

                cycleLocked =
                    false;

                preOpenVerification = false;

                chestTimerEnd =
                    null;

                openingTimerEnd =
                    null;

                winnerCloseAttempts =
                    0;

                /*
                 * Preserve lastCheckedLikes until the next fresh
                 * cycle. This makes it possible to see the last
                 * actual chest value in the helper/footer.
                 */

                recoveryStartedAt =
                    Date.now();

                /*
                 * Recheck Timer OFF: after a chest has finished opening,
                 * immediately establish the next chest availability check.
                 *
                 * If YouNow has already reset the chest and it is AVAILABLE
                 * right now, seed the OFF-mode edge detector as if the chest
                 * had just been UNAVAILABLE. The next 500 ms poll will then
                 * perform exactly one fresh likes check.
                 *
                 * If it is still UNAVAILABLE, leave the detector at
                 * UNAVAILABLE so the next real AVAILABLE transition will
                 * trigger the next check. No timer is created.
                 */
                const postOpenChestState =
                    getChestState();

                if (!settings.timerEnabled) {
                    chestTimerEnd = null;
                    offModeCheckedForAvailableChest = false;

                    if (postOpenChestState === "AVAILABLE") {
                        lastObservedChestState = "UNAVAILABLE";
                        setAction(
                            `Cycle ${cycle} complete — chest already AVAILABLE; checking again now`
                        );
                    } else {
                        lastObservedChestState =
                            postOpenChestState === "UNAVAILABLE"
                                ? "UNAVAILABLE"
                                : "UNKNOWN";

                        setAction(
                            `Cycle ${cycle} complete — waiting for chest to become AVAILABLE`
                        );
                    }
                } else {
                    setAction(
                        `Cycle ${cycle} complete — waiting for next chest`
                    );
                }

                setState(
                    STATES.WAITING_FOR_CHEST
                );

                return;

            case STATES.OFF:
            default:
                return;
        }
    }

    /*
     * ============================================================
     * RECOVERY
     * ============================================================
     */

    function recovery() {

        if (
            !settings.enabled
        ) {
            return;
        }

        if (
            state ===
                STATES.READING_LIKES ||
            state ===
                STATES.CLOSING_BELOW_TARGET ||
            state ===
                STATES.OPENING_VIA_API ||
            state ===
                STATES.WAITING_FOR_RAIN ||
            state ===
                STATES.WAITING_FOR_TELL_THEM
        ) {
            return;
        }

        /*
         * The Open/Cancel Treasure Chest modal is separate from the
         * sidebar check panel. Only Cancel is used here.
         */
        if (
            isChestModalOpen() &&
            (
                state ===
                    STATES.WAITING_FOR_OPEN_DELAY ||
                state ===
                    STATES.CLEANUP
            )
        ) {
            closeTreasureChestModal();

            return;
        }

        if (
            Date.now() -
                recoveryStartedAt >
            120000
        ) {
            currentLikes =
                null;

            lockedLikes =
                null;

            likesLockedForCycle =
                false;

            cycleLocked =
                false;

            openedChestRecordedForCycle =
                false;

            chestTimerEnd =
                null;

            openingTimerEnd =
                null;

            winnerCloseAttempts =
                0;

            recoveryStartedAt =
                Date.now();

            setAction(
                "Recovery reset — waiting for next chest"
            );

            setState(
                STATES.WAITING_FOR_CHEST
            );
        }
    }

    /*
     * ============================================================
     * CSS
     * ============================================================
     */

    function installCSS() {
        const css = `
            #younow-chest-helper-v946 {
                position:fixed;
                top:90px;
                right:20px;
                width:400px;
                max-width:calc(100vw - 30px);
                max-height:calc(100vh - 30px);
                z-index:2147483646;
                background:#171717;
                color:#f2f2f2;
                border:1px solid #444;
                border-radius:10px;
                box-shadow:0 8px 30px rgba(0,0,0,.45);
                font-family:Arial,Helvetica,sans-serif;
                font-size:13px;
                overflow:hidden;
            }

            #younow-chest-helper-v946 .ych-header {
                display:flex;
                align-items:center;
                justify-content:space-between;
                padding:9px 10px;
                background:#222;
                border-bottom:1px solid #444;
                cursor:move;
                user-select:none;
            }

            #younow-chest-helper-v946 .ych-title {
                display:flex;
                align-items:center;
                gap:7px;
                font-weight:700;
            }

            #younow-chest-helper-v946 .ych-version {
                color:#999;
                font-size:11px;
                font-weight:400;
            }

            #younow-chest-helper-v946 .ych-header-buttons {
                display:flex;
                gap:4px;
            }

            #younow-chest-helper-v946 .ych-head-btn {
                width:27px;
                height:25px;
                border:1px solid #555;
                border-radius:5px;
                background:#333;
                color:#fff;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-body {
                padding:10px;
                overflow-y:auto;
                max-height:calc(100vh - 110px);
            }

            #younow-chest-helper-v946.ych-minimized .ych-body {
                display:none;
            }

            #younow-chest-helper-v946.ych-maximized {
                width:min(540px,calc(100vw - 20px));
                max-width:calc(100vw - 20px);
                max-height:calc(100vh - 20px);
                top:10px;
                right:10px;
            }

            #younow-chest-helper-v946.ych-maximized .ych-body {
                max-height:calc(100vh - 75px);
            }

            #younow-chest-helper-v946 .ych-section {
                margin-bottom:10px;
                padding:9px;
                background:#202020;
                border:1px solid #363636;
                border-radius:7px;
            }

            #younow-chest-helper-v946 .ych-section-title {
                margin-bottom:7px;
                color:#aaa;
                font-size:11px;
                font-weight:700;
                text-transform:uppercase;
                letter-spacing:.5px;
            }

            #younow-chest-helper-v946 .ych-row {
                display:grid;
                grid-template-columns:42% 58%;
                gap:5px;
                padding:3px 0;
                align-items:start;
            }

            #younow-chest-helper-v946 .ych-row span {
                color:#aaa;
            }

            #younow-chest-helper-v946 .ych-row strong {
                min-width:0;
                overflow-wrap:anywhere;
                color:#fff;
            }

            #younow-chest-helper-v946 .ych-field {
                display:block;
                margin-bottom:8px;
                color:#ccc;
                font-size:12px;
            }

            #younow-chest-helper-v946 input[type="number"],
            #younow-chest-helper-v946 textarea {
                box-sizing:border-box;
                width:100%;
                margin-top:4px;
                padding:6px;
                background:#111;
                color:#fff;
                border:1px solid #555;
                border-radius:5px;
                font-family:inherit;
                font-size:12px;
            }

            #younow-chest-helper-v946 textarea {
                resize:vertical;
            }

            #younow-chest-helper-v946 .ych-check {
                display:flex;
                gap:7px;
                align-items:center;
                margin:7px 0;
                color:#ccc;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-check input {
                margin:0;
            }

            #younow-chest-helper-v946 .ych-buttons {
                display:grid;
                grid-template-columns:90px 1fr;
                gap:7px;
                margin-bottom:10px;
            }

            #younow-chest-helper-v946 .ych-buttons button {
                min-height:34px;
                border:1px solid #555;
                border-radius:6px;
                background:#333;
                color:#fff;
                font-weight:700;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-off {
                background:#4b2222 !important;
            }

            /*
             * Restored footer.
             */
            #younow-chest-helper-v946 .ych-footer {
                padding:8px 10px;
                background:#151515;
                border-top:1px solid #3b3b3b;
                color:#888;
                font-size:10px;
                line-height:1.5;
                text-align:center;
            }

            #younow-chest-helper-v946 .ych-footer strong {
                color:#aaa;
            }

            #younow-chest-helper-v946 .ych-sound-section {
                margin-top:10px;
                padding-top:10px;
                border-top:1px solid rgba(255,255,255,0.08);
            }

            #younow-chest-helper-v946 .ych-sound-name {
                margin-top:6px;
                font-size:12px;
                opacity:0.85;
                overflow:hidden;
                text-overflow:ellipsis;
                white-space:nowrap;
            }

            #younow-chest-helper-v946 .ych-sound-buttons {
                display:flex;
                flex-wrap:wrap;
                gap:6px;
                margin-top:7px;
            }

            #younow-chest-helper-v946 .ych-chat-test {
                margin:8px 0 10px;
            }

            #younow-chest-helper-v946 .ych-chat-test-button {
                width:100%;
                min-height:32px;
                padding:6px 8px;
                border:1px solid #555;
                border-radius:6px;
                background:#333;
                color:#fff;
                font-weight:700;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-chat-test-button:disabled {
                opacity:.6;
                cursor:wait;
            }

            #younow-chest-helper-v946 .ych-chat-test-note {
                margin-top:5px;
                color:#999;
                font-size:11px;
                line-height:1.4;
            }

            #younow-chest-helper-v946 .ych-action-log-wrap {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:8px;
                margin-bottom:7px;
            }

            #younow-chest-helper-v946 .ych-action-log-count {
                color:#888;
                font-size:10px;
            }

            #younow-chest-helper-v946 .ych-action-log-clear {
                min-height:25px;
                padding:3px 8px;
                border:1px solid #555;
                border-radius:5px;
                background:#333;
                color:#fff;
                font-size:11px;
                font-weight:700;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-action-log-note {
                margin:-1px 0 7px;
                color:#888;
                font-size:10px;
                line-height:1.4;
            }

            #younow-chest-helper-v946 .ych-action-log {
                max-height:220px;
                overflow-y:auto;
                padding-right:4px;
                border:1px solid #333;
                border-radius:5px;
                background:#111;
            }

            #younow-chest-helper-v946 .ych-action-log-entry {
                padding:7px;
                border-bottom:1px solid #2f2f2f;
            }

            #younow-chest-helper-v946 .ych-action-log-entry:last-child {
                border-bottom:0;
            }

            #younow-chest-helper-v946 .ych-action-log-top {
                display:flex;
                justify-content:space-between;
                gap:8px;
            }

            #younow-chest-helper-v946 .ych-action-log-type {
                color:#8fd18f;
                font-size:10px;
                font-weight:700;
            }

            #younow-chest-helper-v946 .ych-action-log-top time {
                color:#777;
                font-size:10px;
                text-align:right;
            }

            #younow-chest-helper-v946 .ych-action-log-message {
                margin-top:4px;
                color:#ddd;
                font-size:11px;
                line-height:1.4;
                overflow-wrap:anywhere;
            }

            #younow-chest-helper-v946 .ych-action-log-empty {
                padding:12px 8px;
                color:#777;
                text-align:center;
                font-size:11px;
            }

            #younow-chest-helper-v946 .ych-log-wrap {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:8px;
                margin-bottom:7px;
            }

            #younow-chest-helper-v946 .ych-log-count {
                color:#888;
                font-size:10px;
            }

            #younow-chest-helper-v946 .ych-log-reset {
                min-height:25px;
                padding:3px 8px;
                border:1px solid #555;
                border-radius:5px;
                background:#333;
                color:#fff;
                font-size:11px;
                font-weight:700;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-log {
                max-height:220px;
                overflow-y:auto;
                padding-right:4px;
                border:1px solid #333;
                border-radius:5px;
                background:#111;
            }

            #younow-chest-helper-v946 .ych-log-entry {
                padding:7px;
                border-bottom:1px solid #2f2f2f;
            }

            #younow-chest-helper-v946 .ych-log-entry:last-child {
                border-bottom:0;
            }

            #younow-chest-helper-v946 .ych-log-top {
                display:flex;
                justify-content:space-between;
                gap:8px;
                color:#ddd;
            }

            #younow-chest-helper-v946 .ych-log-top span {
                color:#8fd18f;
                font-size:10px;
                font-weight:700;
            }

            #younow-chest-helper-v946 .ych-log-time {
                margin-top:2px;
                color:#777;
                font-size:10px;
            }

            #younow-chest-helper-v946 .ych-log-details {
                display:flex;
                flex-wrap:wrap;
                gap:5px 10px;
                margin-top:4px;
                color:#999;
                font-size:10px;
            }

            #younow-chest-helper-v946 .ych-log-details b {
                color:#ddd;
            }

            #younow-chest-helper-v946 .ych-log-empty {
                padding:12px 8px;
                color:#777;
                text-align:center;
                font-size:11px;
            }

            #younow-chest-helper-v946 .ych-help {
                padding:7px;
                background:#111;
                border-radius:5px;
                color:#999;
                font-size:10px;
                line-height:1.5;
            }
        `;

        try {
            GM_addStyle(css);
        } catch (_) {
            const style =
                document.createElement(
                    "style"
                );

            style.textContent =
                css;

            document.head.appendChild(
                style
            );
        }
    }

    /*
     * ============================================================
     * CREATE HELPER PANEL
     * ============================================================
     */

    function createHelperPanel() {

        if (
            document.getElementById(
                "younow-chest-helper-v946"
            )
        ) {
            helperPanel =
                document.getElementById(
                    "younow-chest-helper-v946"
                );

            return;
        }

        helperPanel =
            document.createElement(
                "div"
            );

        helperPanel.id =
            "younow-chest-helper-v946";

        helperPanel.innerHTML = `
            <div class="ych-header">

                <div class="ych-title">
                    <span>YouNow Auto Chest Helper</span>
                    <span class="ych-version">
                        v${VERSION}
                    </span>
                </div>

                <div class="ych-header-buttons">

                    <button
                        type="button"
                        class="ych-head-btn"
                        data-action="minimize"
                    >−</button>

                    <button
                        type="button"
                        class="ych-head-btn"
                        data-action="maximize"
                    >□</button>

                </div>

            </div>

            <div class="ych-body">

                <div class="ych-section">

                    <div class="ych-row">
                        <span>Status</span>
                        <strong data-field="status">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>State</span>
                        <strong data-field="state">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Cycle</span>
                        <strong data-field="cycle">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Last Action</span>
                        <strong data-field="action">—</strong>
                    </div>

                </div>

                <div class="ych-section">

                    <div class="ych-section-title">
                        Chest
                    </div>

                    <div class="ych-row">
                        <span>Chest State</span>
                        <strong data-field="chest">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Last Chest Check</span>
                        <strong data-field="last-check">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Current Likes</span>
                        <strong data-field="likes">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Target</span>
                        <strong data-field="target">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Locked Likes</span>
                        <strong data-field="locked">—</strong>
                    </div>

                </div>

                <div class="ych-section">

                    <div class="ych-section-title">
                        Timers
                    </div>

                    <div class="ych-row">
                        <span>Recheck</span>
                        <strong data-field="recheck">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Opening Delay</span>
                        <strong data-field="opening">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Auto Info</span>
                        <strong data-field="auto-info">—</strong>
                    </div>

                </div>

                <div class="ych-section">

                    <div class="ych-section-title">
                        Variables
                    </div>

                    <label class="ych-field">
                        Target Likes
                        <input
                            type="number"
                            min="500"
                            step="1"
                            data-setting="threshold"
                        >
                    </label>

                    <label class="ych-field">
                        Recheck Seconds
                        <input
                            type="number"
                            min="1"
                            step="1"
                            data-setting="recheckSeconds"
                        >
                    </label>

                    <label class="ych-field">
                        Opening Delay Seconds
                        <input
                            type="number"
                            min="0"
                            step="1"
                            data-setting="openingDelaySeconds"
                        >
                    </label>

                    <label class="ych-field">
                        Auto Info Minutes
                        <input
                            type="number"
                            min="1"
                            step="1"
                            data-setting="autoInfoMinutes"
                        >
                    </label>

                    <label class="ych-field">
                        Opening Chat Message
                        <textarea
                            rows="3"
                            data-setting="openingChatMessage"
                        ></textarea>
                    </label>

                    <div class="ych-chat-test">
                        <button
                            type="button"
                            class="ych-chat-test-button"
                            data-action="test-chat"
                        >SEND TEST CHAT</button>
                        <div class="ych-chat-test-note">
                            Sends one timestamped message and checks whether it appears in your chat feed.
                        </div>
                    </div>

                    <div class="ych-sound-section">
                        <div class="ych-section-title">Chest Open Sound</div>
                        <label class="ych-check">
                            <input type="checkbox" data-setting="openSoundEnabled">
                            Play custom sound just before chest opens
                        </label>
                        <div class="ych-sound-name" data-field="open-sound-name">No sound selected</div>
                        <div class="ych-sound-buttons">
                            <button type="button" data-action="select-open-sound">SELECT SOUND</button>
                            <button type="button" data-action="test-open-sound">TEST SOUND</button>
                            <button type="button" data-action="clear-open-sound">CLEAR</button>
                        </div>
                        <label class="ych-field">
                            Sound Volume
                            <input type="range" min="0" max="100" step="1" data-setting="openSoundVolume">
                            <span data-field="open-sound-volume">80%</span>
                        </label>
                        <input type="file" accept="audio/*" data-action="open-sound-file" style="display:none;">
                    </div>

                    <label class="ych-field">
                        Auto Info Message
                        <textarea
                            rows="3"
                            data-setting="autoInfoMessage"
                        ></textarea>
                    </label>

                    <label class="ych-check">
                        <input
                            type="checkbox"
                            data-setting="timerEnabled"
                        >
                        Chest Recheck Timer ON
                    </label>

                    <label class="ych-check">
                        <input
                            type="checkbox"
                            data-setting="openingChatEnabled"
                        >
                        Opening Chat ON
                    </label>

                    <label class="ych-check">
                        <input
                            type="checkbox"
                            data-setting="autoInfoEnabled"
                        >
                        Auto Chest Information ON
                    </label>

                </div>

                <div class="ych-section">

                    <div class="ych-log-wrap">
                        <div class="ych-section-title" style="margin:0;">
                            Opened Chests
                            <span class="ych-log-count" data-field="chest-log-count">0</span>
                        </div>

                        <button
                            type="button"
                            class="ych-log-reset"
                            data-action="reset-log"
                        >RESET LOG</button>
                    </div>

                    <div
                        class="ych-log"
                        data-field="chest-log"
                    ></div>

                </div>

                <div class="ych-section">

                    <div class="ych-action-log-wrap">
                        <div class="ych-section-title" style="margin:0;">
                            Action Log
                            <span class="ych-action-log-count" data-field="action-log-count">0</span>
                        </div>

                        <button
                            type="button"
                            class="ych-action-log-clear"
                            data-action="clear-action-log"
                        >CLEAR ACTION LOG</button>
                    </div>

                    <div class="ych-action-log-note">
                        Records helper actions and state changes only while enabled. Up to 250 entries are kept.
                    </div>

                    <label class="ych-check ych-action-log-toggle">
                        <input
                            type="checkbox"
                            data-setting="actionLogEnabled"
                        >
                        Enable debug logging
                    </label>

                    <div
                        class="ych-action-log"
                        data-field="action-log"
                    ></div>

                </div>

                <div class="ych-buttons">

                    <button
                        type="button"
                        data-action="toggle"
                    >ON</button>

                    <button
                        type="button"
                        data-action="save"
                    >SAVE SETTINGS</button>

                </div>

                <div class="ych-help">

                    <b>Chat variables</b><br>
                    {likes} = last actual chest likes check<br>
                    {threshold} = configured target<br>
                    {lockedLikes} = likes locked for opening<br>
                    {delay} = opening delay<br>
                    {cycle} = cycle number<br>
                    {remaining} = active timer remaining

                </div>

            </div>

            <div class="ych-footer">
                <strong>Made for Lolitskayyla by Cenastor</strong>
                &nbsp;•&nbsp;
                v${VERSION}
                &nbsp;•&nbsp;
                Last Chest Check:
                <span data-field="footer-likes">—</span>
            </div>
        `;

        document.body.appendChild(
            helperPanel
        );

        applyPanelSettings();

        applyPanelPosition();

        applyPanelState();

        attachPanelEvents();

        renderChestLog();
        renderActionLog();
        updateUI();
    }

    /*
     * ============================================================
     * PANEL SETTINGS
     * ============================================================
     */

    function applyPanelSettings() {
        if (!helperPanel) {
            return;
        }

        helperPanel.querySelectorAll(
            "[data-setting]"
        ).forEach(
            element => {
                const key =
                    element.dataset.setting;

                if (
                    element.type ===
                    "checkbox"
                ) {
                    element.checked =
                        !!settings[key];
                } else if (
                    key === "openSoundVolume"
                ) {
                    element.value =
                        Math.round(
                            clamp(
                                Number(settings[key]),
                                0,
                                1
                            ) * 100
                        );
                } else {
                    element.value =
                        settings[key] ??
                        "";
                }
            }
        );

        const toggle =
            helperPanel.querySelector(
                '[data-action="toggle"]'
            );

        if (toggle) {
            toggle.textContent =
                settings.enabled
                    ? "ON"
                    : "OFF";

            toggle.classList.toggle(
                "ych-off",
                !settings.enabled
            );
        }
    }

    function savePanelSettings() {
        if (!helperPanel) {
            return;
        }

        helperPanel.querySelectorAll(
            "[data-setting]"
        ).forEach(
            element => {
                const key =
                    element.dataset.setting;

                if (
                    element.type ===
                    "checkbox"
                ) {
                    settings[key] =
                        element.checked;
                } else if (
                    key === "openSoundVolume"
                ) {
                    settings[key] =
                        clamp(
                            Number(element.value) / 100,
                            0,
                            1
                        );
                } else {
                    settings[key] =
                        element.value;
                }
            }
        );

        settings.threshold =
            clampThreshold(
                settings.threshold
            );

        settings.recheckSeconds =
            Math.max(
                1,
                parseInt(
                    settings.recheckSeconds,
                    10
                ) || 1
            );

        settings.openingDelaySeconds =
            Math.max(
                0,
                parseInt(
                    settings.openingDelaySeconds,
                    10
                ) || 0
            );

        settings.autoInfoMinutes =
            Math.max(
                1,
                parseInt(
                    settings.autoInfoMinutes,
                    10
                ) || 1
            );

        saveSettings();

        if (!settings.timerEnabled) {
            chestTimerEnd = null;
            /* Switching the timer OFF starts a new AVAILABLE-edge check, not a timer. */
            lastObservedChestState = "UNKNOWN";
            offModeCheckedForAvailableChest = false;
        }

        scheduleAutoInfo();

        setAction(
            "Settings saved"
        );

        applyPanelSettings();
    }

    function toggleEnabled() {
        if (!settings.enabled && !updateBroadcastSafety()) {
            setAction("Cannot turn automation ON — END button not found");
            return;
        }

        settings.enabled =
            !settings.enabled;

        saveSettings();

        if (
            !settings.enabled
        ) {
            state =
                STATES.OFF;

            cycleLocked =
                false;

            likesLockedForCycle =
                false;

            chestTimerEnd =
                null;

            openingTimerEnd =
                null;
            autoInfoNextAt = null;
            preOpenVerification = false;
            offModeCheckedForAvailableChest = false;

            setAction(
                "Helper turned OFF"
            );
        } else {
            currentLikes =
                null;

            lockedLikes =
                null;

            likesLockedForCycle =
                false;

            cycleLocked =
                false;

            openedChestRecordedForCycle =
                false;

            soundPlayedForCycle =
                false;

            state =
                STATES.WAITING_FOR_CHEST;

            recoveryStartedAt =
                Date.now();

            setAction(
                "Helper turned ON"
            );
        }

        applyPanelSettings();
    }

    /*
     * ============================================================
     * PANEL DRAGGING
     * ============================================================
     */

    function clampPosition(
        x,
        y
    ) {
        if (!helperPanel) {
            return {
                x,
                y
            };
        }

        const rect =
            helperPanel.getBoundingClientRect();

        return {
            x: Math.min(
                Math.max(
                    0,
                    x
                ),
                Math.max(
                    0,
                    window.innerWidth -
                        rect.width
                )
            ),

            y: Math.min(
                Math.max(
                    0,
                    y
                ),
                Math.max(
                    0,
                    window.innerHeight -
                        rect.height
                )
            )
        };
    }

    function applyPanelPosition() {
        if (!helperPanel) {
            return;
        }

        if (
            Number.isFinite(
                Number(
                    settings.panelX
                )
            ) &&
            Number.isFinite(
                Number(
                    settings.panelY
                )
            )
        ) {
            const position =
                clampPosition(
                    Number(
                        settings.panelX
                    ),
                    Number(
                        settings.panelY
                    )
                );

            helperPanel.style.left =
                `${position.x}px`;

            helperPanel.style.top =
                `${position.y}px`;

            helperPanel.style.right =
                "auto";
        }
    }

    function beginDrag(
        event
    ) {
        if (
            event.button !== 0 ||
            !helperPanel
        ) {
            return;
        }

        if (
            event.target.closest(
                "button,input,textarea,select"
            )
        ) {
            return;
        }

        const rect =
            helperPanel.getBoundingClientRect();

        dragState.active =
            true;

        dragState.offsetX =
            event.clientX -
            rect.left;

        dragState.offsetY =
            event.clientY -
            rect.top;

        helperPanel.style.left =
            `${rect.left}px`;

        helperPanel.style.top =
            `${rect.top}px`;

        helperPanel.style.right =
            "auto";

        event.preventDefault();
    }

    function dragPanel(
        event
    ) {
        if (
            !dragState.active ||
            !helperPanel
        ) {
            return;
        }

        const position =
            clampPosition(
                event.clientX -
                    dragState.offsetX,

                event.clientY -
                    dragState.offsetY
            );

        helperPanel.style.left =
            `${position.x}px`;

        helperPanel.style.top =
            `${position.y}px`;
    }

    function endDrag() {
        if (
            !dragState.active ||
            !helperPanel
        ) {
            return;
        }

        dragState.active =
            false;

        const rect =
            helperPanel.getBoundingClientRect();

        const position =
            clampPosition(
                rect.left,
                rect.top
            );

        settings.panelX =
            position.x;

        settings.panelY =
            position.y;

        saveSettings();
    }

    function toggleMinimize() {
        settings.minimized =
            !settings.minimized;

        if (
            settings.minimized
        ) {
            settings.maximized =
                false;
        }

        saveSettings();

        applyPanelState();
    }

    function toggleMaximize() {
        settings.maximized =
            !settings.maximized;

        if (
            settings.maximized
        ) {
            settings.minimized =
                false;
        }

        saveSettings();

        applyPanelState();
    }

    function applyPanelState() {
        if (!helperPanel) {
            return;
        }

        helperPanel.classList.toggle(
            "ych-minimized",
            !!settings.minimized
        );

        helperPanel.classList.toggle(
            "ych-maximized",
            !!settings.maximized
        );
    }

    function attachPanelEvents() {
        if (!helperPanel) {
            return;
        }

        helperPanel.querySelector(
            ".ych-header"
        )?.addEventListener(
            "pointerdown",
            beginDrag
        );

        helperPanel.querySelector(
            '[data-action="toggle"]'
        )?.addEventListener(
            "click",
            toggleEnabled
        );

        helperPanel.querySelector(
            '[data-action="save"]'
        )?.addEventListener(
            "click",
            savePanelSettings
        );

        helperPanel.querySelector(
            '[data-action="select-open-sound"]'
        )?.addEventListener(
            "click",
            () => helperPanel.querySelector(
                '[data-action="open-sound-file"]'
            )?.click()
        );

        helperPanel.querySelector(
            '[data-action="open-sound-file"]'
        )?.addEventListener(
            "change",
            handleOpenSoundFile
        );

        helperPanel.querySelector(
            '[data-action="test-open-sound"]'
        )?.addEventListener(
            "click",
            testOpenSound
        );

        helperPanel.querySelector(
            '[data-action="test-chat"]'
        )?.addEventListener(
            "click",
            sendTestChatMessage
        );

        helperPanel.querySelector(
            '[data-action="clear-open-sound"]'
        )?.addEventListener(
            "click",
            clearCustomOpenSound
        );

        helperPanel.querySelector(
            '[data-setting="openSoundVolume"]'
        )?.addEventListener(
            "input",
            event => {
                settings.openSoundVolume =
                    clamp(
                        Number(event.target.value) / 100,
                        0,
                        1
                    );

                if (soundAudio) {
                    soundAudio.volume =
                        settings.openSoundVolume;
                }

                saveSettings();
                updateUI();
            }
        );


        helperPanel.querySelector(
            '[data-action="reset-log"]'
        )?.addEventListener(
            "click",
            () => {
                if (
                    window.confirm(
                        "Reset the opened chest history? This will not change your settings or automation."
                    )
                ) {
                    resetChestLog();
                }
            }
        );

        helperPanel.querySelector(
            '[data-action="clear-action-log"]'
        )?.addEventListener(
            "click",
            clearActionLog
        );

        helperPanel.querySelector(
            '[data-setting="actionLogEnabled"]'
        )?.addEventListener(
            "change",
            event => {
                const enabled =
                    Boolean(event.target.checked);

                if (enabled) {
                    settings.actionLogEnabled = true;
                    saveSettings();
                    setAction("Debug logging enabled");
                } else {
                    if (settings.actionLogEnabled) {
                        setAction("Debug logging paused");
                    }

                    settings.actionLogEnabled = false;
                    saveSettings();
                    updateUI();
                }
            }
        );

        helperPanel.querySelector(
            '[data-action="minimize"]'
        )?.addEventListener(
            "click",
            toggleMinimize
        );

        helperPanel.querySelector(
            '[data-action="maximize"]'
        )?.addEventListener(
            "click",
            toggleMaximize
        );

        document.addEventListener(
            "pointermove",
            dragPanel
        );

        document.addEventListener(
            "pointerup",
            endDrag
        );
    }

    /*
     * ============================================================
     * ELEMENT INFORMATION
     * ============================================================
     */

    function elementInfo(
        element
    ) {
        if (!element) {
            return "Not found";
        }

        const tag =
            element.tagName
                ?.toLowerCase() ||
            "element";

        const id =
            element.id
                ? `#${element.id}`
                : "";

        const classes =
            typeof element.className ===
                "string" &&
            element.className
                ? `.${element.className
                    .trim()
                    .split(/\s+/)
                    .slice(
                        0,
                        2
                    )
                    .join(".")}`
                : "";

        return (
            `${tag}${id}${classes}`
        );
    }

    /*
     * ============================================================
     * UPDATE UI
     * ============================================================
     */

    function updateUI() {
        if (
            !helperPanel ||
            !document.body.contains(
                helperPanel
            )
        ) {
            return;
        }

        const field =
            name =>
                helperPanel.querySelector(
                    `[data-field="${name}"]`
                );

        const setField =
            (
                name,
                value
            ) => {
                const element =
                    field(name);

                if (element) {
                    element.textContent =
                        value;
                }
            };

        setField(
            "status",
            settings.enabled
                ? "ON"
                : "OFF"
        );

        setField(
            "state",
            state
        );

        setField(
            "cycle",
            String(cycle)
        );

        setField(
            "action",
            lastAction
        );

        renderChestLog();

        const freshChestApi =
            getFreshChestApiSnapshot();

        setField(
            "chest",
            getChestStateLabel()
        );

        /*
         * The important distinction:
         *
         * Last Chest Check = the latest likes reading used by a chest check.
         */
        setField(
            "last-check",
            lastCheckedLikes ===
                null
                ? "—"
                : formatLikes(
                    lastCheckedLikes
                )
        );

        setField(
            "likes",
            freshChestApi &&
                freshChestApi.likes !== null
                ? formatLikes(freshChestApi.likes)
                : currentLikes !== null
                    ? formatLikes(currentLikes)
                    : "—"
        );

        setField(
            "target",
            formatLikes(
                getCurrentChestThreshold()
            )
        );

        setField(
            "locked",
            lockedLikes ===
                null
                ? "—"
                : formatLikes(
                    lockedLikes
                )
        );

        setField(
            "recheck",
            chestTimerEnd
                ? formatTimer(
                    remainingSeconds(
                        chestTimerEnd
                    )
                )
                : "—"
        );

        setField(
            "opening",
            openingTimerEnd
                ? formatTimer(
                    remainingSeconds(
                        openingTimerEnd
                    )
                )
                : "—"
        );

        setField(
            "auto-info",
            !settings.autoInfoEnabled
                ? "OFF"
                : autoInfoNextAt
                    ? formatTimer(
                        remainingSeconds(
                            autoInfoNextAt
                        )
                    )
                    : "Starting..."
        );

        const soundNameField =
            helperPanel.querySelector(
                '[data-field="open-sound-name"]'
            );

        if (soundNameField) {
            soundNameField.textContent =
                customOpenSoundName ||
                "No sound selected";
            soundNameField.title =
                customOpenSoundName ||
                "No sound selected";
        }

        const soundVolumeField =
            helperPanel.querySelector(
                '[data-field="open-sound-volume"]'
            );

        if (soundVolumeField) {
            soundVolumeField.textContent =
                `${Math.round(
                    clamp(
                        Number(settings.openSoundVolume),
                        0,
                        1
                    ) * 100
                )}%`;
        }

        setField(
            "footer-likes",
            lastCheckedLikes ===
                null
                ? "—"
                : formatLikes(
                    lastCheckedLikes
                )
        );

        const toggle =
            helperPanel.querySelector(
                '[data-action="toggle"]'
            );

        if (toggle) {
            toggle.textContent =
                settings.enabled
                    ? "ON"
                    : "OFF";

            toggle.classList.toggle(
                "ych-off",
                !settings.enabled
            );
        }

        applyPanelState();
    }

    /*
     * ============================================================
     * STARTUP
     * ============================================================
     */

    function start() {

        if (
            !document.body
        ) {
            setTimeout(
                start,
                500
            );

            return;
        }

        installCSS();

        /* Keep the existing working helper panel creation method intact. */
        createHelperPanel();

        /* Audio is optional and initializes only after the panel exists. */
        loadCustomOpenSound()
            .then(() => updateUI())
            .catch(error => {
                console.warn(
                    "[Chest Helper] Custom sound initialization failed:",
                    error
                );
            });

        updateBroadcastSafety();

        if (ownBroadcastActive && settings.enabled) {
            scheduleAutoInfo();
        }

        setAction(
            settings.enabled
                ? (ownBroadcastActive ? "Helper ready — waiting for chest" : "NOT LIVE — automation stopped")
                : "Helper disabled"
        );

        /*
         * Main polling loop.
         *
         * No MutationObserver.
         */
        setInterval(
            async () => {
                /*
                 * processState() contains awaits. Never allow two
                 * state-machine executions to overlap.
                 */
                if (processStateBusy) {
                    return;
                }

                processStateBusy = true;

                try {
                    await processState();

                    recovery();

                    updateUI();
                } catch (error) {
                    console.error(
                        "[Chest Helper] Main loop error:",
                        error
                    );

                    setAction(
                        `Runtime error: ${
                            error?.message ||
                            error
                        }`
                    );
                } finally {
                    processStateBusy = false;
                }
            },
            500
        );

        /*
         * Faster UI refresh for timers.
         */
        setInterval(
            () => {
                try {
                    updateUI();
                } catch (_) {}
            },
            250
        );
    }

    start();

})();
   newState;

        stateStartedAt =
            Date.now();

        updateUI();
    }

    /*
     * ============================================================
     * NUMBER PARSING
     * ============================================================
     */

    function parseYouNowNumber(
        value
    ) {
        if (
            value === null ||
            value === undefined
        ) {
            return null;
        }

        let text =
            String(value)
                .trim()
                .replace(
                    /\u00a0/g,
                    " "
                )
                .replace(
                    /\s+/g,
                    ""
                )
                .toUpperCase();

        if (!text) {
            return null;
        }

        let multiplier = 1;

        if (
            text.endsWith("K")
        ) {
            multiplier = 1000;

            text =
                text.slice(
                    0,
                    -1
                );
        } else if (
            text.endsWith("M")
        ) {
            multiplier = 1000000;

            text =
                text.slice(
                    0,
                    -1
                );
        } else if (
            text.endsWith("B")
        ) {
            multiplier = 1000000000;

            text =
                text.slice(
                    0,
                    -1
                );
        }

        text =
            text.replace(
                /[^0-9.,+-]/g,
                ""
            );

        if (!text) {
            return null;
        }

        if (
            text.includes(".") &&
            text.includes(",")
        ) {
            const dot =
                text.lastIndexOf(".");

            const comma =
                text.lastIndexOf(",");

            if (
                dot > comma
            ) {
                text =
                    text.replace(
                        /,/g,
                        ""
                    );
            } else {
                text =
                    text.replace(
                        /\./g,
                        ""
                    );

                text =
                    text.replace(
                        ",",
                        "."
                    );
            }
        } else if (
            text.includes(",")
        ) {
            const pieces =
                text.split(",");

            if (
                pieces.length > 2 ||
                pieces[
                    pieces.length - 1
                ].length === 3
            ) {
                text =
                    text.replace(
                        /,/g,
                        ""
                    );
            }
        } else if (
            text.includes(".")
        ) {
            const pieces =
                text.split(".");

            if (
                pieces.length > 2 ||
                pieces[
                    pieces.length - 1
                ].length === 3
            ) {
                text =
                    text.replace(
                        /\./g,
                        ""
                    );
            }
        }

        const number =
            parseFloat(
                text
            );

        if (
            !Number.isFinite(
                number
            )
        ) {
            return null;
        }

        return Math.round(
            number *
                multiplier
        );
    }

    /*
     * ============================================================
     * BROADCAST DETECTION / SAFETY
     * ============================================================
     */

    function findBroadcastEndButton() {
        const candidates = Array.from(
            document.querySelectorAll(
                'button.button.button--small.button--red'
            )
        );

        return candidates.find(
            button =>
                isVisible(button) &&
                String(button.textContent || "").trim() === "END"
        ) || null;
    }

    function detectOwnBroadcasting() {
        return Boolean(findBroadcastEndButton());
    }

    function resetAutomationForNonBroadcast() {
        chestTimerEnd = null;
        openingTimerEnd = null;
        autoInfoNextAt = null;
        checkCycleInProgress = false;
        likesReadThisCheck = false;
        likesCheckDeadline = null;
        openingChatSent = false;
        soundPlayedForCycle = false;
        currentLikes = null;
        lockedLikes = null;
        likesLockedForCycle = false;
        cycleLocked = false;
        preOpenVerification = false;
        openedChestRecordedForCycle = false;
        winnerCloseAttempts = 0;
        lastObservedChestState = getChestState();
        offModeCheckedForAvailableChest = false;
        state = STATES.OFF;
    }

    function updateBroadcastSafety() {
        const live = detectOwnBroadcasting();

        if (!live) {
            if (ownBroadcastActive || !broadcastDetectionInitialized) {
                ownBroadcastActive = false;
                broadcastDetectionInitialized = true;
                resetChestApiSnapshot();
                resetAutomationForNonBroadcast();
                if (settings.enabled) {
                    setAction("NOT LIVE — automation stopped (END button not found)");
                }
            }
            return false;
        }

        if (!ownBroadcastActive) {
            ownBroadcastActive = true;
            broadcastDetectionInitialized = true;
            resetChestApiSnapshot();
            chestTimerEnd = null;
            openingTimerEnd = null;
            autoInfoNextAt = null;
            checkCycleInProgress = false;
            likesReadThisCheck = false;
            likesCheckDeadline = null;
            openingChatSent = false;
            soundPlayedForCycle = false;
            currentLikes = null;
            lockedLikes = null;
            likesLockedForCycle = false;
            cycleLocked = false;
            preOpenVerification = false;
            openedChestRecordedForCycle = false;
            winnerCloseAttempts = 0;
            stateStartedAt = Date.now();
            recoveryStartedAt = Date.now();
            /* Force a fresh AVAILABLE check after going live. */
            lastObservedChestState = "UNKNOWN";
            offModeCheckedForAvailableChest = false;
            if (settings.enabled) {
                state = STATES.WAITING_FOR_CHEST;
                scheduleAutoInfo();
                setAction("LIVE — END button detected; automation active");
            }
        }
        return true;
    }

    function canPerformAutomatedAction(requireAvailableChest = false) {
        if (!updateBroadcastSafety()) {
            return false;
        }

        const chestState = getChestState();

        if (chestState === "UNKNOWN") {
            if (lastAction !== "Chest state UNKNOWN — waiting before automated action") {
                setAction("Chest state UNKNOWN — waiting before automated action");
            }
            return false;
        }

        if (requireAvailableChest && chestState !== "AVAILABLE") {
            if (lastAction !== "Chest UNAVAILABLE — waiting before chest action") {
                setAction("Chest UNAVAILABLE — waiting before chest action");
            }
            return false;
        }

        return true;
    }

    /*
     * ============================================================
     * ACTUAL CHEST BUTTON
     * ============================================================
     */

    function getChestButton() {
        const buttons =
            Array.from(
                document.querySelectorAll(
                    'button.chest-button[aria-label="Chest button"]'
                )
            );

        return buttons.find(isVisible) || null;
    }

    function getChestApiParameter(resourceName, parameterName) {
        try {
            const parsed =
                new URL(
                    resourceName,
                    pageWindow.location.href
                );

            const prefix =
                `${parameterName}=`;

            const pathSegment =
                parsed.pathname
                    .split("/")
                    .find(
                        segment =>
                            segment.startsWith(prefix)
                    );

            if (pathSegment) {
                const value =
                    pathSegment.slice(prefix.length);

                try {
                    return decodeURIComponent(value);
                } catch (_) {
                    return value;
                }
            }

            return parsed.searchParams.get(parameterName);
        } catch (_) {
            return null;
        }
    }

    function findLatestChestApiParameter(routePart, parameterName) {
        try {
            const entries =
                pageWindow.performance
                    .getEntriesByType("resource")
                    .filter(
                        entry =>
                            typeof entry.name === "string" &&
                            entry.name.includes(routePart)
                    )
                    .sort(
                        (a, b) =>
                            (b.startTime || 0) -
                            (a.startTime || 0)
                    );

            for (const entry of entries) {
                const value =
                    getChestApiParameter(
                        entry.name,
                        parameterName
                    );

                if (value) {
                    return value;
                }
            }
        } catch (_) {}

        return null;
    }

    function getChestApiContext() {
        const userId =
            findLatestChestApiParameter(
                "/php/api/younow/notificationCount",
                "userId"
            );

        const channelId =
            findLatestChestApiParameter(
                "/php/api/channel/getStickers",
                "channelId"
            );

        if (!userId || !channelId) {
            return null;
        }

        return {
            userId,
            channelId
        };
    }

    function resetChestApiSnapshot() {
        chestApiSnapshot = null;
        chestApiSnapshotAt = 0;
        chestApiLastFetchAt = 0;
        chestApiContextKey = "";
        chestApiSnapshotPageUrl =
            String(pageWindow.location.href || "");
    }

    function getFreshChestApiSnapshot() {
        if (
            !ownBroadcastActive ||
            !chestApiSnapshot ||
            Date.now() - chestApiSnapshotAt >
                CHEST_API_SNAPSHOT_MAX_AGE_MS ||
            String(pageWindow.location.href || "") !==
                chestApiSnapshotPageUrl
        ) {
            return null;
        }

        return chestApiSnapshot;
    }

    async function refreshChestApiSnapshot(force = false) {
        const currentPageUrl =
            String(pageWindow.location.href || "");

        if (
            currentPageUrl !==
            chestApiSnapshotPageUrl
        ) {
            resetChestApiSnapshot();
        }

        if (
            !ownBroadcastActive ||
            chestApiRequestInFlight ||
            (!force &&
                Date.now() - chestApiLastFetchAt <
                    CHEST_API_REFRESH_INTERVAL_MS)
        ) {
            return;
        }

        chestApiLastFetchAt = Date.now();

        const context =
            getChestApiContext();

        if (!context) {
            return;
        }

        const contextKey =
            `${context.userId}:${context.channelId}`;

        if (contextKey !== chestApiContextKey) {
            chestApiSnapshot = null;
            chestApiSnapshotAt = 0;
            chestApiContextKey = contextKey;
        }

        const pageFetch =
            pageWindow.fetch;

        if (typeof pageFetch !== "function") {
            return;
        }

        const endpoint =
            `${CHEST_API_URL}/userId=${encodeURIComponent(context.userId)}` +
            `/channelId=${encodeURIComponent(context.channelId)}`;

        const requestPageUrl =
            currentPageUrl;

        chestApiRequestInFlight = true;

        try {
            const response =
                await pageFetch.call(
                    pageWindow,
                    endpoint,
                    {
                        method: "GET",
                        credentials: "include",
                        cache: "no-store"
                    }
                );

            if (!response.ok) {
                return;
            }

            const payload =
                await response.json();

            if (
                String(pageWindow.location.href || "") !==
                    requestPageUrl ||
                contextKey !== chestApiContextKey ||
                Number(payload?.errorCode) !== 0
            ) {
                return;
            }

            const chest =
                payload?.propsChest;

            if (!chest || typeof chest !== "object") {
                chestApiSnapshot = {
                    hasChest: false,
                    chestId: "",
                    state: "CHEST_UNAVAILABLE",
                    likes: null,
                    minLikesToAvailable: null
                };
                chestApiSnapshotAt = Date.now();
                return;
            }

            const likes =
                chest.likes === null ||
                chest.likes === undefined
                    ? null
                    : Number(chest.likes);

            const minLikesToAvailable =
                chest.minLikesToAvailable === null ||
                chest.minLikesToAvailable === undefined
                    ? null
                    : Number(chest.minLikesToAvailable);

            chestApiSnapshot = {
                hasChest: true,
                chestId: String(chest.id ?? ""),
                state: String(chest.state || ""),
                likes: Number.isFinite(likes) ? likes : null,
                minLikesToAvailable:
                    Number.isFinite(minLikesToAvailable)
                        ? minLikesToAvailable
                        : null
            };

            chestApiSnapshotAt = Date.now();
        } catch (_) {
            /* Keep using the existing DOM detector if the API is unavailable. */
        } finally {
            chestApiRequestInFlight = false;
        }
    }

    function getChestApiState(snapshot) {
        if (!snapshot) {
            return "UNKNOWN";
        }

        if (!snapshot.hasChest) {
            return "UNAVAILABLE";
        }

        const apiState =
            String(snapshot.state || "")
                .trim()
                .toUpperCase();

        if (
            apiState === "CHEST_UNAVAILABLE" ||
            apiState === "UNAVAILABLE" ||
            apiState === "CHEST_OPEN" ||
            apiState === "WAITING_FOR_RESULTS"
        ) {
            return "UNAVAILABLE";
        }

        if (
            apiState === "CHEST_AVAILABLE" ||
            apiState === "AVAILABLE" ||
            /^CHEST_OVERFLOWING_[1-5]$/.test(apiState)
        ) {
            return "AVAILABLE";
        }

        return "UNKNOWN";
    }

    function getChestStateFromDOM() {
        const button =
            getChestButton();

        if (!button) {
            return "UNKNOWN";
        }

        const image =
            button.querySelector(
                'img[alt="Chest state image"]'
            );

        if (!image) {
            return "UNKNOWN";
        }

        const src =
            String(image.getAttribute("src") || "")
                .replace(/\s+/g, "");

        if (
            src.includes("/unavailable.svg")
        ) {
            return "UNAVAILABLE";
        }

        if (
            src.includes("/available.svg")
        ) {
            return "AVAILABLE";
        }

        return "UNKNOWN";
    }

    function getChestState() {
        const apiState =
            getChestApiState(
                getFreshChestApiSnapshot()
            );

        if (apiState !== "UNKNOWN") {
            return apiState;
        }

        return getChestStateFromDOM();
    }

    function getChestStateLabel() {
        const chestState =
            getChestState();

        const snapshot =
            getFreshChestApiSnapshot();

        if (
            !snapshot ||
            !snapshot.hasChest ||
            snapshot.likes === null ||
            snapshot.minLikesToAvailable === null
        ) {
            return chestState;
        }

        return `${chestState} (${formatLikes(snapshot.likes)} / ${formatLikes(snapshot.minLikesToAvailable)})`;
    }

    function isChestAvailable() {
        return (
            getChestState() ===
            "AVAILABLE"
        );
    }

    /*
     * ============================================================
     * TREASURE CHEST MODAL
     * ============================================================
     */

    function getTreasureChestModal() {
        const candidates =
            Array.from(
                document.querySelectorAll(
                    '[role="dialog"], .modal, .dialog, [class*="modal"]'
                )
            ).filter(
                isVisible
            );

        const chestModal =
            candidates.find(
                element => {
                    const text =
                        normalizeText(
                            element.textContent
                        );

                    return (
                        text.includes(
                            "treasure chest"
                        ) &&
                        text.includes(
                            "open"
                        ) &&
                        text.includes(
                            "cancel"
                        )
                    );
                }
            );

        return (
            chestModal ||
            null
        );
    }

    function isChestModalOpen() {
        return Boolean(
            getTreasureChestModal()
        );
    }

    /*
     * ============================================================
     * ACTUAL TREASURE CHEST OPEN/CANCEL MODAL
     *
     * This is NOT the sidebar check panel.
     *
     * It appears after the actual chest is clicked and contains
     * the live reward preview plus Open / Cancel.
     * ============================================================
     */

    function findChestCancelButton() {
        const modal =
            getTreasureChestModal();

        if (!modal) {
            return null;
        }

        const buttons =
            Array.from(
                modal.querySelectorAll(
                    'button'
                )
            ).filter(
                isVisible
            );

        const exact =
            buttons.find(
                button =>
                    normalizeText(
                        button.textContent
                    ) ===
                    "cancel"
            );

        if (exact) {
            return exact;
        }

        return (
            buttons.find(
                button => {
                    const aria =
                        normalizeText(
                            button.getAttribute(
                                "aria-label"
                            )
                        );

                    const title =
                        normalizeText(
                            button.getAttribute(
                                "title"
                            )
                        );

                    return (
                        aria === "cancel" ||
                        title === "cancel"
                    );
                }
            ) ||
            null
        );
    }

    async function closeTreasureChestModal() {
        for (
            let attempt = 0;
            attempt < 3;
            attempt++
        ) {
            if (
                !isChestModalOpen()
            ) {
                return true;
            }

            const cancel =
                findChestCancelButton();

            if (!cancel) {
                setAction(
                    `Treasure Chest modal: Cancel not found (${attempt + 1}/3)`
                );

                await sleep(150);
                continue;
            }

            if (!canPerformAutomatedAction()) {
                return false;
            }

            try {
                cancel.click();

                setAction(
                    `Treasure Chest modal: clicked "Cancel" (${attempt + 1}/3)`
                );
            } catch (error) {
                console.warn(
                    "[Chest Helper] Treasure Chest modal Cancel failed:",
                    error
                );
            }

            const started =
                Date.now();

            while (
                Date.now() -
                    started <
                1200
            ) {
                if (
                    !isChestModalOpen()
                ) {
                    setAction(
                        "Treasure Chest modal CLOSED with Cancel"
                    );

                    return true;
                }

                await sleep(100);
            }
        }

        /*
         * Final Escape fallback for the actual Open/Cancel modal only.
         * Never click the chest button to close it.
         */
        try {
            if (!canPerformAutomatedAction()) {
                return false;
            }

            document.dispatchEvent(
                new KeyboardEvent(
                    "keydown",
                    {
                        key: "Escape",
                        code: "Escape",
                        keyCode: 27,
                        which: 27,
                        bubbles: true
                    }
                )
            );

            await sleep(250);

            if (
                !isChestModalOpen()
            ) {
                setAction(
                    "Treasure Chest modal CLOSED with Escape"
                );

                return true;
            }
        } catch (error) {
            console.warn(
                "[Chest Helper] Treasure Chest modal Escape failed:",
                error
            );
        }

        return !isChestModalOpen();
    }

    /*
     * ============================================================
     * CHEST CHECK PANEL
     *
     * This is the sidebar panel opened by the normal chest button.
     * It is different from the later Treasure Chest Open/Cancel
     * dialog used during the actual opening sequence.
     *
     * The UNAVAILABLE chest can show the education panel with:
     *   - Treasure Chest title
     *   - live likes value
     *   - "Got it" button
     *
     * Therefore availability must NOT be used to decide whether the
     * check panel exists or whether its likes can be read.
     * ============================================================
     */

    function getChestCheckPanel() {
        const panels =
            Array.from(
                document.querySelectorAll(
                    '.sidebar-modal-chest, app-sidebar-modal-chest-broadcaster-education'
                )
            ).filter(
                isVisible
            );

        if (!panels.length) {
            return null;
        }

        /* Prefer the panel that actually contains the live counter. */
        const counterPanel =
            panels.find(
                panel =>
                    panel.querySelector(
                        '.total-likes .value'
                    )
            );

        if (counterPanel) {
            return counterPanel;
        }

        return panels[0];
    }

    function isChestCheckPanelOpen() {
        return Boolean(
            getChestCheckPanel()
        );
    }

    /*
     * ============================================================
     * CHEST LIKES
     *
     * Use only the fresh read-only API snapshot. The page's displayed
     * counter is not used to decide whether an API open may be sent.
     * ============================================================
     */

    function getChestLikes() {
        if (
            state !==
                STATES.READING_LIKES ||
            likesLockedForCycle
        ) {
            return null;
        }

        const apiSnapshot =
            getFreshChestApiSnapshot();

        if (
            apiSnapshot &&
            apiSnapshot.likes !== null
        ) {
            lastCheckedLikes =
                apiSnapshot.likes;

            currentLikes =
                apiSnapshot.likes;

            return apiSnapshot.likes;
        }

        return null;
    }

    /*
     * ============================================================
     * CLOSE CHEST CHECK PANEL
     *
     * For an UNAVAILABLE chest the visible close control is the
     * "Got it" button shown in the education panel. For the normal
     * chest panel, Cancel is supported as before.
     *
     * IMPORTANT: Never click the chest button as a close fallback.
     * ============================================================
     */

    function findChestPanelCloseButton() {
        const panel =
            getChestCheckPanel();

        if (!panel) {
            return null;
        }

        const buttons =
            Array.from(
                panel.querySelectorAll(
                    'button'
                )
            ).filter(
                isVisible
            );

        /* Unavailable education panel shown in the supplied screenshot. */
        const gotIt =
            buttons.find(
                button =>
                    normalizeText(
                        button.textContent
                    ) ===
                    'got it'
            );

        /*
         * The unavailable chest screenshot shows this exact control.
         * Prefer it over every other close control.
         */
        if (gotIt) {
            return gotIt;
        }

        /* Normal panel / legacy close control. */
        const cancel =
            buttons.find(
                button =>
                    normalizeText(
                        button.textContent
                    ) ===
                    'cancel'
            );

        if (cancel) {
            return cancel;
        }

        const labelledClose =
            buttons.find(
                button => {
                    const aria =
                        normalizeText(
                            button.getAttribute(
                                'aria-label'
                            )
                        );

                    const title =
                        normalizeText(
                            button.getAttribute(
                                'title'
                            )
                        );

                    return (
                        aria === 'close' ||
                        title === 'close'
                    );
                }
            );

        return labelledClose || null;
    }

    async function closeChestPanel() {
        for (
            let attempt = 0;
            attempt < 3;
            attempt++
        ) {
            if (
                !isChestCheckPanelOpen()
            ) {
                return true;
            }

            const closeButton =
                findChestPanelCloseButton();

            if (!closeButton) {
                setAction(
                    `Chest panel close control not found (${attempt + 1}/3)`
                );

                await sleep(150);
                continue;
            }

            const label =
                normalizeText(
                    closeButton.textContent
                ) ||
                closeButton.getAttribute(
                    'aria-label'
                ) ||
                'close';

            const isGotIt =
                label === 'got it';

            if (!canPerformAutomatedAction()) {
                return false;
            }

            try {
                closeButton.click();

                setAction(
                    isGotIt
                        ? `Unavailable chest: clicked "Got it" after reading likes`
                        : `Chest panel: clicked "${label}" (${attempt + 1}/3)`
                );
            } catch (error) {
                console.warn(
                    '[Chest Helper] Chest panel close click failed:',
                    error
                );
            }

            const started =
                Date.now();

            while (
                Date.now() -
                    started <
                1500
            ) {
                if (
                    !isChestCheckPanelOpen()
                ) {
                    setAction(
                        `Chest panel CLOSED with "${label}"`
                    );

                    return true;
                }

                await sleep(100);
            }
        }

        /*
         * Escape is only a final fallback after the panel's own close
         * control has been attempted. The chest button is NEVER used.
         */
        setAction(
            'Chest panel did not close with its close control — using Escape fallback'
        );

        if (!canPerformAutomatedAction()) {
            return false;
        }

        document.dispatchEvent(
            new KeyboardEvent(
                'keydown',
                {
                    key: 'Escape',
                    code: 'Escape',
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true
                }
            )
        );

        await sleep(600);

        const closed =
            !isChestCheckPanelOpen();

        if (closed) {
            setAction(
                'Chest panel CLOSED with Escape'
            );
        } else {
            setAction(
                'Chest panel remains open after Escape'
            );
        }

        return closed;
    }

    /*
     * Open the broadcaster's current chest through the same first-party
     * API action used by YouNow's client. The API snapshot is checked again
     * immediately before sending the POST so stale page state cannot gate
     * or trigger an open.
     */
    function getStoredYouNowValue(key) {
        try {
            const raw =
                pageWindow.localStorage.getItem(key);

            if (raw === null || raw === undefined) {
                return "";
            }

            try {
                const parsed = JSON.parse(raw);
                return String(parsed ?? "");
            } catch (_) {
                return String(raw);
            }
        } catch (_) {
            return "";
        }
    }

    async function openChestViaApi() {
        if (!updateBroadcastSafety()) {
            return "blocked";
        }

        const context =
            getChestApiContext();

        const apiUserId =
            Number(context?.userId);

        const snapshot =
            getFreshChestApiSnapshot();

        if (
            !context ||
            !Number.isSafeInteger(apiUserId) ||
            apiUserId <= 0
        ) {
            setAction(
                "Signed-in user ID is invalid — API open request not sent"
            );
            return "blocked";
        }

        if (
            !snapshot ||
            !snapshot.hasChest ||
            !snapshot.chestId
        ) {
            setAction(
                "API chest data is missing or stale — open request not sent"
            );
            return "blocked";
        }

        if (
            chestApiOpenAttemptedId ===
            snapshot.chestId
        ) {
            setAction(
                "Open already attempted for this chest — waiting for its API state to change"
            );
            return "blocked";
        }

        if (
            getChestApiState(snapshot) !== "AVAILABLE" ||
            snapshot.likes === null ||
            snapshot.minLikesToAvailable === null ||
            snapshot.likes < snapshot.minLikesToAvailable
        ) {
            setAction(
                "API says chest is not ready — open request not sent"
            );
            return "blocked";
        }

        const pageFetch =
            pageWindow.fetch;

        if (typeof pageFetch !== "function") {
            setAction(
                "Browser fetch is unavailable — API open request not sent"
            );
            return "blocked";
        }

        const requestPageUrl =
            String(pageWindow.location.href || "");

        const formData =
            new URLSearchParams();

        formData.set(
            "userId",
            String(apiUserId)
        );

        const trpxId =
            getStoredYouNowValue("TRPX_ID");

        const trpxDeviceId =
            getStoredYouNowValue("TRPX_DEVICE_ID");

        const language =
            getStoredYouNowValue("UI_LANGUAGE") ||
            String(document.documentElement.lang || "en");

        if (trpxId) {
            formData.set("tsi", trpxId);
        }

        if (trpxDeviceId) {
            formData.set("tdi", trpxDeviceId);
        }

        formData.set("lang", language);

        const headers = {
            "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8"
        };

        const requestBy =
            getStoredYouNowValue("REQUEST_BY");

        if (requestBy) {
            headers["X-Requested-By"] = requestBy;
        }

        /* Lock this chest before sending; a lost response must not cause a duplicate open. */
        chestApiOpenAttemptedId =
            snapshot.chestId;

        try {
            const response =
                await pageFetch.call(
                    pageWindow,
                    CHEST_API_OPEN_URL,
                    {
                        method: "POST",
                        credentials: "include",
                        cache: "no-store",
                        headers,
                        body: formData.toString()
                    }
                );

            let payload = null;

            try {
                payload = await response.json();
            } catch (_) {}

            const apiErrorMessage =
                String(
                    payload?.errorMsg ||
                    payload?.errorMessage ||
                    payload?.message ||
                    payload?.error ||
                    ""
                )
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 120);

            const apiErrorSuffix =
                apiErrorMessage
                    ? ` — ${apiErrorMessage}`
                    : "";

            if (!response.ok) {
                setAction(
                    `YouNow API open failed (${response.status})${apiErrorSuffix} — no automatic retry for this chest`
                );
                return "failed";
            }

            if (Number(payload?.errorCode) !== 0) {
                setAction(
                    `YouNow rejected the API open request (error ${payload?.errorCode ?? "unknown"})${apiErrorSuffix}`
                );
                return "failed";
            }

            if (
                String(pageWindow.location.href || "") !==
                requestPageUrl
            ) {
                setAction(
                    "API open succeeded after the page changed — stopped automation"
                );
                return "failed";
            }

            chestApiSnapshot = {
                ...snapshot,
                state: "CHEST_OPEN"
            };
            chestApiSnapshotAt = Date.now();
            chestOpenConfirmedForCycle = true;

            setAction(
                `Chest opened through YouNow API (${formatLikes(snapshot.likes)} likes)`
            );

            return "opened";
        } catch (error) {
            console.warn(
                "[Chest Helper] API chest open failed:",
                error
            );

            setAction(
                "API open response was uncertain — no automatic retry for this chest"
            );

            return "failed";
        }
    }

    /*
     * ============================================================
     * MAKE IT RAIN
     * ============================================================
     */

    function findMakeItRainButton() {
        return (
            Array.from(
                document.querySelectorAll(
                    "button"
                )
            )
                .filter(
                    isVisible
                )
                .find(
                    button =>
                        normalizeText(
                            button.textContent
                        ) ===
                        "make it rain"
                ) ||
            null
        );
    }

    function clickMakeItRain() {
        if (!canPerformAutomatedAction()) return false;

        const button =
            findMakeItRainButton();

        if (!button) {
            return false;
        }

        try {
            button.click();

            setAction(
                "Make It Rain clicked"
            );

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Make It Rain failed:",
                error
            );

            return false;
        }
    }

    /*
     * ============================================================
     * I'LL TELL THEM
     * ============================================================
     */

    function findTellThemButton() {
        return (
            Array.from(
                document.querySelectorAll(
                    "button"
                )
            )
                .filter(
                    isVisible
                )
                .find(
                    button =>
                        normalizeText(
                            button.textContent
                        ) ===
                        "i'll tell them!"
                ) ||
            null
        );
    }

    function clickTellThem() {
        if (!canPerformAutomatedAction()) return false;

        const button =
            findTellThemButton();

        if (!button) {
            return false;
        }

        try {
            button.click();

            setAction(
                "I'll tell them clicked"
            );

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Tell Them failed:",
                error
            );

            return false;
        }
    }

    /*
     * ============================================================
     * WINNERS PANEL
     * ============================================================
     * YouNow's Winners/Experience overlay is not consistently exposed
     * as one particular class.  Find it from its visible text and then
     * locate the Close control inside that exact element/ancestor.
     */

    function getVisibleElementsWithExactText(text) {
        const wanted = normalizeText(text);

        return Array.from(
            document.querySelectorAll(
                "body *"
            )
        ).filter(element => {
            if (!isVisible(element)) {
                return false;
            }

            return normalizeText(
                element.textContent
            ) === wanted;
        });
    }

    function findClickableCloseIn(root) {
        if (!root) {
            return null;
        }

        const controls = Array.from(
            root.querySelectorAll(
                "button, [role='button'], a, [tabindex], [aria-label], [title]"
            )
        ).filter(isVisible);

        for (const control of controls) {
            const text = normalizeText(
                control.textContent
            );
            const aria = normalizeText(
                control.getAttribute("aria-label")
            );
            const title = normalizeText(
                control.getAttribute("title")
            );

            if (
                text === "close" ||
                aria === "close" ||
                title === "close"
            ) {
                return control;
            }
        }

        /* Some builds render Close as a non-button element. */
        const exactClose =
            getVisibleElementsWithExactText("Close")
                .find(element =>
                    root === element ||
                    root.contains(element)
                );

        if (exactClose) {
            return findClickableAncestor(
                exactClose,
                root
            );
        }

        return null;
    }

    function findClickableAncestor(element, limitRoot = null) {
        let current = element;
        let depth = 0;

        while (
            current &&
            current !== document.body &&
            depth < 8
        ) {
            if (
                current.matches &&
                current.matches(
                    "button, [role='button'], a, [tabindex]"
                ) &&
                isVisible(current)
            ) {
                return current;
            }

            if (
                limitRoot &&
                current === limitRoot
            ) {
                break;
            }

            current = current.parentElement;
            depth++;
        }

        return element && isVisible(element)
            ? element
            : null;
    }

    function findWinnersPanel() {
        /* First choice: the literal Winners! heading. */
        const winnerLabels =
            getVisibleElementsWithExactText("Winners!");

        const candidates = [];

        for (const label of winnerLabels) {
            let current = label.parentElement;
            let depth = 0;

            while (
                current &&
                current !== document.body &&
                depth < 10
            ) {
                const close =
                    findClickableCloseIn(current);

                if (close) {
                    candidates.push({
                        panel: current,
                        close,
                        depth,
                        area: (() => {
                            const r = current.getBoundingClientRect();
                            return r.width * r.height;
                        })()
                    });

                    /* Stop at the first useful containing panel. */
                    break;
                }

                current = current.parentElement;
                depth++;
            }
        }

        /* Fallback for builds that omit the literal Winners! heading. */
        const generic = Array.from(
            document.querySelectorAll(
                '[role="dialog"], .modal, .dialog, [class*="modal"], [class*="drawer"], [class*="panel"]'
            )
        ).filter(isVisible);

        for (const element of generic) {
            const text = normalizeText(
                element.textContent
            );

            if (
                !text.includes("winners") &&
                !text.includes("experience") &&
                !text.includes("reward")
            ) {
                continue;
            }

            const close =
                findClickableCloseIn(element);

            if (close) {
                const r = element.getBoundingClientRect();
                candidates.push({
                    panel: element,
                    close,
                    depth: 99,
                    area: r.width * r.height
                });
            }
        }

        if (!candidates.length) {
            return null;
        }

        candidates.sort((a, b) => {
            if (a.depth !== b.depth) {
                return a.depth - b.depth;
            }

            return a.area - b.area;
        });

        return candidates[0].panel;
    }

    function findWinnerCloseButton(panel) {
        if (!panel) {
            return null;
        }

        const direct =
            findClickableCloseIn(panel);

        if (direct) {
            return direct;
        }

        /* Last-resort search for a visible exact Close element inside panel. */
        const exactClose =
            getVisibleElementsWithExactText("Close")
                .find(element =>
                    panel === element ||
                    panel.contains(element)
                );

        return exactClose
            ? findClickableAncestor(
                exactClose,
                panel
            )
            : null;
    }

    function clickWinnerCloseControl(button) {
        if (!button || !canPerformAutomatedAction()) {
            return false;
        }

        try {
            if (typeof PointerEvent === "function") {
                button.dispatchEvent(
                    new PointerEvent("pointerdown", {
                        bubbles: true,
                        cancelable: true,
                        button: 0
                    })
                );
            }

            button.dispatchEvent(
                new MouseEvent("mousedown", {
                    bubbles: true,
                    cancelable: true,
                    button: 0
                })
            );

            if (typeof PointerEvent === "function") {
                button.dispatchEvent(
                    new PointerEvent("pointerup", {
                        bubbles: true,
                        cancelable: true,
                        button: 0
                    })
                );
            }

            button.dispatchEvent(
                new MouseEvent("mouseup", {
                    bubbles: true,
                    cancelable: true,
                    button: 0
                })
            );

            if (!canPerformAutomatedAction()) {
                return false;
            }

            button.click();

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Winners close dispatch failed:",
                error
            );

            try {
                if (!canPerformAutomatedAction()) {
                    return false;
                }

                button.click();
                return true;
            } catch (_) {
                return false;
            }
        }
    }

    async function closeWinnersPanel() {
        const panel = findWinnersPanel();

        if (!panel) {
            winnerCloseAttempts = 0;
            return true;
        }

        const close =
            findWinnerCloseButton(panel);

        if (!close) {
            winnerCloseAttempts++;
            setAction(
                `Winners panel found — Close control not found (${winnerCloseAttempts})`
            );

            if (winnerCloseAttempts >= 4) {
                setAction(
                    "Winners Close control unavailable — using Escape"
                );

                if (!canPerformAutomatedAction()) {
                    return false;
                }

                document.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: "Escape",
                        code: "Escape",
                        keyCode: 27,
                        which: 27,
                        bubbles: true,
                        cancelable: true
                    })
                );

                await sleep(500);

                if (!findWinnersPanel()) {
                    winnerCloseAttempts = 0;
                    return true;
                }
            }

            return false;
        }

        winnerCloseAttempts++;

        const clicked =
            clickWinnerCloseControl(close);

        setAction(
            clicked
                ? `Winners Close clicked (${winnerCloseAttempts})`
                : `Winners Close click failed (${winnerCloseAttempts})`
        );

        await sleep(500);

        if (!findWinnersPanel()) {
            winnerCloseAttempts = 0;
            setAction("Winners panel CLOSED");
            return true;
        }

        if (winnerCloseAttempts >= 4) {
            if (!canPerformAutomatedAction()) {
                return false;
            }

            document.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    code: "Escape",
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true
                })
            );

            await sleep(500);

            if (!findWinnersPanel()) {
                winnerCloseAttempts = 0;
                setAction("Winners panel CLOSED with Escape");
                return true;
            }
        }

        return false;
    }

    /*
     * ============================================================
     * CHAT
     * ============================================================
     */

    function getChatInput() {
        const exact =
            document.querySelector(
                'textarea[aria-label="Chat input text"]'
            );

        if (
            exact &&
            isVisible(exact)
        ) {
            return exact;
        }

        return (
            Array.from(
                document.querySelectorAll(
                    "textarea"
                )
            ).find(
                textarea => {
                    if (
                        !isVisible(
                            textarea
                        )
                    ) {
                        return false;
                    }

                    const aria =
                        textarea.getAttribute(
                            "aria-label"
                        ) || "";

                    const placeholder =
                        textarea.getAttribute(
                            "placeholder"
                        ) || "";

                    return (
                        /chat input/i.test(
                            aria
                        ) ||
                        /chat with/i.test(
                            placeholder
                        )
                    );
                }
            ) ||
            null
        );
    }

    function setNativeValue(
        element,
        value
    ) {
        const prototype =
            Object.getPrototypeOf(
                element
            );

        const descriptor =
            Object.getOwnPropertyDescriptor(
                prototype,
                "value"
            );

        if (
            descriptor &&
            descriptor.set
        ) {
            descriptor.set.call(
                element,
                value
            );
        } else {
            element.value =
                value;
        }

        element.dispatchEvent(
            new Event(
                "input",
                {
                    bubbles: true
                }
            )
        );

        element.dispatchEvent(
            new Event(
                "change",
                {
                    bubbles: true
                }
            )
        );
    }

    function sendChatMessage(
        message
    ) {
        if (!updateBroadcastSafety()) {
            setAction("Chat blocked — END button not found");
            return false;
        }

        const input =
            getChatInput();

        if (!input) {
            setAction(
                "Chat input not found"
            );

            return false;
        }

        try {
            input.focus();

            setNativeValue(
                input,
                message
            );

            const options = {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            };

            input.dispatchEvent(
                new KeyboardEvent(
                    "keydown",
                    options
                )
            );

            input.dispatchEvent(
                new KeyboardEvent(
                    "keypress",
                    options
                )
            );

            input.dispatchEvent(
                new KeyboardEvent(
                    "keyup",
                    options
                )
            );

            setAction(
                `Chat sent: ${message}`
            );

            return true;
        } catch (error) {
            console.warn(
                "[Chest Helper] Chat failed:",
                error
            );

            return false;
        }
    }

    /*
     * ============================================================
     * CHAT VARIABLES
     * ============================================================
     *
     * {likes}
     *     = actual likes from the most recent successful chest
     *       panel check.
     *
     * {threshold}
     *     = API chest minimum when available, otherwise the fallback target.
     *
     * {lockedLikes}
     *     = likes value locked when threshold was reached.
     *
     * {delay}
     *     = configured opening delay.
     *
     * {cycle}
     *     = current cycle number.
     *
     * {remaining}
     *     = current timer remaining.
     * ============================================================
     */

    function getCurrentChestThreshold() {
        const snapshot =
            getFreshChestApiSnapshot();

        if (
            snapshot &&
            snapshot.minLikesToAvailable !== null
        ) {
            return snapshot.minLikesToAvailable;
        }

        return settings.threshold;
    }

    function replaceVariables(
        message
    ) {

        /*
         * IMPORTANT:
         *
         * {likes} deliberately uses lastCheckedLikes.
         *
         * It does NOT use threshold.
         * It does NOT use the configured target.
         * It does NOT scan the page.
         */
        const likes =
            lastCheckedLikes !==
                null
                ? lastCheckedLikes
                : currentLikes;

        const remaining =
            remainingSeconds(
                openingTimerEnd
            ) ??
            remainingSeconds(
                chestTimerEnd
            ) ??
            0;

        return String(
            message || ""
        )
            .replace(
                /\{likes\}/gi,
                formatLikes(
                    likes
                )
            )
            .replace(
                /\{threshold\}/gi,
                formatLikes(
                    getCurrentChestThreshold()
                )
            )
            .replace(
                /\{lockedLikes\}/gi,
                formatLikes(
                    lockedLikes
                )
            )
            .replace(
                /\{delay\}/gi,
                String(
                    settings.openingDelaySeconds
                )
            )
            .replace(
                /\{cycle\}/gi,
                String(cycle)
            )
            .replace(
                /\{remaining\}/gi,
                String(remaining)
            );
    }

    function sendOpeningAnnouncement() {
        if (
            !settings.openingChatEnabled ||
            openingChatSent
        ) {
            return;
        }

        const message =
            replaceVariables(
                settings.openingChatMessage
            );

        if (
            sendChatMessage(
                message
            )
        ) {
            openingChatSent =
                true;
        }
    }

    /*
     * ============================================================
     * AUTO INFO
     * ============================================================
     *
     * This timer is completely independent of the chest-opening
     * cycle.
     * ============================================================
     */

    function scheduleAutoInfo() {
        if (
            !settings.autoInfoEnabled ||
            !ownBroadcastActive ||
            !detectOwnBroadcasting()
        ) {
            autoInfoNextAt =
                null;

            return;
        }

        autoInfoNextAt =
            Date.now() +
            settings.autoInfoMinutes *
                60 *
                1000;
    }

    function processAutoInfo() {
        if (!updateBroadcastSafety()) {
            return;
        }

        if (
            !settings.autoInfoEnabled
        ) {
            return;
        }

        if (!autoInfoNextAt) {
            scheduleAutoInfo();

            return;
        }

        if (
            Date.now() <
            autoInfoNextAt
        ) {
            return;
        }

        const message =
            replaceVariables(
                settings.autoInfoMessage
            );

        sendChatMessage(
            message
        );

        if (ownBroadcastActive) {
            scheduleAutoInfo();
        } else {
            autoInfoNextAt = null;
        }
    }

    /*
     * ============================================================
     * TIMERS
     * ============================================================
     */

    function startRecheckTimer() {
        if (!settings.timerEnabled) {
            chestTimerEnd = null;
            return;
        }

        chestTimerEnd =
            Date.now() +
            settings.recheckSeconds *
                1000;

        setAction(
            `Recheck timer started: ${settings.recheckSeconds}s`
        );
    }

    function startImmediateRecheck() {
        /* Timer OFF is intentionally a real OFF state, not a 0/1-second timer. */
        if (!settings.timerEnabled) {
            chestTimerEnd = null;
            return;
        }

        chestTimerEnd = Date.now();
        setAction("Immediate chest recheck started");
    }

    function startOpenDelay() {
        openingTimerEnd =
            Date.now() +
            settings.openingDelaySeconds *
                1000;

        setAction(
            `Opening delay started: ${settings.openingDelaySeconds}s`
        );
    }

    /*
     * ============================================================
     * BEGIN FRESH CHEST CYCLE
     * ============================================================
     */

    function beginFreshCycle() {
        /*
         * This is a likes-check/opening cycle, not a completed chest
         * cycle. The completed cycle number advances only after the
         * full opening and cleanup sequence succeeds.
         *
         * Start each chest with a clean last-check value.
         */
        lastCheckedLikes =
            null;

        currentLikes =
            null;

        lockedLikes =
            null;

        likesLockedForCycle =
            false;

        cycleLocked =
            true;

        checkCycleInProgress =
            true;

        likesReadThisCheck =
            false;

        likesCheckDeadline =
            null;

        openingChatSent =
            false;

        openedChestRecordedForCycle =
            false;

        chestOpenConfirmedForCycle =
            false;

        soundPlayedForCycle =
            false;

        preOpenVerification = false;

        chestTimerEnd =
            null;

        openingTimerEnd =
            null;

        winnerCloseAttempts =
            0;

        recoveryStartedAt =
            Date.now();

        setAction(
            `Fresh chest cycle ${cycle} started`
        );

        setState(
            STATES.OPENING_PANEL
        );
    }

    /*
     * ============================================================
     * LOCK LIKES
     * ============================================================
     */

    function lockLikes(
        likes
    ) {
        if (
            likesLockedForCycle
        ) {
            return;
        }

        /*
         * Preserve the actual last checked number.
         */
        lastCheckedLikes =
            likes;

        currentLikes =
            likes;

        lockedLikes =
            likes;

        likesLockedForCycle =
            true;

        cycleLocked =
            true;

        setAction(
            `Locked ${formatLikes(likes)} likes for cycle ${cycle}`
        );
    }

    /*
     * ============================================================
     * STATE MACHINE
     * ============================================================
     */

    async function processState() {

        if (!updateBroadcastSafety()) {
            return;
        }

        void refreshChestApiSnapshot();

        if (
            !settings.enabled
        ) {
            state =
                STATES.OFF;

            return;
        }

        /*
         * Independent Auto Info.
         */
        processAutoInfo();

        switch (state) {

            case STATES.WAITING_FOR_CHEST:

                {
                    const chestState = getChestState();
                    const apiSnapshot =
                        getFreshChestApiSnapshot();
                    const apiChestState =
                        getChestApiState(apiSnapshot);
                    const attemptedChestId =
                        chestApiOpenAttemptedId;

                    if (
                        chestApiOpenAttemptedId &&
                        apiSnapshot &&
                        (
                            apiSnapshot.chestId !==
                                chestApiOpenAttemptedId ||
                            apiChestState === "UNAVAILABLE"
                        )
                    ) {
                        chestApiOpenAttemptedId = "";

                        if (
                            apiSnapshot.chestId &&
                            apiSnapshot.chestId !==
                                attemptedChestId
                        ) {
                            offModeCheckedForAvailableChest = false;
                            lastObservedChestState = "UNAVAILABLE";
                        }
                    }

                    if (
                        chestApiOpenAttemptedId &&
                        apiSnapshot &&
                        apiSnapshot.chestId ===
                            chestApiOpenAttemptedId
                    ) {
                        lastObservedChestState =
                            chestState;
                        return;
                    }

                    /* Preserve existing behavior when the recheck timer is ON. */
                    if (settings.timerEnabled) {
                        if (chestState !== "UNKNOWN" && !cycleLocked) {
                            beginFreshCycle();
                        }
                        lastObservedChestState = chestState;
                        return;
                    }

                    /* Timer OFF: one check only when the chest becomes AVAILABLE. */
                    if (chestState === "UNAVAILABLE") {
                        offModeCheckedForAvailableChest = false;
                    }

                    const becameAvailable =
                        chestState === "AVAILABLE" &&
                        lastObservedChestState !== "AVAILABLE";

                    if (
                        chestState === "AVAILABLE" &&
                        !offModeCheckedForAvailableChest &&
                        (becameAvailable || lastObservedChestState === "UNKNOWN") &&
                        !cycleLocked
                    ) {
                        offModeCheckedForAvailableChest = true;
                        beginFreshCycle();
                    }

                    lastObservedChestState = chestState;
                }

                return;

            case STATES.OPENING_PANEL:

                /*
                 * This state is entered ONLY when the scheduled check
                 * timer expires. Do not run this continuously.
                 */
                if (!checkCycleInProgress) {
                    return;
                }

                const apiSnapshot =
                    getFreshChestApiSnapshot();

                if (
                    apiSnapshot &&
                    apiSnapshot.hasChest &&
                    apiSnapshot.likes !== null
                ) {
                    setAction(
                        "Checking live chest likes through the API"
                    );

                    likesCheckDeadline =
                        Date.now() +
                        LIVE_LIKES_CHECK_WINDOW_MS;

                    setState(
                        STATES.READING_LIKES
                    );

                    return;
                }

                setAction(
                    "Waiting for a fresh chest API reading"
                );

                return;

            case STATES.READING_LIKES:
                {
                    if (
                        likesLockedForCycle
                    ) {
                        return;
                    }

                    const likes =
                        getChestLikes();

                    if (
                        likes === null
                    ) {
                        setAction(
                            "Waiting for live chest likes"
                        );

                        return;
                    }

                    /*
                     * getChestLikes() has already updated:
                     *
                     * lastCheckedLikes
                     * currentLikes
                     *
                     * using the actual chest-panel value.
                     */
                    likesReadThisCheck =
                        true;

                    const effectiveThreshold =
                        getCurrentChestThreshold();

                    const apiChestAvailable =
                        getChestApiState(
                            getFreshChestApiSnapshot()
                        ) === "AVAILABLE";

                    /* The API's available state overrides the fallback target. */
                    if (
                        likes < effectiveThreshold &&
                        !apiChestAvailable
                    ) {
                        /*
                         * Keep the actual chest panel open briefly while
                         * likes are arriving. YouNow updates .total-likes
                         * live, so the next 500 ms poll can catch the
                         * threshold being reached during this same check.
                         *
                         * This is NOT the recheck timer: once this bounded
                         * window expires, the panel closes and the normal
                         * timer/AVAILABLE-transition rules take over.
                         */
                        if (!likesCheckDeadline) {
                            likesCheckDeadline =
                                Date.now() +
                                LIVE_LIKES_CHECK_WINDOW_MS;
                        }

                        const remaining =
                            Math.max(
                                0,
                                likesCheckDeadline -
                                Date.now()
                            );

                        if (remaining > 0 && isChestAvailable()) {
                            setAction(
                                `Watching live chest likes: ${formatLikes(likes)} / ${formatLikes(effectiveThreshold)} — ${Math.ceil(remaining / 1000)}s left`
                            );

                            return;
                        }

                        likesCheckDeadline =
                            null;

                        setAction(
                            `Chest likes ${formatLikes(likes)} / ${formatLikes(effectiveThreshold)} — check complete`
                        );

                        setState(
                            STATES.CLOSING_BELOW_TARGET
                        );

                        return;
                    }

                    /*
                     * The threshold may be reached while the chest is
                     * still unavailable.  Record the real likes value,
                     * close the panel, and wait for the next recheck.
                     * Do not lock the cycle or send an opening message
                     * until the chest itself is AVAILABLE.
                     */
                    if (!isChestAvailable()) {
                        setAction(
                            `Chest likes ${formatLikes(likes)} reached target, but chest is UNAVAILABLE — waiting for next check`
                        );

                        if (!likesReadThisCheck) {
                            return;
                        }

                        const closed =
                            await closeChestPanel();

                        if (!closed) {
                            return;
                        }

                        likesCheckDeadline =
                            null;

                        checkCycleInProgress =
                            false;

                        cycleLocked =
                            false;

                        likesLockedForCycle =
                            false;

                        lockedLikes =
                            null;

                        if (settings.timerEnabled) {
                            startRecheckTimer();
                            setState(STATES.WAITING_FOR_RECHECK);
                        } else {
                            chestTimerEnd = null;
                            preOpenVerification = false;
                            setState(STATES.WAITING_FOR_CHEST);
                        }

                        return;
                    }

                    likesCheckDeadline =
                        null;

                    /* Final verification: do not restart the delay or announcement. */
                    if (preOpenVerification) {
                        lockLikes(likes);
                        const finalClosed = await closeChestPanel();
                        if (!finalClosed) {
                            setAction("Final likes check passed, but chest panel could not close yet — retrying");
                            return;
                        }
                        preOpenVerification = false;
                        checkCycleInProgress = false;
                        setAction(`Final likes check passed: ${formatLikes(likes)} — opening now`);
                        setState(STATES.OPENING_VIA_API);
                        return;
                    }

                    /*
                     * Threshold reached while the chest is AVAILABLE.
                     */
                    lockLikes(
                        likes
                    );

                    /*
                     * Opening announcement uses lastCheckedLikes.
                     */
                    if (
                        settings.openingChatEnabled &&
                        !openingChatSent
                    ) {
                        sendChatMessage(
                            replaceVariables(
                                settings.openingChatMessage
                            )
                        );

                        openingChatSent =
                            true;
                    }

                    /*
                     * Close using the chest panel close control (Got it/Cancel).
                     */
                    const closed =
                        await closeChestPanel();

                    if (!closed) {
                        setAction(
                            "Chest panel could not be closed yet — retrying"
                        );

                        return;
                    }

                    startOpenDelay();

                    setState(
                        STATES.WAITING_FOR_OPEN_DELAY
                    );

                    return;
                }

            case STATES.CLOSING_BELOW_TARGET:
                {
                    if (
                        isChestCheckPanelOpen()
                    ) {
                        const closed =
                            await closeChestPanel();

                        if (!closed) {
                            return;
                        }
                    }

                    checkCycleInProgress =
                        false;

                    likesReadThisCheck =
                        false;

                    likesCheckDeadline =
                        null;

                    cycleLocked =
                        false;

                    preOpenVerification = false;

                    likesLockedForCycle =
                        false;

                    lockedLikes =
                        null;

                    /*
                     * Keep lastCheckedLikes so {likes} continues to
                     * represent the last actual chest check until
                     * the next fresh cycle starts.
                     */

                    if (settings.timerEnabled) {
                        startRecheckTimer();
                        setState(STATES.WAITING_FOR_RECHECK);
                    } else {
                        /* No timer: wait for the next AVAILABLE transition. */
                        chestTimerEnd = null;
                        setState(STATES.WAITING_FOR_CHEST);
                    }

                    return;
                }

            case STATES.WAITING_FOR_RECHECK:

                /*
                 * NEVER close/open the chest panel here. The panel is
                 * handled only by the active timer-driven check cycle.
                 */
                if (
                    checkCycleInProgress
                ) {
                    return;
                }

                if (
                    chestTimerEnd &&
                    Date.now() >=
                        chestTimerEnd
                ) {
                    if (getChestState() === "UNKNOWN") {
                        if (lastAction !== "Chest state UNKNOWN — recheck is waiting") {
                            setAction("Chest state UNKNOWN — recheck is waiting");
                        }
                        return;
                    }

                    chestTimerEnd =
                        null;

                    /*
                     * New cycle begins with a clean lastCheckedLikes.
                     */
                    lastCheckedLikes =
                        null;

                    currentLikes =
                        null;

                    lockedLikes =
                        null;

                    likesLockedForCycle =
                        false;

                    cycleLocked =
                        true;

                    checkCycleInProgress =
                        true;

                    likesReadThisCheck =
                        false;

                    setAction(
                        "Recheck timer expired — checking chest again"
                    );

                    setState(
                        STATES.OPENING_PANEL
                    );
                }

                return;

            case STATES.WAITING_FOR_OPEN_DELAY:

                if (
                    isChestModalOpen()
                ) {
                    await closeTreasureChestModal();

                    return;
                }

                if (
                    openingTimerEnd &&
                    Date.now() >=
                        openingTimerEnd
                ) {
                    if (!canPerformAutomatedAction(true)) {
                        return;
                    }

                    openingTimerEnd = null;

                    /* Timer OFF: one final live likes check immediately before opening. */
                    if (!settings.timerEnabled && !preOpenVerification) {
                        preOpenVerification = true;
                        checkCycleInProgress = true;
                        likesReadThisCheck = false;
                        likesCheckDeadline = null;
                        /* Unlock the previous value so this is a real fresh read. */
                        likesLockedForCycle = false;
                        lockedLikes = null;
                        lastCheckedLikes = null;
                        currentLikes = null;
                        setAction("Opening delay complete — final chest likes check before opening");
                        setState(STATES.OPENING_PANEL);
                        return;
                    }

                    setAction("Opening delay complete");
                    setState(STATES.OPENING_VIA_API);
                }

                return;

            case STATES.OPENING_VIA_API:

                if (
                    isChestModalOpen()
                ) {
                    await closeTreasureChestModal();

                    return;
                }

                if (
                    !cycleLocked ||
                    !likesLockedForCycle
                ) {
                    setState(
                        STATES.WAITING_FOR_CHEST
                    );

                    return;
                }

                if (!updateBroadcastSafety()) {
                    return;
                }

                if (
                    settings.openingChatEnabled &&
                    !openingChatSent
                ) {
                    sendOpeningAnnouncement();
                }

                /* Never reread likes here. The API snapshot below is the
                 * authority for this direct server-side open. */
                if (
                    !soundPlayedForCycle &&
                    settings.openSoundEnabled
                ) {
                    await playCustomOpenSound();
                    soundPlayedForCycle = true;
                }

                if (chestApiRequestInFlight) {
                    return;
                }

                await refreshChestApiSnapshot(true);

                const openResult =
                    await openChestViaApi();

                if (openResult === "opened") {
                    setState(
                        STATES.WAITING_FOR_RAIN
                    );

                    return;
                }

                cycleLocked = false;
                likesLockedForCycle = false;
                currentLikes = null;
                lockedLikes = null;
                preOpenVerification = false;
                openingChatSent = false;

                setState(
                    STATES.WAITING_FOR_CHEST
                );

                return;

            case STATES.WAITING_FOR_RAIN:

                if (
                    clickMakeItRain()
                ) {
                    setState(
                        STATES.WAITING_FOR_TELL_THEM
                    );

                    return;
                }

                if (
                    Date.now() -
                        stateStartedAt >
                    15000
                ) {
                    setAction(
                        "Make It Rain timeout — continuing"
                    );

                    setState(
                        STATES.WAITING_FOR_TELL_THEM
                    );
                }

                return;

            case STATES.WAITING_FOR_TELL_THEM:

                if (
                    clickTellThem()
                ) {
                    await sleep(
                        500
                    );

                    setState(
                        STATES.WAITING_FOR_CHEST_RESET
                    );

                    return;
                }

                if (
                    Date.now() -
                        stateStartedAt >
                    8000
                ) {
                    setAction(
                        "Tell Them timeout — waiting for chest reset"
                    );

                    setState(
                        STATES.WAITING_FOR_CHEST_RESET
                    );
                }

                return;

            case STATES.WAITING_FOR_CHEST_RESET: {

                /*
                 * Do not reread likes.
                 */
                const resetState = getChestState();

                if (resetState === "UNKNOWN") {
                    if (chestOpenConfirmedForCycle) {
                        if (lastAction !== "API open confirmed — continuing Winners cleanup despite unknown chest state") {
                            setAction(
                                "API open confirmed — continuing Winners cleanup despite unknown chest state"
                            );
                        }
                        setState(
                            STATES.WAITING_FOR_WINNERS
                        );
                        return;
                    }

                    if (lastAction !== "Chest state UNKNOWN — waiting for reset detection") {
                        setAction("Chest state UNKNOWN — waiting for reset detection");
                    }
                    return;
                }

                if (
                    resetState === "UNAVAILABLE"
                ) {
                    setAction(
                        "Chest reset detected"
                    );

                    setState(
                        STATES.WAITING_FOR_WINNERS
                    );

                    return;
                }

                if (
                    findWinnersPanel()
                ) {
                    setState(
                        STATES.CLOSING_WINNERS
                    );

                    return;
                }

                if (
                    Date.now() -
                        stateStartedAt >
                    15000
                ) {
                    setAction(
                        "Chest reset timeout — checking Winners"
                    );

                    setState(
                        STATES.WAITING_FOR_WINNERS
                    );
                }

                return;
            }

            case STATES.WAITING_FOR_WINNERS:
                {
                    if (
                        getChestState() === "UNKNOWN" &&
                        !chestOpenConfirmedForCycle
                    ) {
                        if (lastAction !== "Chest state UNKNOWN — waiting for Winners cleanup") {
                            setAction("Chest state UNKNOWN — waiting for Winners cleanup");
                        }
                        return;
                    }

                    const winners =
                        findWinnersPanel();

                    if (winners) {
                        winnerCloseAttempts =
                            0;

                        setState(
                            STATES.CLOSING_WINNERS
                        );

                        return;
                    }

                    if (
                        Date.now() -
                            stateStartedAt >
                        12000
                    ) {
                        setAction(
                            "No Winners panel detected — cleanup"
                        );

                        setState(
                            STATES.CLEANUP
                        );
                    }

                    return;
                }

            case STATES.CLOSING_WINNERS:

                if (
                    await closeWinnersPanel()
                ) {
                    setState(
                        STATES.CLEANUP
                    );
                }

                return;

            case STATES.CLEANUP:

                if (
                    getChestState() === "UNKNOWN" &&
                    !chestOpenConfirmedForCycle
                ) {
                    if (lastAction !== "Chest state UNKNOWN — waiting for cleanup") {
                        setAction("Chest state UNKNOWN — waiting for cleanup");
                    }
                    return;
                }

                if (
                    isChestModalOpen()
                ) {
                    const closed =
                        await closeTreasureChestModal();

                    if (!closed) {
                        return;
                    }
                }

                if (
                    findWinnersPanel()
                ) {
                    const closed =
                        await closeWinnersPanel();

                    if (!closed) {
                        return;
                    }
                }

                /*
                 * At this point the chest panel and Winners panel are
                 * both confirmed closed, so this is a completed chest.
                 * Record it once, before clearing the cycle values.
                 */
                completeChestCycle();
                addOpenedChestLog();
                renderChestLog();

                openedChestRecordedForCycle =
                    false;

                currentLikes =
                    null;

                lockedLikes =
                    null;

                likesLockedForCycle =
                    false;

                cycleLocked =
                    false;

                preOpenVerification = false;

                openingChatSent =
                    false;

                chestTimerEnd =
                    null;

                openingTimerEnd =
                    null;

                winnerCloseAttempts =
                    0;

                /*
                 * Preserve lastCheckedLikes until the next fresh
                 * cycle. This makes it possible to see the last
                 * actual chest value in the helper/footer.
                 */

                recoveryStartedAt =
                    Date.now();

                /*
                 * Recheck Timer OFF: after a chest has finished opening,
                 * immediately establish the next chest availability check.
                 *
                 * If YouNow has already reset the chest and it is AVAILABLE
                 * right now, seed the OFF-mode edge detector as if the chest
                 * had just been UNAVAILABLE. The next 500 ms poll will then
                 * perform exactly one fresh likes check.
                 *
                 * If it is still UNAVAILABLE, leave the detector at
                 * UNAVAILABLE so the next real AVAILABLE transition will
                 * trigger the next check. No timer is created.
                 */
                const postOpenChestState =
                    getChestState();

                if (!settings.timerEnabled) {
                    chestTimerEnd = null;
                    offModeCheckedForAvailableChest = false;

                    if (postOpenChestState === "AVAILABLE") {
                        lastObservedChestState = "UNAVAILABLE";
                        setAction(
                            `Cycle ${cycle} complete — chest already AVAILABLE; checking again now`
                        );
                    } else {
                        lastObservedChestState =
                            postOpenChestState === "UNAVAILABLE"
                                ? "UNAVAILABLE"
                                : "UNKNOWN";

                        setAction(
                            `Cycle ${cycle} complete — waiting for chest to become AVAILABLE`
                        );
                    }
                } else {
                    setAction(
                        `Cycle ${cycle} complete — waiting for next chest`
                    );
                }

                setState(
                    STATES.WAITING_FOR_CHEST
                );

                return;

            case STATES.OFF:
            default:
                return;
        }
    }

    /*
     * ============================================================
     * RECOVERY
     * ============================================================
     */

    function recovery() {

        if (
            !settings.enabled
        ) {
            return;
        }

        if (
            state ===
                STATES.READING_LIKES ||
            state ===
                STATES.CLOSING_BELOW_TARGET ||
            state ===
                STATES.OPENING_VIA_API ||
            state ===
                STATES.WAITING_FOR_RAIN ||
            state ===
                STATES.WAITING_FOR_TELL_THEM
        ) {
            return;
        }

        /*
         * The Open/Cancel Treasure Chest modal is separate from the
         * sidebar check panel. Only Cancel is used here.
         */
        if (
            isChestModalOpen() &&
            (
                state ===
                    STATES.WAITING_FOR_OPEN_DELAY ||
                state ===
                    STATES.CLEANUP
            )
        ) {
            closeTreasureChestModal();

            return;
        }

        if (
            Date.now() -
                recoveryStartedAt >
            120000
        ) {
            currentLikes =
                null;

            lockedLikes =
                null;

            likesLockedForCycle =
                false;

            cycleLocked =
                false;

            openingChatSent =
                false;

            openedChestRecordedForCycle =
                false;

            chestTimerEnd =
                null;

            openingTimerEnd =
                null;

            winnerCloseAttempts =
                0;

            recoveryStartedAt =
                Date.now();

            setAction(
                "Recovery reset — waiting for next chest"
            );

            setState(
                STATES.WAITING_FOR_CHEST
            );
        }
    }

    /*
     * ============================================================
     * CSS
     * ============================================================
     */

    function installCSS() {
        const css = `
            #younow-chest-helper-v946 {
                position:fixed;
                top:90px;
                right:20px;
                width:400px;
                max-width:calc(100vw - 30px);
                max-height:calc(100vh - 30px);
                z-index:2147483646;
                background:#171717;
                color:#f2f2f2;
                border:1px solid #444;
                border-radius:10px;
                box-shadow:0 8px 30px rgba(0,0,0,.45);
                font-family:Arial,Helvetica,sans-serif;
                font-size:13px;
                overflow:hidden;
            }

            #younow-chest-helper-v946 .ych-header {
                display:flex;
                align-items:center;
                justify-content:space-between;
                padding:9px 10px;
                background:#222;
                border-bottom:1px solid #444;
                cursor:move;
                user-select:none;
            }

            #younow-chest-helper-v946 .ych-title {
                display:flex;
                align-items:center;
                gap:7px;
                font-weight:700;
            }

            #younow-chest-helper-v946 .ych-version {
                color:#999;
                font-size:11px;
                font-weight:400;
            }

            #younow-chest-helper-v946 .ych-header-buttons {
                display:flex;
                gap:4px;
            }

            #younow-chest-helper-v946 .ych-head-btn {
                width:27px;
                height:25px;
                border:1px solid #555;
                border-radius:5px;
                background:#333;
                color:#fff;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-body {
                padding:10px;
                overflow-y:auto;
                max-height:calc(100vh - 110px);
            }

            #younow-chest-helper-v946.ych-minimized .ych-body {
                display:none;
            }

            #younow-chest-helper-v946.ych-maximized {
                width:min(540px,calc(100vw - 20px));
                max-width:calc(100vw - 20px);
                max-height:calc(100vh - 20px);
                top:10px;
                right:10px;
            }

            #younow-chest-helper-v946.ych-maximized .ych-body {
                max-height:calc(100vh - 75px);
            }

            #younow-chest-helper-v946 .ych-section {
                margin-bottom:10px;
                padding:9px;
                background:#202020;
                border:1px solid #363636;
                border-radius:7px;
            }

            #younow-chest-helper-v946 .ych-section-title {
                margin-bottom:7px;
                color:#aaa;
                font-size:11px;
                font-weight:700;
                text-transform:uppercase;
                letter-spacing:.5px;
            }

            #younow-chest-helper-v946 .ych-row {
                display:grid;
                grid-template-columns:42% 58%;
                gap:5px;
                padding:3px 0;
                align-items:start;
            }

            #younow-chest-helper-v946 .ych-row span {
                color:#aaa;
            }

            #younow-chest-helper-v946 .ych-row strong {
                min-width:0;
                overflow-wrap:anywhere;
                color:#fff;
            }

            #younow-chest-helper-v946 .ych-field {
                display:block;
                margin-bottom:8px;
                color:#ccc;
                font-size:12px;
            }

            #younow-chest-helper-v946 input[type="number"],
            #younow-chest-helper-v946 textarea {
                box-sizing:border-box;
                width:100%;
                margin-top:4px;
                padding:6px;
                background:#111;
                color:#fff;
                border:1px solid #555;
                border-radius:5px;
                font-family:inherit;
                font-size:12px;
            }

            #younow-chest-helper-v946 textarea {
                resize:vertical;
            }

            #younow-chest-helper-v946 .ych-check {
                display:flex;
                gap:7px;
                align-items:center;
                margin:7px 0;
                color:#ccc;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-check input {
                margin:0;
            }

            #younow-chest-helper-v946 .ych-buttons {
                display:grid;
                grid-template-columns:90px 1fr;
                gap:7px;
                margin-bottom:10px;
            }

            #younow-chest-helper-v946 .ych-buttons button {
                min-height:34px;
                border:1px solid #555;
                border-radius:6px;
                background:#333;
                color:#fff;
                font-weight:700;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-off {
                background:#4b2222 !important;
            }

            /*
             * Restored footer.
             */
            #younow-chest-helper-v946 .ych-footer {
                padding:8px 10px;
                background:#151515;
                border-top:1px solid #3b3b3b;
                color:#888;
                font-size:10px;
                line-height:1.5;
                text-align:center;
            }

            #younow-chest-helper-v946 .ych-footer strong {
                color:#aaa;
            }

            #younow-chest-helper-v946 .ych-sound-section {
                margin-top:10px;
                padding-top:10px;
                border-top:1px solid rgba(255,255,255,0.08);
            }

            #younow-chest-helper-v946 .ych-sound-name {
                margin-top:6px;
                font-size:12px;
                opacity:0.85;
                overflow:hidden;
                text-overflow:ellipsis;
                white-space:nowrap;
            }

            #younow-chest-helper-v946 .ych-sound-buttons {
                display:flex;
                flex-wrap:wrap;
                gap:6px;
                margin-top:7px;
            }

            #younow-chest-helper-v946 .ych-log-wrap {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:8px;
                margin-bottom:7px;
            }

            #younow-chest-helper-v946 .ych-log-count {
                color:#888;
                font-size:10px;
            }

            #younow-chest-helper-v946 .ych-log-reset {
                min-height:25px;
                padding:3px 8px;
                border:1px solid #555;
                border-radius:5px;
                background:#333;
                color:#fff;
                font-size:11px;
                font-weight:700;
                cursor:pointer;
            }

            #younow-chest-helper-v946 .ych-log {
                max-height:220px;
                overflow-y:auto;
                padding-right:4px;
                border:1px solid #333;
                border-radius:5px;
                background:#111;
            }

            #younow-chest-helper-v946 .ych-log-entry {
                padding:7px;
                border-bottom:1px solid #2f2f2f;
            }

            #younow-chest-helper-v946 .ych-log-entry:last-child {
                border-bottom:0;
            }

            #younow-chest-helper-v946 .ych-log-top {
                display:flex;
                justify-content:space-between;
                gap:8px;
                color:#ddd;
            }

            #younow-chest-helper-v946 .ych-log-top span {
                color:#8fd18f;
                font-size:10px;
                font-weight:700;
            }

            #younow-chest-helper-v946 .ych-log-time {
                margin-top:2px;
                color:#777;
                font-size:10px;
            }

            #younow-chest-helper-v946 .ych-log-details {
                display:flex;
                flex-wrap:wrap;
                gap:5px 10px;
                margin-top:4px;
                color:#999;
                font-size:10px;
            }

            #younow-chest-helper-v946 .ych-log-details b {
                color:#ddd;
            }

            #younow-chest-helper-v946 .ych-log-empty {
                padding:12px 8px;
                color:#777;
                text-align:center;
                font-size:11px;
            }

            #younow-chest-helper-v946 .ych-help {
                padding:7px;
                background:#111;
                border-radius:5px;
                color:#999;
                font-size:10px;
                line-height:1.5;
            }
        `;

        try {
            GM_addStyle(css);
        } catch (_) {
            const style =
                document.createElement(
                    "style"
                );

            style.textContent =
                css;

            document.head.appendChild(
                style
            );
        }
    }

    /*
     * ============================================================
     * CREATE HELPER PANEL
     * ============================================================
     */

    function createHelperPanel() {

        if (
            document.getElementById(
                "younow-chest-helper-v946"
            )
        ) {
            helperPanel =
                document.getElementById(
                    "younow-chest-helper-v946"
                );

            return;
        }

        helperPanel =
            document.createElement(
                "div"
            );

        helperPanel.id =
            "younow-chest-helper-v946";

        helperPanel.innerHTML = `
            <div class="ych-header">

                <div class="ych-title">
                    <span>YouNow Auto Chest Helper</span>
                    <span class="ych-version">
                        v${VERSION}
                    </span>
                </div>

                <div class="ych-header-buttons">

                    <button
                        type="button"
                        class="ych-head-btn"
                        data-action="minimize"
                    >−</button>

                    <button
                        type="button"
                        class="ych-head-btn"
                        data-action="maximize"
                    >□</button>

                </div>

            </div>

            <div class="ych-body">

                <div class="ych-section">

                    <div class="ych-row">
                        <span>Status</span>
                        <strong data-field="status">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>State</span>
                        <strong data-field="state">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Cycle</span>
                        <strong data-field="cycle">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Last Action</span>
                        <strong data-field="action">—</strong>
                    </div>

                </div>

                <div class="ych-section">

                    <div class="ych-section-title">
                        Chest
                    </div>

                    <div class="ych-row">
                        <span>Chest State</span>
                        <strong data-field="chest">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Last Chest Check</span>
                        <strong data-field="last-check">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Current Likes</span>
                        <strong data-field="likes">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Target</span>
                        <strong data-field="target">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Locked Likes</span>
                        <strong data-field="locked">—</strong>
                    </div>

                </div>

                <div class="ych-section">

                    <div class="ych-section-title">
                        Timers
                    </div>

                    <div class="ych-row">
                        <span>Recheck</span>
                        <strong data-field="recheck">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Opening Delay</span>
                        <strong data-field="opening">—</strong>
                    </div>

                    <div class="ych-row">
                        <span>Auto Info</span>
                        <strong data-field="auto-info">—</strong>
                    </div>

                </div>

                <div class="ych-section">

                    <div class="ych-section-title">
                        Variables
                    </div>

                    <label class="ych-field">
                        Fallback Threshold Likes
                        <input
                            type="number"
                            min="500"
                            step="1"
                            data-setting="threshold"
                        >
                    </label>

                    <label class="ych-field">
                        Recheck Seconds
                        <input
                            type="number"
                            min="1"
                            step="1"
                            data-setting="recheckSeconds"
                        >
                    </label>

                    <label class="ych-field">
                        Opening Delay Seconds
                        <input
                            type="number"
                            min="0"
                            step="1"
                            data-setting="openingDelaySeconds"
                        >
                    </label>

                    <label class="ych-field">
                        Auto Info Minutes
                        <input
                            type="number"
                            min="1"
                            step="1"
                            data-setting="autoInfoMinutes"
                        >
                    </label>

                    <label class="ych-field">
                        Opening Chat Message
                        <textarea
                            rows="3"
                            data-setting="openingChatMessage"
                        ></textarea>
                    </label>

                    <div class="ych-sound-section">
                        <div class="ych-section-title">Chest Open Sound</div>
                        <label class="ych-check">
                            <input type="checkbox" data-setting="openSoundEnabled">
                            Play custom sound just before chest opens
                        </label>
                        <div class="ych-sound-name" data-field="open-sound-name">No sound selected</div>
                        <div class="ych-sound-buttons">
                            <button type="button" data-action="select-open-sound">SELECT SOUND</button>
                            <button type="button" data-action="test-open-sound">TEST SOUND</button>
                            <button type="button" data-action="clear-open-sound">CLEAR</button>
                        </div>
                        <label class="ych-field">
                            Sound Volume
                            <input type="range" min="0" max="100" step="1" data-setting="openSoundVolume">
                            <span data-field="open-sound-volume">80%</span>
                        </label>
                        <input type="file" accept="audio/*" data-action="open-sound-file" style="display:none;">
                    </div>

                    <label class="ych-field">
                        Auto Info Message
                        <textarea
                            rows="3"
                            data-setting="autoInfoMessage"
                        ></textarea>
                    </label>

                    <label class="ych-check">
                        <input
                            type="checkbox"
                            data-setting="timerEnabled"
                        >
                        Chest Recheck Timer ON
                    </label>

                    <label class="ych-check">
                        <input
                            type="checkbox"
                            data-setting="openingChatEnabled"
                        >
                        Opening Chat ON
                    </label>

                    <label class="ych-check">
                        <input
                            type="checkbox"
                            data-setting="autoInfoEnabled"
                        >
                        Auto Chest Information ON
                    </label>

                </div>

                <div class="ych-section">

                    <div class="ych-log-wrap">
                        <div class="ych-section-title" style="margin:0;">
                            Opened Chests
                            <span class="ych-log-count" data-field="chest-log-count">0</span>
                        </div>

                        <button
                            type="button"
                            class="ych-log-reset"
                            data-action="reset-log"
                        >RESET LOG</button>
                    </div>

                    <div
                        class="ych-log"
                        data-field="chest-log"
                    ></div>

                </div>

                <div class="ych-buttons">

                    <button
                        type="button"
                        data-action="toggle"
                    >ON</button>

                    <button
                        type="button"
                        data-action="save"
                    >SAVE SETTINGS</button>

                </div>

                <div class="ych-help">

                    <b>Chat variables</b><br>
                    {likes} = last actual chest likes check<br>
                    {threshold} = configured target<br>
                    {lockedLikes} = likes locked for opening<br>
                    {delay} = opening delay<br>
                    {cycle} = cycle number<br>
                    {remaining} = active timer remaining

                </div>

            </div>

            <div class="ych-footer">
                <strong>Made for Lolitskayyla by Cenastor</strong>
                &nbsp;•&nbsp;
                v${VERSION}
                &nbsp;•&nbsp;
                Last Chest Check:
                <span data-field="footer-likes">—</span>
            </div>
        `;

        document.body.appendChild(
            helperPanel
        );

        applyPanelSettings();

        applyPanelPosition();

        applyPanelState();

        attachPanelEvents();

        renderChestLog();
        updateUI();
    }

    /*
     * ============================================================
     * PANEL SETTINGS
     * ============================================================
     */

    function applyPanelSettings() {
        if (!helperPanel) {
            return;
        }

        helperPanel.querySelectorAll(
            "[data-setting]"
        ).forEach(
            element => {
                const key =
                    element.dataset.setting;

                if (
                    element.type ===
                    "checkbox"
                ) {
                    element.checked =
                        !!settings[key];
                } else if (
                    key === "openSoundVolume"
                ) {
                    element.value =
                        Math.round(
                            clamp(
                                Number(settings[key]),
                                0,
                                1
                            ) * 100
                        );
                } else {
                    element.value =
                        settings[key] ??
                        "";
                }
            }
        );

        const toggle =
            helperPanel.querySelector(
                '[data-action="toggle"]'
            );

        if (toggle) {
            toggle.textContent =
                settings.enabled
                    ? "ON"
                    : "OFF";

            toggle.classList.toggle(
                "ych-off",
                !settings.enabled
            );
        }
    }

    function savePanelSettings() {
        if (!helperPanel) {
            return;
        }

        helperPanel.querySelectorAll(
            "[data-setting]"
        ).forEach(
            element => {
                const key =
                    element.dataset.setting;

                if (
                    element.type ===
                    "checkbox"
                ) {
                    settings[key] =
                        element.checked;
                } else if (
                    key === "openSoundVolume"
                ) {
                    settings[key] =
                        clamp(
                            Number(element.value) / 100,
                            0,
                            1
                        );
                } else {
                    settings[key] =
                        element.value;
                }
            }
        );

        settings.threshold =
            clampThreshold(
                settings.threshold
            );

        settings.recheckSeconds =
            Math.max(
                1,
                parseInt(
                    settings.recheckSeconds,
                    10
                ) || 1
            );

        settings.openingDelaySeconds =
            Math.max(
                0,
                parseInt(
                    settings.openingDelaySeconds,
                    10
                ) || 0
            );

        settings.autoInfoMinutes =
            Math.max(
                1,
                parseInt(
                    settings.autoInfoMinutes,
                    10
                ) || 1
            );

        saveSettings();

        if (!settings.timerEnabled) {
            chestTimerEnd = null;
            /* Switching the timer OFF starts a new AVAILABLE-edge check, not a timer. */
            lastObservedChestState = "UNKNOWN";
            offModeCheckedForAvailableChest = false;
        }

        scheduleAutoInfo();

        setAction(
            "Settings saved"
        );

        applyPanelSettings();
    }

    function toggleEnabled() {
        if (!settings.enabled && !updateBroadcastSafety()) {
            setAction("Cannot turn automation ON — END button not found");
            return;
        }

        settings.enabled =
            !settings.enabled;

        saveSettings();

        if (
            !settings.enabled
        ) {
            state =
                STATES.OFF;

            cycleLocked =
                false;

            likesLockedForCycle =
                false;

            chestTimerEnd =
                null;

            openingTimerEnd =
                null;
            autoInfoNextAt = null;
            preOpenVerification = false;
            offModeCheckedForAvailableChest = false;

            setAction(
                "Helper turned OFF"
            );
        } else {
            currentLikes =
                null;

            lockedLikes =
                null;

            likesLockedForCycle =
                false;

            cycleLocked =
                false;

            openingChatSent =
                false;

            openedChestRecordedForCycle =
                false;

            soundPlayedForCycle =
                false;

            state =
                STATES.WAITING_FOR_CHEST;

            recoveryStartedAt =
                Date.now();

            setAction(
                "Helper turned ON"
            );
        }

        applyPanelSettings();
    }

    /*
     * ============================================================
     * PANEL DRAGGING
     * ============================================================
     */

    function clampPosition(
        x,
        y
    ) {
        if (!helperPanel) {
            return {
                x,
                y
            };
        }

        const rect =
            helperPanel.getBoundingClientRect();

        return {
            x: Math.min(
                Math.max(
                    0,
                    x
                ),
                Math.max(
                    0,
                    window.innerWidth -
                        rect.width
                )
            ),

            y: Math.min(
                Math.max(
                    0,
                    y
                ),
                Math.max(
                    0,
                    window.innerHeight -
                        rect.height
                )
            )
        };
    }

    function applyPanelPosition() {
        if (!helperPanel) {
            return;
        }

        if (
            Number.isFinite(
                Number(
                    settings.panelX
                )
            ) &&
            Number.isFinite(
                Number(
                    settings.panelY
                )
            )
        ) {
            const position =
                clampPosition(
                    Number(
                        settings.panelX
                    ),
                    Number(
                        settings.panelY
                    )
                );

            helperPanel.style.left =
                `${position.x}px`;

            helperPanel.style.top =
                `${position.y}px`;

            helperPanel.style.right =
                "auto";
        }
    }

    function beginDrag(
        event
    ) {
        if (
            event.button !== 0 ||
            !helperPanel
        ) {
            return;
        }

        if (
            event.target.closest(
                "button,input,textarea,select"
            )
        ) {
            return;
        }

        const rect =
            helperPanel.getBoundingClientRect();

        dragState.active =
            true;

        dragState.offsetX =
            event.clientX -
            rect.left;

        dragState.offsetY =
            event.clientY -
            rect.top;

        helperPanel.style.left =
            `${rect.left}px`;

        helperPanel.style.top =
            `${rect.top}px`;

        helperPanel.style.right =
            "auto";

        event.preventDefault();
    }

    function dragPanel(
        event
    ) {
        if (
            !dragState.active ||
            !helperPanel
        ) {
            return;
        }

        const position =
            clampPosition(
                event.clientX -
                    dragState.offsetX,

                event.clientY -
                    dragState.offsetY
            );

        helperPanel.style.left =
            `${position.x}px`;

        helperPanel.style.top =
            `${position.y}px`;
    }

    function endDrag() {
        if (
            !dragState.active ||
            !helperPanel
        ) {
            return;
        }

        dragState.active =
            false;

        const rect =
            helperPanel.getBoundingClientRect();

        const position =
            clampPosition(
                rect.left,
                rect.top
            );

        settings.panelX =
            position.x;

        settings.panelY =
            position.y;

        saveSettings();
    }

    function toggleMinimize() {
        settings.minimized =
            !settings.minimized;

        if (
            settings.minimized
        ) {
            settings.maximized =
                false;
        }

        saveSettings();

        applyPanelState();
    }

    function toggleMaximize() {
        settings.maximized =
            !settings.maximized;

        if (
            settings.maximized
        ) {
            settings.minimized =
                false;
        }

        saveSettings();

        applyPanelState();
    }

    function applyPanelState() {
        if (!helperPanel) {
            return;
        }

        helperPanel.classList.toggle(
            "ych-minimized",
            !!settings.minimized
        );

        helperPanel.classList.toggle(
            "ych-maximized",
            !!settings.maximized
        );
    }

    function attachPanelEvents() {
        if (!helperPanel) {
            return;
        }

        helperPanel.querySelector(
            ".ych-header"
        )?.addEventListener(
            "pointerdown",
            beginDrag
        );

        helperPanel.querySelector(
            '[data-action="toggle"]'
        )?.addEventListener(
            "click",
            toggleEnabled
        );

        helperPanel.querySelector(
            '[data-action="save"]'
        )?.addEventListener(
            "click",
            savePanelSettings
        );

        helperPanel.querySelector(
            '[data-action="select-open-sound"]'
        )?.addEventListener(
            "click",
            () => helperPanel.querySelector(
                '[data-action="open-sound-file"]'
            )?.click()
        );

        helperPanel.querySelector(
            '[data-action="open-sound-file"]'
        )?.addEventListener(
            "change",
            handleOpenSoundFile
        );

        helperPanel.querySelector(
            '[data-action="test-open-sound"]'
        )?.addEventListener(
            "click",
            testOpenSound
        );

        helperPanel.querySelector(
            '[data-action="clear-open-sound"]'
        )?.addEventListener(
            "click",
            clearCustomOpenSound
        );

        helperPanel.querySelector(
            '[data-setting="openSoundVolume"]'
        )?.addEventListener(
            "input",
            event => {
                settings.openSoundVolume =
                    clamp(
                        Number(event.target.value) / 100,
                        0,
                        1
                    );

                if (soundAudio) {
                    soundAudio.volume =
                        settings.openSoundVolume;
                }

                saveSettings();
                updateUI();
            }
        );


        helperPanel.querySelector(
            '[data-action="reset-log"]'
        )?.addEventListener(
            "click",
            () => {
                if (
                    window.confirm(
                        "Reset the opened chest history? This will not change your settings or automation."
                    )
                ) {
                    resetChestLog();
                }
            }
        );

        helperPanel.querySelector(
            '[data-action="minimize"]'
        )?.addEventListener(
            "click",
            toggleMinimize
        );

        helperPanel.querySelector(
            '[data-action="maximize"]'
        )?.addEventListener(
            "click",
            toggleMaximize
        );

        document.addEventListener(
            "pointermove",
            dragPanel
        );

        document.addEventListener(
            "pointerup",
            endDrag
        );
    }

    /*
     * ============================================================
     * ELEMENT INFORMATION
     * ============================================================
     */

    function elementInfo(
        element
    ) {
        if (!element) {
            return "Not found";
        }

        const tag =
            element.tagName
                ?.toLowerCase() ||
            "element";

        const id =
            element.id
                ? `#${element.id}`
                : "";

        const classes =
            typeof element.className ===
                "string" &&
            element.className
                ? `.${element.className
                    .trim()
                    .split(/\s+/)
                    .slice(
                        0,
                        2
                    )
                    .join(".")}`
                : "";

        return (
            `${tag}${id}${classes}`
        );
    }

    /*
     * ============================================================
     * UPDATE UI
     * ============================================================
     */

    function updateUI() {
        if (
            !helperPanel ||
            !document.body.contains(
                helperPanel
            )
        ) {
            return;
        }

        const field =
            name =>
                helperPanel.querySelector(
                    `[data-field="${name}"]`
                );

        const setField =
            (
                name,
                value
            ) => {
                const element =
                    field(name);

                if (element) {
                    element.textContent =
                        value;
                }
            };

        setField(
            "status",
            settings.enabled
                ? "ON"
                : "OFF"
        );

        setField(
            "state",
            state
        );

        setField(
            "cycle",
            String(cycle)
        );

        setField(
            "action",
            lastAction
        );

        renderChestLog();

        const freshChestApi =
            getFreshChestApiSnapshot();

        setField(
            "chest",
            getChestStateLabel()
        );

        /*
         * The important distinction:
         *
         * Last Chest Check = the latest likes reading used by a chest check.
         */
        setField(
            "last-check",
            lastCheckedLikes ===
                null
                ? "—"
                : formatLikes(
                    lastCheckedLikes
                )
        );

        setField(
            "likes",
            freshChestApi &&
                freshChestApi.likes !== null
                ? formatLikes(freshChestApi.likes)
                : currentLikes !== null
                    ? formatLikes(currentLikes)
                    : "—"
        );

        setField(
            "target",
            formatLikes(
                getCurrentChestThreshold()
            )
        );

        setField(
            "locked",
            lockedLikes ===
                null
                ? "—"
                : formatLikes(
                    lockedLikes
                )
        );

        setField(
            "recheck",
            chestTimerEnd
                ? formatTimer(
                    remainingSeconds(
                        chestTimerEnd
                    )
                )
                : "—"
        );

        setField(
            "opening",
            openingTimerEnd
                ? formatTimer(
                    remainingSeconds(
                        openingTimerEnd
                    )
                )
                : "—"
        );

        setField(
            "auto-info",
            !settings.autoInfoEnabled
                ? "OFF"
                : autoInfoNextAt
                    ? formatTimer(
                        remainingSeconds(
                            autoInfoNextAt
                        )
                    )
                    : "Starting..."
        );

        const soundNameField =
            helperPanel.querySelector(
                '[data-field="open-sound-name"]'
            );

        if (soundNameField) {
            soundNameField.textContent =
                customOpenSoundName ||
                "No sound selected";
            soundNameField.title =
                customOpenSoundName ||
                "No sound selected";
        }

        const soundVolumeField =
            helperPanel.querySelector(
                '[data-field="open-sound-volume"]'
            );

        if (soundVolumeField) {
            soundVolumeField.textContent =
                `${Math.round(
                    clamp(
                        Number(settings.openSoundVolume),
                        0,
                        1
                    ) * 100
                )}%`;
        }

        setField(
            "footer-likes",
            lastCheckedLikes ===
                null
                ? "—"
                : formatLikes(
                    lastCheckedLikes
                )
        );

        const toggle =
            helperPanel.querySelector(
                '[data-action="toggle"]'
            );

        if (toggle) {
            toggle.textContent =
                settings.enabled
                    ? "ON"
                    : "OFF";

            toggle.classList.toggle(
                "ych-off",
                !settings.enabled
            );
        }

        applyPanelState();
    }

    /*
     * ============================================================
     * STARTUP
     * ============================================================
     */

    function start() {

        if (
            !document.body
        ) {
            setTimeout(
                start,
                500
            );

            return;
        }

        installCSS();

        /* Keep the existing working helper panel creation method intact. */
        createHelperPanel();

        /* Audio is optional and initializes only after the panel exists. */
        loadCustomOpenSound()
            .then(() => updateUI())
            .catch(error => {
                console.warn(
                    "[Chest Helper] Custom sound initialization failed:",
                    error
                );
            });

        updateBroadcastSafety();

        if (ownBroadcastActive && settings.enabled) {
            scheduleAutoInfo();
        }

        setAction(
            settings.enabled
                ? (ownBroadcastActive ? "Helper ready — waiting for chest" : "NOT LIVE — automation stopped")
                : "Helper disabled"
        );

        /*
         * Main polling loop.
         *
         * No MutationObserver.
         */
        setInterval(
            async () => {
                /*
                 * processState() contains awaits. Never allow two
                 * state-machine executions to overlap.
                 */
                if (processStateBusy) {
                    return;
                }

                processStateBusy = true;

                try {
                    await processState();

                    recovery();

                    updateUI();
                } catch (error) {
                    console.error(
                        "[Chest Helper] Main loop error:",
                        error
                    );

                    setAction(
                        `Runtime error: ${
                            error?.message ||
                            error
                        }`
                    );
                } finally {
                    processStateBusy = false;
                }
            },
            500
        );

        /*
         * Faster UI refresh for timers.
         */
        setInterval(
            () => {
                try {
                    updateUI();
                } catch (_) {}
            },
            250
        );
    }

    start();

})();
