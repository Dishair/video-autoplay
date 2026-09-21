// ==UserScript==
// @name         Video Autoplay on Visible
// @namespace    http://tampermonkey.net/
// @version      2.4
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
            // Пока видео на экране — не спорим с пользователем: если он сам
            // поставил на паузу или заглушил звук через интерфейс сайта,
            // оставляем как есть. Автоматика снова берёт управление только
            // после того, как ролик уйдёт с экрана и вернётся заново.
            if (!s.userPaused) activate(video, s);
        } else {
            pause(video);
            s.userPaused = false;
            s.userMuted = false;
            if (currentlyUnmuted === video) {
                currentlyUnmuted = null;
                setMuted(video, true);
            }
        }
    }

    // Отличаем свои собственные play()/pause()/muted-мутации от событий,
    // вызванных пользователем (клик по видео, кнопка звука в плеере сайта).
    // Раньше это делалось через "пометил + setTimeout(0) снял пометку",
    // но 'pause' и 'volumechange' по спецификации ставятся в отдельную
    // очередь задач браузера (media element event task source) и не
    // гарантированно успевают дойти раньше, чем setTimeout(0) снимет
    // пометку — из-за этого свои же действия иногда ошибочно считались
    // "ручными" и намертво блокировали автоплей/звук для видео. Теперь
    // просто считаем, сколько событий каждого типа мы сами вызвали, и
    // игнорируем ровно столько, сколько прилетит — независимо от таймингов.
    function expect(video, prop) {
        const s = state.get(video);
        if (!s) return;
        s.pending[prop] = (s.pending[prop] || 0) + 1;
    }

    function consumeExpected(video, prop) {
        const s = state.get(video);
        if (!s || !s.pending[prop]) return false;
        s.pending[prop]--;
        return true;
    }

    function onNativePause(video) {
        if (consumeExpected(video, 'pause')) return;
        const s = state.get(video);
        if (!s) return;
        s.userPaused = true;
    }

    function onNativeVolumeChange(video) {
        if (consumeExpected(video, 'volumechange')) return;
        const s = state.get(video);
        if (!s) return;
        s.userMuted = video.muted;
    }

    // play() и включение звука раньше вызывались как две независимые
    // операции: play() стартует асинхронно и, если браузер отклоняет
    // первую попытку "со звуком" (нет пользовательского жеста — Chrome
    // блокирует запуск воспроизведения со звуком без него), откатывается
    // на muted=true уже ПОСЛЕ того, как параллельный вызов unmute успел
    // выставить muted=false — тогда откат перетирал успешный unmute в
    // непредсказуемом порядке ("иногда" не работает звук на первом видео
    // за сессию). Теперь решение "нужен ли звук этому видео" принимается
    // один раз и передаётся в play(), а откат на muted происходит только
    // внутри её же .catch(), без гонки с отдельной функцией unmute.
    function activate(video, s) {
        const wantSound = !s.userMuted && CONFIG.unmuteActive
            && (!CONFIG.onlyOneUnmuted || pickMostVisible() === video);

        if (wantSound) claimUnmute(video);

        if (video.paused) {
            if (wantSound) setMuted(video, false);
            const p = video.play();
            if (p && p.catch) {
                p.catch((err) => {
                    log('play() отклонён, пробую снова с muted:', err);
                    setMuted(video, true);
                    video.play().catch((e) => log('не удалось воспроизвести даже с muted:', e));
                });
            }
        } else if (wantSound) {
            // Уже играет — снять mute с уже играющего видео браузер не блокирует.
            setMuted(video, false);
        }
    }

    function claimUnmute(video) {
        if (!CONFIG.onlyOneUnmuted) return;
        if (currentlyUnmuted && currentlyUnmuted !== video) {
            setMuted(currentlyUnmuted, true);
        }
        currentlyUnmuted = video;
    }

    function setMuted(video, muted) {
        expect(video, 'volumechange');
        video.muted = muted;
        if (!muted) {
            expect(video, 'volumechange');
            video.volume = Math.min(video.volume || CONFIG.maxVolume, CONFIG.maxVolume);
        }
    }

    function pause(video) {
        if (!video.paused) {
            expect(video, 'pause');
            video.pause();
        }
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
        const onPause = () => onNativePause(video);
        const onVolumeChange = () => onNativeVolumeChange(video);
        state.set(video, {
            visible: false,
            timer: null,
            pending: {},
            userPaused: false,
            userMuted: false,
            onPause,
            onVolumeChange,
        });
        video.addEventListener('pause', onPause);
        video.addEventListener('volumechange', onVolumeChange);
        io.observe(video);
        scheduleRecheck(video);
        log('наблюдаю за новым видео', video);
    }

    function unwatch(video) {
        if (!known.has(video)) return;
        const s = state.get(video);
        io.unobserve(video);
        clearTimeout(s?.timer);
        if (s) {
            video.removeEventListener('pause', s.onPause);
            video.removeEventListener('volumechange', s.onVolumeChange);
        }
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
        playAll: () => document.querySelectorAll('video').forEach((v) => { const s = state.get(v); if (s) activate(v, s); }),
        pauseAll: () => document.querySelectorAll('video').forEach(pause),
        config: CONFIG,
    };
})();
