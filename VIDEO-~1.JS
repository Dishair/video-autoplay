// ==UserScript==
// @name         Video Autoplay on Visible
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Проигрывает видео только когда оно реально видно на экране, пауза при скрытии, звук только у самого видимого. Работает на любом сайте.
// @author       You
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        visibleRatio: 0.6,     // доля площади видео, при которой считаем его "на экране"
        confirmDelayMs: 150,   // задержка перед стартом — фильтр от дёрганья вёрстки при подгрузке картинок
        maxVolume: 0.3,
        unmuteActive: true,    // включать звук у самого видимого видео
        onlyOneUnmuted: true,  // звук одновременно только у одного видео
        pauseOnHiddenTab: true,
        debug: false,
    };

    const log = (...args) => CONFIG.debug && console.log('[VideoAutoplay]', ...args);

    const state = new WeakMap();   // video -> { visible, timer }
    const known = new WeakSet();
    let currentlyUnmuted = null;

    const io = new IntersectionObserver(onIntersect, {
        threshold: Array.from({ length: 21 }, (_, i) => i / 20), // 0, 0.05 ... 1 — только чтобы получать события почаще
        rootMargin: '0px',
    });

    // Реальную видимость всегда считаем заново из getBoundingClientRect,
    // а не из intersectionRatio последнего события IntersectionObserver:
    // при резком прыжке скролла (клавиатурная навигация, "наверх", якоря)
    // следующее событие IO может прийти с задержкой, и кэшированное значение
    // окажется устаревшим — именно так видео, которое уже ушло с экрана,
    // могло продолжать играть.
    function computeRatio(video) {
        const rect = video.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 0;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const visibleHeight = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
        const visibleWidth = Math.min(rect.right, vw) - Math.max(rect.left, 0);
        if (visibleHeight <= 0 || visibleWidth <= 0) return 0;
        return (visibleWidth * visibleHeight) / (rect.width * rect.height);
    }

    function onIntersect(entries) {
        for (const entry of entries) scheduleRecheck(entry.target);
    }

    function scheduleRecheck(video) {
        const s = state.get(video);
        if (!s) return;
        clearTimeout(s.timer);
        s.timer = setTimeout(() => applyVisibility(video), CONFIG.confirmDelayMs);
    }

    function applyVisibility(video) {
        if (!document.body.contains(video)) return;

        if (CONFIG.pauseOnHiddenTab && document.hidden) {
            setVisible(video, false);
            return;
        }

        const visible = computeRatio(video) >= CONFIG.visibleRatio;
        setVisible(video, visible);
    }

    function setVisible(video, visible) {
        const s = state.get(video);
        s.visible = visible;

        if (visible) {
            play(video);
            maybeUnmute(video);
        } else {
            pause(video);
            if (currentlyUnmuted === video) {
                currentlyUnmuted = null;
                video.muted = true;
            }
        }
    }

    function play(video) {
        if (!video.paused) return;
        const p = video.play();
        if (p && p.catch) {
            p.catch((err) => {
                log('play() отклонён, пробую снова с muted:', err);
                video.muted = true;
                video.play().catch((e) => log('не удалось воспроизвести даже с muted:', e));
            });
        }
    }

    function pause(video) {
        if (!video.paused) video.pause();
    }

    // Снятие muted с уже играющего видео не требует пользовательского
    // жеста (жест нужен только чтобы ЗАПУСТИТЬ воспроизведение со звуком) —
    // если у видео стоит нативный autoplay+muted, оно уже играет тихо
    // к моменту, когда мы решаем включить звук.
    function maybeUnmute(video) {
        if (!CONFIG.unmuteActive) return;

        if (CONFIG.onlyOneUnmuted) {
            const best = pickMostVisible();
            if (best !== video) return;
            if (currentlyUnmuted && currentlyUnmuted !== video) {
                currentlyUnmuted.muted = true;
            }
            currentlyUnmuted = video;
        }

        video.muted = false;
        video.volume = Math.min(video.volume || CONFIG.maxVolume, CONFIG.maxVolume);
    }

    function pickMostVisible() {
        let best = null;
        let bestRatio = 0;
        document.querySelectorAll('video').forEach((video) => {
            const s = state.get(video);
            if (!s || !s.visible) return;
            const ratio = computeRatio(video);
            if (ratio > bestRatio) {
                bestRatio = ratio;
                best = video;
            }
        });
        return best;
    }

    function watch(video) {
        if (known.has(video)) return;
        known.add(video);
        state.set(video, { visible: false, timer: null });
        io.observe(video);
        scheduleRecheck(video);
        log('наблюдаю за новым видео', video);
    }

    function unwatch(video) {
        if (!known.has(video)) return;
        io.unobserve(video);
        clearTimeout(state.get(video)?.timer);
        state.delete(video);
        known.delete(video);
        if (currentlyUnmuted === video) currentlyUnmuted = null;
    }

    function scanExisting() {
        document.querySelectorAll('video').forEach(watch);
    }

    function recheckAllKnown() {
        document.querySelectorAll('video').forEach((v) => known.has(v) && scheduleRecheck(v));
    }

    let rafPending = false;
    // Подстраховка на случай, если IntersectionObserver не успел прислать
    // событие при резком/программном скролле (см. комментарий у computeRatio).
    function requestGlobalRecheck() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            recheckAllKnown();
        });
    }

    const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
            m.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                if (node.tagName === 'VIDEO') watch(node);
                node.querySelectorAll?.('video').forEach(watch);
            });
            m.removedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                if (node.tagName === 'VIDEO') unwatch(node);
                node.querySelectorAll?.('video').forEach(unwatch);
            });
        }
    });

    window.addEventListener('scroll', requestGlobalRecheck, { passive: true });
    window.addEventListener('resize', requestGlobalRecheck, { passive: true });

    document.addEventListener('visibilitychange', () => {
        if (!CONFIG.pauseOnHiddenTab) return;
        if (document.hidden) {
            document.querySelectorAll('video').forEach(pause);
        } else {
            recheckAllKnown();
        }
    });

    function init() {
        scanExisting();
        mo.observe(document.body, { childList: true, subtree: true });
        log('инициализирован, видео на странице:', document.querySelectorAll('video').length);
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

    window.VideoAutoplay = {
        playAll: () => document.querySelectorAll('video').forEach(play),
        pauseAll: () => document.querySelectorAll('video').forEach(pause),
        config: CONFIG,
    };
})();
