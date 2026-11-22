// ==UserScript==
// @name         UOOC 学习助手_szu_v2
// @namespace    https://github.com/imdecimo/UOOC_learning_assistant
// @version      1.6.4
// @author       decimo
// @description  自动静音、二倍速、自动连播、自动答题(视频中非测验)、自动刷评论。兼容新旧版学习页，递归刷课可开关，带视频看门狗与任务熔断。
// @license      GPL
// @match        *://www.uooc.net.cn/*
// @match        *://uooc.net.cn/*
// @match        *://*.uooc.net.cn/*
// @match        *://uooc.online/*
// @match        *://*.uooc.online/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    // 学习页里嵌了同源的 /ai/studybuddy iframe，脚本会在里面再跑一遍并画出多余的悬浮按钮
    try {
        if (window.top && window.self && window.top !== window.self) return;
    } catch (err) {
        return;
    }

    // ================= 可配置区 =================
    const CONFIG = {
        speed: 2,                 // 播放倍速
        mute: true,               // 自动静音
        tickMs: 250,              // 统一调度循环间隔
        videoBootMs: 20000,       // 点击小节后等待新视频加载的时间
        catalogWaitMs: 4000,      // 展开大章/等待小节资源列表的时间
        videoStallMs: 120000,     // 播放进度停滞多久判定卡死
        videoMaxMs: 3 * 60 * 60 * 1000, // 单个视频最长等待
        maxNodeFailures: 2,       // 同一小节失败几次后跳过
        maxIdleRounds: 3,         // 连续几轮刷不到内容就自动关闭递归
        comment: {
            pageSize: 12,         // 讨论区列表每页条数
            maxPages: 5,          // 列表最多翻几页
            topicType: 30,        // 课程讨论区类型
            minGapMs: 20000,      // 两条评论最小间隔
            maxGapMs: 40000,      // 两条评论最大间隔
            maxFailures: 5,       // 连续失败几次触发冷却（发帖过快被拒时靠短间隔重试兜住）
            cooldownMs: 120000,   // 冷却时长
            defaultTarget: 10,    // 默认目标条数
            maxTarget: 500,
            maxContentLen: 800    // 单条评论最大长度
        }
    };

    const COMMENT_DECOR = [
        "，以上是我的一点思考。",
        "，感觉这部分讲得挺清楚。",
        "，先记下来，后面再回看。",
        "，期待和大家多交流。",
        "，有理解不对的地方请指正。"
    ];

    // ================= 基础工具 =================
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const getVideo = () => document.getElementById("player_html5_api");
    const isFlag = (value) => value === true || value === 1 || value === "1";
    const currentSrc = () => {
        const video = getVideo();
        return video ? video.currentSrc || video.src || "" : "";
    };

    const LOG_LIMIT = 50;
    const logLines = [];
    let logHook = null;
    function log(message) {
        const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        const line = "[" + stamp + "] " + message;
        logLines.push(line);
        if (logLines.length > LOG_LIMIT) logLines.shift();
        console.log("[UOOC助手]", message);
        if (logHook) {
            try { logHook(line); } catch (err) { /* 日志面板异常不影响主流程 */ }
        }
    }

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, { once: true });
        } else {
            fn();
        }
    }

    function stripHtml(input) {
        if (!input) return "";
        const holder = document.createElement("div");
        holder.innerHTML = String(input);
        holder.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
        holder.querySelectorAll("p, div, li, tr").forEach((el) => el.append("\n"));
        return (holder.textContent || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t\u3000]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function plainText(input) {
        return stripHtml(input).replace(/\s+/g, " ").trim();
    }

    function normText(input) {
        return stripHtml(input)
            .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
            .replace(/\s+/g, "")
            .replace(/[，。、！？；：“”‘’（）【】《》,.!?;:"'()\[\]<>]/g, "")
            .toLowerCase();
    }

    // 安全解析答案：兼容 ['A','C'] / ["A","C"] / "AC" / "A,C" / [0,2] / "1,3"
    function parseAnswer(raw) {
        if (raw === null || raw === undefined) return null;
        const text = String(raw).trim();
        if (!text) return null;
        let tokens = null;
        if (text.charAt(0) === "[") {
            try { tokens = JSON.parse(text.replace(/'/g, '"')); } catch (err) { tokens = null; }
        }
        if (!Array.isArray(tokens)) tokens = text.match(/[A-Za-z]|\d+/g);
        if (!tokens) return null;
        const indexes = [];
        for (const token of tokens) {
            if (typeof token === "number") { indexes.push(token); continue; }
            const value = String(token).trim().toUpperCase();
            if (/^\d+$/.test(value)) {
                indexes.push(Number(value));
            } else if (/^[A-Z]+$/.test(value)) {
                for (const ch of value) indexes.push(ch.charCodeAt(0) - 65);
            }
        }
        const valid = Array.from(new Set(indexes)).filter((n) => Number.isInteger(n) && n >= 0 && n < 26);
        return valid.length ? valid : null;
    }

    // ================= 统一调度循环（任务级熔断） =================
    const tasks = [];
    let tickTimer = null;
    function defineTask(name, everyMs, run) {
        tasks.push({ name, everyMs, run, last: 0, errors: 0, disabled: false });
    }
    function startTick() {
        if (tickTimer) return;
        tickTimer = setInterval(() => {
            const now = Date.now();
            for (const task of tasks) {
                if (task.disabled || now - task.last < task.everyMs) continue;
                task.last = now;
                try {
                    task.run();
                    task.errors = 0;
                } catch (err) {
                    task.errors += 1;
                    console.warn("[UOOC助手] 任务异常：" + task.name, err);
                    if (task.errors >= 5) {
                        task.disabled = true;
                        log("任务 " + task.name + " 连续异常，已自动停用");
                    }
                }
            }
        }, CONFIG.tickMs);
    }

    // ================= 播放保活 =================
    let pausedSince = 0;
    function keepVideoAlive(video) {
        if (!video) return;
        if (CONFIG.mute && !video.muted) video.muted = true;
        if (CONFIG.speed && video.playbackRate !== CONFIG.speed) video.playbackRate = CONFIG.speed;
        if (video.paused && !video.ended && !video.seeking && !video.error) {
            const result = video.play();
            if (result && typeof result.catch === "function") result.catch(() => {});
        }
    }

    function taskKeepPlaying() {
        const video = getVideo();
        if (!video) { pausedSince = 0; return; }
        keepVideoAlive(video);
        if (video.paused && !video.ended) {
            if (!pausedSince) pausedSince = Date.now();
            else if (Date.now() - pausedSince > 2000) {
                const playBtn = document.querySelector(".vjs-big-play-button");
                if (playBtn) playBtn.click();
                pausedSince = 0;
            }
        } else {
            pausedSince = 0;
        }
    }

    // ================= 弹窗清理（白名单安全模式） =================
    function isProtectedLayer(layer) {
        if (!layer) return true;
        if (layer.querySelector("input, textarea, iframe, .layui-layer-btn, .smallTest-view, .ti-alist, #quizLayer")) return true;
        const text = layer.innerText || layer.textContent || "";
        return /验证|智能|提交|测验|作业|考试|登录|支付/.test(text);
    }

    function taskClearOverlay() {
        const layers = Array.from(document.querySelectorAll(".layui-layer"));
        if (layers.some(isProtectedLayer)) return;
        document.querySelectorAll(".layui-layer-shade, .vjs-mask").forEach((el) => el.remove());
        layers.forEach((layer) => {
            if (!isProtectedLayer(layer)) layer.remove();
        });
        const quizDom = document.querySelector(".smallTest-view");
        if (quizDom && quizDom.offsetTop > 600 && !document.getElementById("quizLayer")) {
            quizDom.style.display = "none";
        }
    }

    // ================= 自动答题 =================
    const answeredQuiz = new Set();
    function isHidden(el) {
        if (!el) return true;
        if (el.style && el.style.display === "none") return true;
        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        return !!(style && style.display === "none");
    }

    function taskAutoAnswerQuiz() {
        const layer = document.getElementById("quizLayer");
        if (!layer || isHidden(layer)) return;
        const videoHolder = document.querySelector("div[uooc-video]");
        if (!videoHolder) return;
        const source = videoHolder.getAttribute("source");
        if (!source) return;

        let quizList;
        try {
            quizList = JSON.parse(source).quiz || [];
        } catch (err) {
            return;
        }
        if (!quizList.length) return;

        const questionElem = layer.querySelector(".smallTest-view .ti-q-c") || layer.querySelector(".ti-q-c");
        if (!questionElem) return;
        const questionKey = normText(questionElem.innerHTML);
        if (!questionKey) return;
        if (answeredQuiz.has(questionKey)) return;

        let item = quizList.find((quiz) => normText(quiz.question) === questionKey);
        if (!item) {
            item = quizList.find((quiz) => {
                const key = normText(quiz.question);
                return key.length > 6 && (questionKey.indexOf(key) >= 0 || key.indexOf(questionKey) >= 0);
            });
        }
        if (!item) return;

        const answer = parseAnswer(item.answer);
        if (!answer || !answer.length) return;

        const optionBox = layer.querySelector("div.ti-alist");
        if (!optionBox) return;
        const options = Array.from(optionBox.children);
        let clicked = 0;
        for (const index of answer) {
            const option = options[index];
            if (!option) continue;
            option.click();
            clicked += 1;
        }
        if (!clicked) return;

        const submit = layer.querySelector("button");
        if (submit) submit.click();

        answeredQuiz.add(questionKey);
        if (answeredQuiz.size > 300) answeredQuiz.clear();
        log("自动答题：" + plainText(item.question).slice(0, 30) + " → " + answer.map((n) => String.fromCharCode(65 + n)).join(""));
    }

    // ================= 递归刷课 =================
    let autoRecursiveFlag = false;
    let rushLock = false;
    let rushPending = false;
    let idleRounds = 0;
    let acted = 0;
    // 用「小节id#资源序号」这种稳定 key 记账：Angular 会重建 ng-if 子树，
    // 拿 DOM 元素当 key 的话失败计数会随元素换代清零，导致坏视频被无限重试
    let playedKeys = new Set();
    let failedKeys = new Map();

    function nodeLabel(node) {
        if (!node) return "未知小节";
        const nameSpan = node.querySelector(".tag-source-name");
        return plainText(nameSpan ? nameSpan.innerText || nameSpan.textContent : node.innerText) || "未知小节";
    }

    function isQuizNode(node) {
        if (!node) return false;
        const nameSpan = node.querySelector(".tag-source-name");
        if (!nameSpan || !nameSpan.classList.contains("taskpoint")) return false;
        return /测验|测试|作业|考试/.test(nameSpan.innerText || nameSpan.textContent || "");
    }

    // ---- 课程目录 ----
    // UOOC 是 Angular 状态驱动渲染：大章选中才渲染 ul.level_2，小节选中才渲染资源列表。
    // 旧版 /home/learn/index：
    //   ul.rank-1 > li > div.basic.chapter + ul.rank-2 > li > div.basic + div.resourcelist > div.basic
    // 新版 /home/learn/new/{cid}：
    //   ul.newlearn_left_card_chapter_list > li > div.level_1_title + ul.level_2 > li
    //     > div.level_2_title(id_小节id) + div.level_2_resourcelist > div.level_2_resourcelist_item
    //   三级节点为 ul.level_3 > div.level_3_title + div.level_3_resourcelist
    const PAGES = [
        {
            name: "newlearn",
            detect: () => !!document.querySelector(".newlearn"),
            catalogRoot: ".newlearn_left_card_chapter_list",
            chapterHeader: "div.level_1_title",
            sectionList: "ul.level_2",
            pointList: "ul.level_3",
            nodeHead: "div[class*='_title']",
            resourceList: "[class*='resourcelist']",
            resourceItem: "[class*='resourcelist_item']",
            isComplete: (node) => !!node.querySelector("[class*='item_icon_check']"),
            isVideo: (node) => !!node.querySelector("img[src*='video']")
        },
        {
            name: "legacy",
            detect: () => !!document.querySelector("ul.rank-1, .rank-1"),
            catalogRoot: "ul.rank-1, .rank-1",
            chapterHeader: "div.basic.chapter",
            sectionList: "ul.rank-2",
            pointList: "ul.rank-3",
            nodeHead: "div.basic",
            resourceList: ".resourcelist",
            resourceItem: ".basic",
            isComplete: (node) => node.classList.contains("complete"),
            isVideo: (node) => !!node.querySelector(".icon-video")
        }
    ];
    let PAGE = null;

    function detectPage() {
        for (const profile of PAGES) {
            try {
                if (profile.detect()) return profile;
            } catch (err) { /* 探测失败继续下一个 */ }
        }
        return null;
    }

    async function waitFor(getter, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!autoRecursiveFlag) return null;
            const value = getter();
            if (value) return value;
            await sleep(250);
        }
        return null;
    }

    // 旧版折叠图标是 i.icon-xiangxia，新版是 img[src*=xiangxia]
    function isCollapsed(node) {
        if (!node) return false;
        return !!node.querySelector("i[class*='icon-xiangxia'], img[src*='xiangxia']");
    }

    function getChapterLis() {
        if (!PAGE) return [];
        const root = document.querySelector(PAGE.catalogRoot);
        if (!root) return [];
        return Array.from(root.children).filter((li) => li.tagName === "LI" && li.querySelector(PAGE.chapterHeader));
    }

    // Angular 每次状态变更都会重建 ng-if 子树，所以一律按索引重新查，不持有元素引用
    const chapterAt = (ci) => getChapterLis()[ci] || null;
    const sectionLisAt = (ci) => {
        const chapterLi = chapterAt(ci);
        return chapterLi ? Array.from(chapterLi.querySelectorAll(":scope > " + PAGE.sectionList + " > li")) : [];
    };
    const sectionAt = (ci, si) => sectionLisAt(ci)[si] || null;
    const pointAt = (ci, si, pi) => {
        const sectionLi = sectionAt(ci, si);
        if (!sectionLi) return null;
        return sectionLi.querySelectorAll(":scope > " + PAGE.pointList + " > li")[pi] || null;
    };
    const pointCount = (ci, si) => {
        const sectionLi = sectionAt(ci, si);
        return sectionLi ? sectionLi.querySelectorAll(":scope > " + PAGE.pointList + " > li").length : 0;
    };

    async function openChapterAt(ci) {
        const chapterLi = chapterAt(ci);
        if (!chapterLi) return false;
        if (chapterLi.querySelector(":scope > " + PAGE.sectionList)) return true;
        const header = chapterLi.querySelector(":scope > " + PAGE.chapterHeader) || chapterLi.querySelector(PAGE.chapterHeader);
        if (!header) return false;
        if (isCollapsed(header)) header.click();
        return !!(await waitFor(() => {
            const live = chapterAt(ci);
            const list = live && live.querySelector(":scope > " + PAGE.sectionList);
            return list && list.children.length ? list : null;
        }, CONFIG.catalogWaitMs));
    }

    // 小节/三级节点：点击后会异步拉 getUnitLearn，资源列表才出现
    async function openNodeAt(getNode) {
        const node = getNode();
        if (!node) return null;
        if (node.querySelector(":scope > " + PAGE.resourceList)) return node;
        const head = node.querySelector(":scope > " + PAGE.nodeHead);
        if (!head) return null;
        if (isCollapsed(head)) head.click();
        return await waitFor(() => {
            const live = getNode();
            return live && live.querySelector(":scope > " + PAGE.resourceList) ? live : null;
        }, CONFIG.catalogWaitMs);
    }

    // 新版节的 id 挂在头元素上（id_小节id），旧版挂在小节 li 上
    function nodeKey(container) {
        if (!container) return "x";
        if (container.id) return container.id;
        const head = container.querySelector(":scope > " + PAGE.nodeHead);
        if (head && head.id) return head.id;
        return nodeLabel(container);
    }

    async function playResourceList(getContainer) {
        for (let guard = 0; guard < 60; guard++) {
            if (!autoRecursiveFlag) return;
            const container = getContainer();
            if (!container) return;
            const list = container.querySelector(":scope > " + PAGE.resourceList);
            if (!list) return;
            const resources = Array.from(list.querySelectorAll(":scope > " + PAGE.resourceItem));
            const keyBase = nodeKey(container);
            let played = false;
            for (let index = 0; index < resources.length; index++) {
                const resource = resources[index];
                if (PAGE.isComplete(resource)) continue;
                if (!PAGE.isVideo(resource) || isQuizNode(resource)) continue;
                const key = keyBase + "#" + index;
                if (playedKeys.has(key)) continue;
                if ((failedKeys.get(key) || 0) >= CONFIG.maxNodeFailures) continue;
                acted += 1;
                if (await playVideoNode(resource)) {
                    playedKeys.add(key);
                    failedKeys.delete(key);
                    played = true;
                } else {
                    failedKeys.set(key, (failedKeys.get(key) || 0) + 1);
                }
                break;
            }
            if (!played) return;
        }
    }

    async function processSectionAt(ci, si) {
        const sectionLi = sectionAt(ci, si);
        if (!sectionLi || sectionLi.classList.contains("unopen")) return;
        if (await openNodeAt(() => sectionAt(ci, si))) {
            await playResourceList(() => sectionAt(ci, si));
        }
        const points = pointCount(ci, si);
        for (let pi = 0; pi < points; pi++) {
            if (!autoRecursiveFlag) return;
            if (await openNodeAt(() => pointAt(ci, si, pi))) {
                await playResourceList(() => pointAt(ci, si, pi));
            }
        }
    }


    async function waitForVideoReady(prevSrc, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!autoRecursiveFlag) return null;
            const video = getVideo();
            if (video && !video.error) {
                const src = video.currentSrc || video.src || "";
                if (src && src !== prevSrc) return video;
                if (!src && video.readyState > 0) return video;
                if (video.readyState >= 1 && video.currentTime < 1.5 && !video.paused) return video;
            }
            await sleep(400);
        }
        return null;
    }

    function waitForEnded(video) {
        return new Promise((resolve) => {
            let done = false;
            let timer = null;
            const startedAt = Date.now();
            let lastTime = -1;
            let lastProgressAt = Date.now();

            const finish = (reason) => {
                if (done) return;
                done = true;
                cleanup();
                resolve(reason);
            };
            const onEnded = () => finish("ended");
            const onError = () => finish("error");

            function cleanup() {
                video.removeEventListener("ended", onEnded);
                video.removeEventListener("error", onError);
                if (timer) clearInterval(timer);
            }

            video.addEventListener("ended", onEnded);
            video.addEventListener("error", onError);
            timer = setInterval(() => {
                if (!video.isConnected) return finish("detached");
                if (video.ended) return finish("ended");
                if (video.error) return finish("error");
                keepVideoAlive(video);
                if (Math.abs(video.currentTime - lastTime) > 0.05) {
                    lastTime = video.currentTime;
                    lastProgressAt = Date.now();
                } else if (Date.now() - lastProgressAt > CONFIG.videoStallMs) {
                    return finish("stalled");
                }
                if (Date.now() - startedAt > CONFIG.videoMaxMs) return finish("timeout");
            }, 1000);
        });
    }

    async function playVideoNode(node) {
        if (!node || !node.isConnected) return false;
        const before = currentSrc();
        const clickTarget = node.querySelector("a") || node;
        clickTarget.click();
        const video = await waitForVideoReady(before, CONFIG.videoBootMs);
        if (!video) {
            log("未检测到视频加载：" + nodeLabel(node));
            return false;
        }
        keepVideoAlive(video);
        const reason = await waitForEnded(video);
        if (reason === "ended") return true;
        log("视频未正常结束（" + reason + "）：" + nodeLabel(node));
        return false;
    }

    async function traverse() {
        PAGE = detectPage();
        if (!PAGE) {
            log("未识别到课程目录（旧版 rank-1 / 新版 newlearn 都没找到）");
            return;
        }
        const total = getChapterLis().length;
        if (!total) {
            log("未找到课程目录（" + PAGE.name + "），当前可能不在学习页");
            return;
        }
        acted = 0;
        for (let ci = 0; ci < total; ci++) {
            if (!autoRecursiveFlag) return;
            const chapterLi = chapterAt(ci);
            if (!chapterLi) continue;
            if (chapterLi.classList.contains("unopen")) continue;
            if (!(await openChapterAt(ci))) {
                log("大章展开失败：" + nodeLabel(chapterAt(ci)));
                continue;
            }
            const sectionCount = sectionLisAt(ci).length;
            for (let si = 0; si < sectionCount; si++) {
                if (!autoRecursiveFlag) return;
                await processSectionAt(ci, si);
            }
        }
    }

    async function runCourseRush() {
        if (!autoRecursiveFlag) return;
        if (rushLock) {
            rushPending = true;
            return;
        }
        rushLock = true;
        try {
            do {
                rushPending = false;
                await traverse();
            } while (rushPending && autoRecursiveFlag);
            if (!autoRecursiveFlag) return;
            if (acted === 0) {
                idleRounds += 1;
                if (idleRounds >= CONFIG.maxIdleRounds) {
                    setRecursive(false);
                    log("连续 " + idleRounds + " 轮没有可刷的视频，已自动关闭递归");
                }
            } else {
                idleRounds = 0;
            }
        } catch (err) {
            log("递归流程异常：" + (err && err.message ? err.message : err));
        } finally {
            rushLock = false;
        }
    }

    function setRecursive(on) {
        autoRecursiveFlag = !!on;
        const btn = document.getElementById("uooc-recursive-btn");
        if (btn) {
            btn.textContent = "递归上课：" + (on ? "开启" : "关闭");
            btn.style.background = on ? "#c62828" : "#00796b";
        }
        log("递归上课已" + (on ? "开启" : "关闭"));
        if (autoRecursiveFlag) {
            idleRounds = 0;
            runCourseRush();
        }
    }

    function taskAutoResume() {
        if (!autoRecursiveFlag || rushLock) return;
        const video = getVideo();
        if (video && !video.paused && !video.ended && !video.error) return;
        runCourseRush();
    }

    // ================= 刷评论 =================
    const CommentBot = (function () {
        const LS_KEY = "uooc_comment_bot_v1";
        const state = {
            enabled: false,
            running: false,
            target: CONFIG.comment.defaultTarget,
            sent: 0,
            failures: 0,
            cooldownUntil: 0,
            nextAt: 0,
            decorate: false,
            status: "未启动"
        };
        let panel = null;
        let toggleBtn = null;
        let statusEl = null;
        let countEl = null;
        let logEl = null;
        let targetInput = null;
        let decorateInput = null;
        let queue = [];
        let cursor = 0;
        let stopToken = 0;
        const panelLog = [];

        function load() {
            try {
                const raw = localStorage.getItem(LS_KEY);
                if (!raw) return;
                const saved = JSON.parse(raw);
                if (!saved) return;
                if (Number(saved.target) > 0) {
                    state.target = Math.min(CONFIG.comment.maxTarget, Math.max(1, Math.floor(Number(saved.target))));
                }
                state.decorate = !!saved.decorate;
            } catch (err) { /* 存储不可用时用默认值 */ }
        }

        function save() {
            try {
                localStorage.setItem(LS_KEY, JSON.stringify({ target: state.target, decorate: state.decorate }));
            } catch (err) { /* 忽略 */ }
        }

        function resolveCid() {
            const path = location.pathname || "";
            const hash = location.hash || "";
            const search = location.search || "";
            const fromPath = path.match(/\/home\/(?:course|learn\/new)\/(\d{6,})/);
            if (fromPath) return fromPath[1];
            // 学习页把课程 id 放在 hash 里：#/<课程id>/<小节id>/<资源id>
            const fromHash = hash.match(/#\/?(\d{6,})(?:\/|$)/);
            if (fromHash) return fromHash[1];
            const fromQuery = (search + hash).match(/[?&#]cid=(\d+)/);
            if (fromQuery) return fromQuery[1];
            // cookie 兜底只在课程/学习页生效，避免个人中心等页面挂出不相干的课程
            if (/\/home\/(?:course|learn)\//.test(path)) {
                const cookie = document.cookie.match(/(?:^|;\s*)formpath=([^;]+)/);
                if (cookie) {
                    const decoded = decodeURIComponent(cookie[1]);
                    const fromCookie = decoded.match(/(?:course|learn\/new)\/(\d{6,})/);
                    if (fromCookie) return fromCookie[1];
                }
            }
            return null;
        }

        async function requestJson(url, options) {
            const controller = typeof AbortController === "function" ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
            const init = Object.assign({
                credentials: "include",
                headers: { Accept: "application/json, text/plain, */*" }
            }, options || {});
            if (controller) init.signal = controller.signal;
            try {
                const response = await fetch(url, init);
                if (!response.ok) throw new Error("HTTP " + response.status);
                return await response.json();
            } finally {
                if (timer) clearTimeout(timer);
            }
        }

        async function fetchThreads(cid, token) {
            const threads = [];
            const seen = new Set();
            for (let page = 1; page <= CONFIG.comment.maxPages; page++) {
                if (token !== undefined && token !== stopToken) break;
                setStatus("拉取帖子列表 第 " + page + " 页");
                const query = new URLSearchParams({
                    cid: String(cid),
                    onlyteacher: "0",
                    page: String(page),
                    pagesize: String(CONFIG.comment.pageSize),
                    type: String(CONFIG.comment.topicType)
                });
                const json = await requestJson("/Home/Threads/list?" + query.toString());
                if (!json || json.code !== 1) {
                    throw new Error((json && (json.msg || json.message)) || "帖子列表接口返回异常");
                }
                const rows = (json.data && json.data.data) || [];
                if (!rows.length) break;
                let added = 0;
                for (const row of rows) {
                    const tid = Number(row && row.tid);
                    if (!tid || seen.has(tid)) continue;
                    if (isFlag(row.disabled) || isFlag(row.is_delete) || isFlag(row.is_close_thread)) continue;
                    seen.add(tid);
                    added += 1;
                    threads.push({ tid: tid, subject: plainText(row.subject), content: plainText(row.content) });
                }
                if (!added || rows.length < CONFIG.comment.pageSize) break;
            }
            return threads;
        }

        async function warmupThread(cid, tid) {
            try {
                const query = new URLSearchParams({
                    cid: String(cid),
                    page: "1",
                    pagesize: "20",
                    tid: String(tid),
                    order: "DESC"
                });
                await requestJson("/Home/Threads/details?" + query.toString());
            } catch (err) { /* 预热失败不阻断主流程 */ }
        }

        function buildContent(thread) {
            let text = (thread.content || thread.subject || "").replace(/\s+/g, " ").trim();
            if (!text) return "";
            if (state.decorate) text += COMMENT_DECOR[randInt(0, COMMENT_DECOR.length - 1)];
            if (text.length > CONFIG.comment.maxContentLen) text = text.slice(0, CONFIG.comment.maxContentLen);
            return text;
        }

        function postReply(cid, tid, content) {
            const body = new URLSearchParams({ cid: String(cid), content: content, tid: String(tid) });
            return requestJson("/Home/Threads/reply", {
                method: "POST",
                headers: {
                    Accept: "application/json, text/plain, */*",
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
                },
                body: body.toString()
            });
        }

        function setStatus(text) {
            state.status = text;
            if (statusEl) statusEl.textContent = text;
        }

        function pushPanelLog(line) {
            panelLog.push(line);
            if (panelLog.length > 5) panelLog.shift();
            if (logEl) logEl.textContent = panelLog.join("\n");
        }

        function render() {
            if (toggleBtn) {
                toggleBtn.textContent = state.enabled ? "刷评论：进行中" : "刷评论：关闭";
                toggleBtn.style.background = state.enabled ? "#c62828" : "#00796b";
            }
            if (countEl) countEl.textContent = state.sent + "/" + state.target;
            if (statusEl) statusEl.textContent = state.status;
            if (targetInput) targetInput.disabled = state.enabled;
            if (decorateInput) decorateInput.disabled = state.enabled;
        }

        function renderCountdown() {
            if (!statusEl || !state.nextAt) return;
            const left = Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000));
            statusEl.textContent = "等待 " + left + " 秒后继续（已发 " + state.sent + "/" + state.target + "）";
        }

        async function nap(ms, token) {
            let waited = 0;
            while (waited < ms) {
                if (token !== stopToken || !state.enabled) return false;
                const chunk = Math.min(500, ms - waited);
                await sleep(chunk);
                waited += chunk;
                if (state.nextAt) renderCountdown();
            }
            return true;
        }

        async function run() {
            const token = ++stopToken;
            state.running = true;
            state.sent = 0;
            state.failures = 0;
            state.cooldownUntil = 0;
            state.nextAt = 0;
            queue = [];
            cursor = 0;
            log("刷评论开始，目标 " + state.target + " 条");
            try {
                while (state.enabled && token === stopToken && state.sent < state.target) {
                    const cid = resolveCid();
                    if (!cid) {
                        setStatus("未识别到课程 cid，请打开课程讨论区");
                        break;
                    }
                    if (!queue.length || cursor >= queue.length) {
                        queue = await fetchThreads(cid, token);
                        cursor = 0;
                        if (!queue.length) {
                            setStatus("讨论区没有可回复的帖子");
                            break;
                        }
                        log("已获取 " + queue.length + " 个帖子");
                    }
                    const thread = queue[cursor++];
                    const content = buildContent(thread);
                    if (!content) continue;
                    if (Date.now() < state.cooldownUntil) {
                        const remain = state.cooldownUntil - Date.now();
                        setStatus("风控冷却中，剩余 " + Math.ceil(remain / 1000) + " 秒");
                        if (!(await nap(remain, token))) break;
                        continue;
                    }
                    setStatus("回复帖子 " + thread.tid + "（准备第 " + (state.sent + 1) + " 条）");
                    await warmupThread(cid, thread.tid);
                    if (token !== stopToken || !state.enabled) break;
                    let json;
                    try {
                        json = await postReply(cid, thread.tid, content);
                    } catch (err) {
                        json = { code: 0, msg: err && err.message ? err.message : String(err) };
                    }
                    if (json && json.code === 1) {
                        state.sent += 1;
                        state.failures = 0;
                        log("已发表 " + state.sent + "/" + state.target + "（tid " + thread.tid + "）");
                    } else {
                        state.failures += 1;
                        const message = (json && (json.msg || json.message)) || "未知错误";
                        log("发表失败：" + message);
                        if (state.failures >= CONFIG.comment.maxFailures) {
                            state.cooldownUntil = Date.now() + CONFIG.comment.cooldownMs;
                            state.failures = 0;
                            log("连续失败 " + CONFIG.comment.maxFailures + " 次，暂停 " + Math.round(CONFIG.comment.cooldownMs / 1000) + " 秒");
                        }
                    }
                    render();
                    if (state.sent >= state.target) break;
                    const gap = randInt(CONFIG.comment.minGapMs, CONFIG.comment.maxGapMs);
                    state.nextAt = Date.now() + gap;
                    setStatus("等待 " + Math.round(gap / 1000) + " 秒后继续");
                    if (!(await nap(gap, token))) break;
                    state.nextAt = 0;
                }
            } catch (err) {
                const message = err && err.message ? err.message : String(err);
                log("刷评论异常：" + message);
                setStatus("出错：" + message);
            } finally {
                // 只有最新一轮收尾时才改共享状态，避免旧一轮把新一轮关掉
                if (token === stopToken) {
                    state.running = false;
                    state.nextAt = 0;
                    state.enabled = false;
                    if (state.sent >= state.target) {
                        setStatus("已完成 " + state.sent + "/" + state.target + " 条");
                        log("刷评论完成，共 " + state.sent + " 条");
                    }
                }
                render();
            }
        }

        function toggle() {
            if (state.enabled) {
                state.enabled = false;
                setStatus("已手动停止");
                render();
                return;
            }
            state.enabled = true;
            render();
            run();
        }

        function createPanel() {
            load();
            const box = document.createElement("div");
            box.id = "uooc-comment-panel";
            Object.assign(box.style, {
                width: "236px",
                padding: "10px",
                borderRadius: "10px",
                background: "rgba(255,255,255,0.97)",
                boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
                fontFamily: "inherit",
                fontSize: "12px",
                color: "#333",
                lineHeight: "1.5",
                boxSizing: "border-box"
            });

            toggleBtn = document.createElement("button");
            toggleBtn.type = "button";
            toggleBtn.textContent = state.enabled ? "刷评论：进行中" : "刷评论：关闭";
            Object.assign(toggleBtn.style, {
                width: "100%",
                background: state.enabled ? "#c62828" : "#00796b",
                color: "#fff",
                border: "none",
                padding: "9px 0",
                borderRadius: "8px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: "14px",
                userSelect: "none"
            });
            toggleBtn.addEventListener("click", toggle);

            const row = document.createElement("div");
            Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" });

            const targetLabel = document.createElement("span");
            targetLabel.textContent = "目标";
            targetInput = document.createElement("input");
            targetInput.type = "number";
            targetInput.min = "1";
            targetInput.max = String(CONFIG.comment.maxTarget);
            targetInput.value = String(state.target);
            Object.assign(targetInput.style, { width: "56px", padding: "2px 4px", border: "1px solid #ccc", borderRadius: "4px", fontFamily: "inherit" });
            targetInput.addEventListener("change", () => {
                const value = Math.floor(Number(targetInput.value));
                state.target = Number.isFinite(value) ? Math.min(CONFIG.comment.maxTarget, Math.max(1, value)) : CONFIG.comment.defaultTarget;
                targetInput.value = String(state.target);
                save();
                render();
            });

            const countLabel = document.createElement("span");
            countLabel.textContent = "已发";
            countEl = document.createElement("span");
            countEl.textContent = state.sent + "/" + state.target;
            Object.assign(countEl.style, { fontWeight: "bold", color: "#00796b" });

            row.appendChild(targetLabel);
            row.appendChild(targetInput);
            row.appendChild(countLabel);
            row.appendChild(countEl);

            statusEl = document.createElement("div");
            Object.assign(statusEl.style, { marginTop: "6px", color: "#555", wordBreak: "break-all" });
            statusEl.textContent = state.status;

            const decorRow = document.createElement("label");
            Object.assign(decorRow.style, { display: "flex", alignItems: "center", gap: "4px", marginTop: "6px", cursor: "pointer", color: "#555" });
            decorateInput = document.createElement("input");
            decorateInput.type = "checkbox";
            decorateInput.checked = state.decorate;
            decorateInput.addEventListener("change", () => {
                state.decorate = !!decorateInput.checked;
                save();
            });
            decorRow.appendChild(decorateInput);
            decorRow.appendChild(document.createTextNode("末尾追加随机短评（降低判重）"));

            logEl = document.createElement("pre");
            Object.assign(logEl.style, {
                margin: "8px 0 0 0",
                padding: "6px",
                maxHeight: "84px",
                overflow: "auto",
                background: "#f5f5f5",
                borderRadius: "6px",
                fontSize: "11px",
                lineHeight: "1.4",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                color: "#666"
            });
            logEl.textContent = panelLog.join("\n");

            box.appendChild(toggleBtn);
            box.appendChild(row);
            box.appendChild(statusEl);
            box.appendChild(decorRow);
            box.appendChild(logEl);

            panel = box;
            logHook = (line) => {
                if (state.enabled || /评论|帖子|cid/.test(line)) pushPanelLog(line);
            };
            render();
            return box;
        }

        return {
            resolveCid: resolveCid,
            createPanel: createPanel,
            state: state,
            toggle: toggle,
            buildContent: buildContent,
            fetchThreads: fetchThreads
        };
    })();

    // ================= 界面装配 =================
    let uiRoot = null;
    let uiSignature = "";

    function createRecursiveButton() {
        const btn = document.createElement("button");
        btn.id = "uooc-recursive-btn";
        btn.type = "button";
        btn.textContent = "递归上课：" + (autoRecursiveFlag ? "开启" : "关闭");
        Object.assign(btn.style, {
            background: autoRecursiveFlag ? "#c62828" : "#00796b",
            color: "#fff",
            border: "none",
            padding: "11px 22px",
            borderRadius: "8px",
            cursor: "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            userSelect: "none",
            fontFamily: "inherit",
            fontSize: "14px"
        });
        btn.addEventListener("click", () => setRecursive(!autoRecursiveFlag));
        return btn;
    }

    // 只在能锁定课程上下文时挂界面：学习页给递归开关，能解析出 cid 就给刷评论面板
    function detectUiContext() {
        const path = location.pathname || "";
        const cid = CommentBot.resolveCid();
        let kind = "other";
        if (/\/home\/learn\/(?:new\/\d+|index)/.test(path) || document.querySelector(".newlearn, ul.rank-1")) {
            kind = "learn";
        }
        return { kind: kind, cid: cid };
    }

    function ensureUi() {
        if (!document.body) return;
        const ctx = detectUiContext();
        const signature = ctx.kind + "|" + (ctx.cid || "-");
        if (uiRoot && uiRoot.isConnected) {
            if (signature === uiSignature) return;
            uiRoot.remove();
        }
        uiRoot = null;
        uiSignature = signature;
        if (ctx.kind !== "learn" && !ctx.cid) return;
        uiRoot = document.createElement("div");
        uiRoot.id = "uooc-assistant-root";
        Object.assign(uiRoot.style, {
            position: "fixed",
            right: "30px",
            top: "120px",
            zIndex: "2147483000",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "10px"
        });
        if (ctx.kind === "learn") uiRoot.appendChild(createRecursiveButton());
        if (ctx.cid) uiRoot.appendChild(CommentBot.createPanel());
        document.body.appendChild(uiRoot);
    }

    // ================= 路由变化 =================
    // 按「页面类型 + 课程 id」判断是否真的换了课程；只看 href 会被学习页的 hash 变化误触发，
    // 导致 playedKeys 被清空、同一小节反复点播
    let lastRouteKey = "";
    function taskRouteWatch() {
        const ctx = detectUiContext();
        const key = ctx.kind + "|" + (ctx.cid || "-");
        if (key === lastRouteKey) return;
        lastRouteKey = key;
        playedKeys = new Set();
        failedKeys = new Map();
        idleRounds = 0;
        pausedSince = 0;
        log("切换页面：" + key);
        ensureUi();
    }

    // ================= 启动 =================
    defineTask("ensureUi", 800, ensureUi);
    defineTask("keepPlaying", 500, taskKeepPlaying);
    defineTask("clearOverlay", 800, taskClearOverlay);
    defineTask("autoAnswerQuiz", 500, taskAutoAnswerQuiz);
    defineTask("routeWatch", 1000, taskRouteWatch);
    defineTask("autoResume", 1500, taskAutoResume);

    ready(() => {
        ensureUi();
        startTick();
        log("脚本已启动 v1.6.4");
    });

    // 调试入口：控制台可用 __UOOC__ 查看状态
    try {
        window.__UOOC__ = {
            config: CONFIG,
            commentBot: CommentBot,
            parseAnswer: parseAnswer,
            normText: normText,
            plainText: plainText,
            logLines: logLines,
            setRecursive: setRecursive,
            isRecursive: () => autoRecursiveFlag
        };
    } catch (err) { /* 忽略 */ }
})();
