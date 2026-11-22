// ==UserScript==
// @name         YouNow Viewer Toolkit
// @namespace    https://younow.com/
// @version      1.0
// @description  Viewer-side stream controls, focus modes, visible stats, and quick link copying.
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

    const VERSION = "1.0";
    const ROOT_ID = "younow-viewer-toolkit-v10";
    const STORE_KEY = "younowViewerToolkit_v10";
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const DEFAULTS = {
        minimized: false,
        left: null,
        top: 90,
        theatre: false,
        chatHidden: false,
        chatZoom: 1
    };
    const SPEEDS = [1, 1.25, 1.5, 2];

    let settings = loadSettings();
    let panel = null;
    let chatTarget = null;
    let theatreTarget = null;
    let infoTimer = null;
    let lastVideo = null;

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
        if (isVisible(exact)) return exact;
        return Array.from(document.querySelectorAll("textarea,input,[contenteditable='true']"))
            .find(element => {
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

    function parseMetric(text, kind) {
        const value = String(text || "").replace(/,/g, "");
        const suffixNumber = "([0-9]+(?:\\.[0-9]+)?\\s*[kKmM]?)";
        const patterns = kind === "viewers"
            ? [new RegExp(suffixNumber + "\\s*(?:viewers?|watchers?|watching)\\b", "i"), new RegExp("\\b(?:viewers?|watchers?|watching)\\s*[:·-]?\\s*" + suffixNumber, "i")]
            : [new RegExp(suffixNumber + "\\s*likes?\\b", "i"), new RegExp("\\blikes?\\s*[:·-]?\\s*" + suffixNumber, "i")];
        for (const pattern of patterns) {
            const match = value.match(pattern);
            if (match) return match[1].replace(/\s+/g, "").toUpperCase();
        }
        return null;
    }

    // Search short visible labels first so unrelated page copy cannot dominate the result.
    function findVisibleMetric(kind) {
        const candidates = Array.from(document.querySelectorAll("[aria-label],[title],span,div,button"))
            .filter(isVisible)
            .map(element => {
                const text = [element.getAttribute("aria-label"), element.getAttribute("title"), textOf(element)]
                    .filter(Boolean).join(" ").slice(0, 100);
                return { element, text };
            })
            .filter(item => item.text && item.text.length <= 100)
            .sort((a, b) => a.text.length - b.text.length);
        for (const item of candidates) {
            const result = parseMetric(item.text, kind);
            if (result) return result;
        }
        return null;
    }

    function getBroadcastName() {
        const heading = Array.from(document.querySelectorAll("h1,[role='heading']"))
            .find(element => isVisible(element) && textOf(element));
        if (heading) return textOf(heading).slice(0, 80);
        return String(document.title || "YouNow broadcast")
            .replace(/\s*[|–-]\s*YouNow.*$/i, "").trim().slice(0, 80) || "YouNow broadcast";
    }

    function setField(name, value) {
        const element = panel?.querySelector(`[data-field="${name}"]`);
        if (element) element.textContent = value || "—";
    }

    function updateInfo() {
        if (!panel) return;
        const video = findVideo();
        const title = getBroadcastName();
        const viewers = findVisibleMetric("viewers");
        const likes = findVisibleMetric("likes");
        const live = Boolean(video && !video.paused && !video.ended);
        setField("name", title);
        setField("viewers", viewers ? viewers : "Not shown");
        setField("likes", likes ? likes : "Not shown");
        setField("status", video ? (live ? "Stream playing" : "Video ready") : "No video found");
        syncButtons();
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
        const speed = panel.querySelector('[data-action="speed"]');
        if (mute) mute.textContent = video?.muted ? "Unmute" : "Mute";
        if (theatre) theatre.classList.toggle("active", settings.theatre);
        if (chat) {
            chat.textContent = settings.chatHidden ? "Show chat" : "Hide chat";
            chat.classList.toggle("active", settings.chatHidden);
        }
        if (speed) speed.textContent = `${Number(video?.playbackRate || 1).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}× speed`;
    }

    function toggleMute() {
        const video = findVideo();
        if (!video) return setAction("No stream video found");
        video.muted = !video.muted;
        syncButtons();
        setAction(video.muted ? "Muted" : "Unmuted");
    }

    function cycleSpeed() {
        const video = findVideo();
        if (!video) return setAction("No stream video found");
        const current = Number(video.playbackRate || 1);
        const index = SPEEDS.findIndex(rate => Math.abs(rate - current) < 0.01);
        video.playbackRate = SPEEDS[(index + 1) % SPEEDS.length];
        syncButtons();
        setAction(`Playback ${video.playbackRate}×`);
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
            #${ROOT_ID} { position:fixed; right:16px; bottom:16px; width:274px; z-index:2147483646; color:#eef4ff; background:#111827; border:1px solid #334155; border-radius:12px; box-shadow:0 12px 34px rgba(0,0,0,.45); font:13px/1.4 Arial,Helvetica,sans-serif; overflow:hidden; }
            #${ROOT_ID} * { box-sizing:border-box; }
            #${ROOT_ID} .ynvt-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 11px; background:#1e293b; cursor:move; user-select:none; }
            #${ROOT_ID} .ynvt-title { font-weight:700; letter-spacing:.2px; }
            #${ROOT_ID} .ynvt-version { color:#94a3b8; font-size:10px; margin-left:4px; font-weight:400; }
            #${ROOT_ID} .ynvt-min { border:0; background:transparent; color:#cbd5e1; font-size:20px; cursor:pointer; line-height:1; }
            #${ROOT_ID} .ynvt-body { padding:10px; max-height:min(74vh,620px); overflow:auto; }
            #${ROOT_ID}.ynvt-minimized .ynvt-body { display:none; }
            #${ROOT_ID} .ynvt-info { display:grid; grid-template-columns:72px 1fr; gap:5px 8px; padding:8px; margin-bottom:8px; background:#0b1220; border-radius:8px; }
            #${ROOT_ID} .ynvt-label { color:#94a3b8; }
            #${ROOT_ID} .ynvt-value { min-width:0; overflow-wrap:anywhere; text-align:right; font-weight:600; }
            #${ROOT_ID} .ynvt-actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
            #${ROOT_ID} button.ynvt-button { min-height:34px; border:1px solid #3b4b62; border-radius:7px; color:#e2e8f0; background:#1e293b; cursor:pointer; font:600 12px Arial, sans-serif; }
            #${ROOT_ID} button.ynvt-button:hover { background:#29384e; border-color:#64748b; }
            #${ROOT_ID} button.ynvt-button.active { background:#164e63; border-color:#22d3ee; color:#cffafe; }
            #${ROOT_ID} .ynvt-subrow { display:flex; gap:6px; margin-top:6px; }
            #${ROOT_ID} .ynvt-subrow .ynvt-button { flex:1; }
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
        panel.innerHTML = `
            <div class="ynvt-head">
                <div><span class="ynvt-title">YouNow Viewer</span><span class="ynvt-version">v${VERSION}</span></div>
                <button type="button" class="ynvt-min" data-action="minimize" title="Minimize">−</button>
            </div>
            <div class="ynvt-body">
                <div class="ynvt-info">
                    <span class="ynvt-label">Broadcast</span><span class="ynvt-value" data-field="name">—</span>
                    <span class="ynvt-label">Status</span><span class="ynvt-value" data-field="status">—</span>
                    <span class="ynvt-label">Viewers</span><span class="ynvt-value" data-field="viewers">—</span>
                    <span class="ynvt-label">Likes</span><span class="ynvt-value" data-field="likes">—</span>
                </div>
                <div class="ynvt-actions">
                    <button type="button" class="ynvt-button" data-action="theatre">Theater mode</button>
                    <button type="button" class="ynvt-button" data-action="chat">Hide chat</button>
                    <button type="button" class="ynvt-button" data-action="mute">Mute</button>
                    <button type="button" class="ynvt-button" data-action="speed">1× speed</button>
                    <button type="button" class="ynvt-button" data-action="fullscreen">Fullscreen</button>
                    <button type="button" class="ynvt-button" data-action="copy">Copy link</button>
                </div>
                <div class="ynvt-subrow">
                    <button type="button" class="ynvt-button" data-action="zoom-out" title="Reduce chat text">Chat A−</button>
                    <button type="button" class="ynvt-button" data-action="zoom-in" title="Enlarge chat text">Chat A+</button>
                    <button type="button" class="ynvt-button" data-action="refresh">Refresh</button>
                </div>
                <div class="ynvt-shortcuts">T theater · C chat · M mute · F fullscreen</div>
                <div data-field="action">Ready</div>
                <div class="ynvt-foot">Stats are read from visible page text when available.</div>
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
        updateInfo();
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
                case "speed": cycleSpeed(); break;
                case "fullscreen": toggleFullscreen(); break;
                case "copy": copyLink(); break;
                case "zoom-out": setChatZoom(-0.1); break;
                case "zoom-in": setChatZoom(0.1); break;
                case "refresh": updateInfo(); setAction("Broadcast details refreshed"); break;
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
                const top = Math.max(0, Math.min(innerHeight - 40, moveEvent.clientY - offsetY));
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
        infoTimer = setInterval(updateInfo, 2500);
        window.addEventListener("pagehide", () => {
            clearInterval(infoTimer);
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
