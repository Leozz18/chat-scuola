/**
 * Chat multi-stanza — lobby, stanze pubbliche/private, approvazione host
 * E2EE AES (CryptoJS) solo client, polling HTTP, markdown, immagini, slash, notifiche
 */

(function () {
    'use strict';

    var POLL_CHAT_MS = 1500;
    var POLL_LOBBY_MS = 3000;
    var POLL_WAITING_MS = 3000;

    var lastMessageId = 0;
    var myNick = '';
    var activeRoomKey = '';
    var roomWasPersisted = false;
    var roomPassword = '';

    var isHostCurrent = false;
    var waitingRoomKey = '';

    var lobbyTimer = null;
    var waitingTimer = null;
    var chatTimer = null;

    var el = {};

    var storedPageTitle = typeof document !== 'undefined' ? document.title : 'Chat';
    var titleBlinkTimer = null;
    var hiddenUnread = 0;

    var MAX_SERVER_TEXT = 2000000;
    var burnTimeouts = [];

    var pollVoteStore = {};
    var hackInterval = null;
    var hackEndTimer = null;

    var REPLY_SNIPPET_MAX = 70;
    var lastOnlineUsers = [];
    var presenceSnapshotDone = false;
    var onlineUsersForUi = [];
    var currentAppStatus = 'chat';
    var isTextTool = false;
    var textPendingX = 0;
    var textPendingY = 0;
    var mentionFiltered = [];
    var e2eeModalResolve = null;
    var localInfoSeq = 0;

    var REACT_PICKER_EMOJIS = ['👍', '❤️', '😂', '😮', '😢'];
    var pendingReactions = [];

    /** Evita invii duplicati di ricevute di lettura per lo stesso id messaggio. */
    var readReceiptSentSet = {};

    /** Messaggi più vecchi di questo timestamp (unix sec) non generano invio READ (evita flood in cronologia). */
    var readReceiptMinEligibleTimeSec = 9007199254740991;

    /** READ da inviare quando la scheda torna visibile (tab in background). */
    var pendingReadReceipts = [];

    var WB_FLUSH_MS = 500;
    var WB_DRAW_PREFIX = '[DRAWB]';

    var wbCtx = null;
    var wbIsDrawing = false;
    var wbLastX = 0;
    var wbLastY = 0;
    var wbFlushIntervalId = null;
    var wbSegmentQueue = [];
    var cursorTimeouts = {};
    var wbIsEraser = false;
    var wbCurrentColor = '#5b8cff';

    function scrollMessagesToBottom() {
        if (!el.messages) return;
        var sc = el.chatMessages;
        if (sc) {
            sc.scrollTop = sc.scrollHeight;
        } else {
            el.messages.scrollTop = el.messages.scrollHeight;
        }
    }

    function getWhiteboardCanvas() {
        return el.whiteboard || null;
    }

    function whiteboardFillBackground(ctx, c) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#1a1d24';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.restore();
    }

    function whiteboardEnsureContext() {
        var c = getWhiteboardCanvas();
        if (!c) return null;
        wbCtx = c.getContext('2d');
        if (!wbCtx) return null;
        if (!c.dataset.wbBg) {
            whiteboardFillBackground(wbCtx, c);
            c.dataset.wbBg = '1';
        }
        return wbCtx;
    }

    function whiteboardClearCanvasVisual() {
        var c = getWhiteboardCanvas();
        if (!c) return;
        var ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.beginPath();
        c.dataset.wbBg = '1';
    }

    function whiteboardResetForNewRoom() {
        wbSegmentQueue = [];
        if (wbFlushIntervalId) {
            clearInterval(wbFlushIntervalId);
            wbFlushIntervalId = null;
        }
        if (el.whiteboardOverlay) {
            el.whiteboardOverlay.classList.add('hidden');
            el.whiteboardOverlay.setAttribute('aria-hidden', 'true');
        }
        wbIsDrawing = false;
        var c = getWhiteboardCanvas();
        wbCtx = null;
        if (c) {
            delete c.dataset.wbBg;
            var ctx = c.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, c.width, c.height);
                ctx.beginPath();
                whiteboardFillBackground(ctx, c);
                wbCtx = ctx;
            }
            c.dataset.wbBg = '1';
        }
        wbIsEraser = false;
        wbCurrentColor = (el.wbColor && el.wbColor.value) || wbCurrentColor;
        if (el.wbEraserBtn) el.wbEraserBtn.classList.remove('wb-eraser-on');
        isTextTool = false;
        if (el.wbTextToolBtn) el.wbTextToolBtn.classList.remove('wb-text-tool-on');
        currentAppStatus = 'chat';
        whiteboardHideFloatingTextInput();
        whiteboardClearRemoteCursors();
        whiteboardUpdateCanvasCursor();
    }

    function whiteboardClientToCanvas(ev) {
        var c = getWhiteboardCanvas();
        if (!c) return { x: 0, y: 0 };
        var rect = c.getBoundingClientRect();
        if (!rect.width || !rect.height) return { x: 0, y: 0 };
        var sx = c.width / rect.width;
        var sy = c.height / rect.height;
        return {
            x: (ev.clientX - rect.left) * sx,
            y: (ev.clientY - rect.top) * sy
        };
    }

    function wbWireColorToken() {
        return wbIsEraser ? 'ERASER' : wbCurrentColor;
    }

    function wbCurrentBrush() {
        var v = el.wbSize ? parseInt(String(el.wbSize.value), 10) : 4;
        if (isNaN(v) || v < 1) return 1;
        if (v > 64) return 64;
        return v;
    }

    function whiteboardStrokeIsEraserToken(colorToken) {
        return colorToken === 'ERASER' || colorToken === 'E';
    }

    function whiteboardStrokeSegmentDraw(x0, y0, x1, y1, colorToken, widthPx, isRemoteStroke) {
        var ctx = whiteboardEnsureContext();
        if (!ctx) return;
        var isEraser = whiteboardStrokeIsEraserToken(colorToken);
        var lw = widthPx || 2;
        if (isEraser) {
            lw *= 2;
        }
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = lw;
        if (isEraser) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = colorToken || '#ffffff';
        }
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.restore();
        if (isRemoteStroke) {
            ctx.beginPath();
        }
    }

    function whiteboardQueueSegment(x0, y0, x1, y1) {
        wbSegmentQueue.push({
            x0: x0,
            y0: y0,
            x1: x1,
            y1: y1,
            c: wbWireColorToken(),
            w: wbCurrentBrush()
        });
        if (wbSegmentQueue.length > 800) {
            wbSegmentQueue.splice(0, wbSegmentQueue.length - 800);
        }
    }

    function whiteboardFlushQueued() {
        if (!wbSegmentQueue.length) return;
        if (!activeRoomKey) {
            wbSegmentQueue = [];
            return;
        }
        var parts = [];
        var i;
        for (i = 0; i < wbSegmentQueue.length; i++) {
            var s = wbSegmentQueue[i];
            parts.push(
                String(Math.round(s.x0 * 100) / 100) +
                    ':' +
                    String(Math.round(s.y0 * 100) / 100) +
                    ':' +
                    String(Math.round(s.x1 * 100) / 100) +
                    ':' +
                    String(Math.round(s.y1 * 100) / 100) +
                    ':' +
                    s.c +
                    ':' +
                    String(s.w)
            );
        }
        wbSegmentQueue = [];
        var payload = WB_DRAW_PREFIX + parts.join('|');
        if (payload.length > MAX_SERVER_TEXT) {
            window.alert('Lavagna: batch troppo grande. Prova a pulire o ridurre i tratti.');
            return;
        }
        deliverOutgoingToServer(payload, { skipInputClear: true, skipSendLock: true });
    }

    function whiteboardParseSegmentColons(seg) {
        var idxColon = seg.lastIndexOf(':');
        if (idxColon < 0) return null;
        var wStr = seg.slice(idxColon + 1);
        var rest = seg.slice(0, idxColon);
        idxColon = rest.lastIndexOf(':');
        if (idxColon < 0) return null;
        var col = rest.slice(idxColon + 1);
        rest = rest.slice(0, idxColon);
        var nums = rest.split(':');
        if (nums.length !== 4) return null;
        var x0 = parseFloat(nums[0]);
        var y0 = parseFloat(nums[1]);
        var x1 = parseFloat(nums[2]);
        var y1 = parseFloat(nums[3]);
        var w = parseFloat(wStr);
        if (isNaN(x0) || isNaN(y0) || isNaN(x1) || isNaN(y1) || isNaN(w)) return null;
        if (col !== 'ERASER' && col !== 'E' && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(col)) return null;
        return { x0: x0, y0: y0, x1: x1, y1: y1, col: col, w: w };
    }

    function whiteboardRemoteCursorDomId(nick) {
        return 'cursor-' + String(nick).replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function whiteboardCanvasToContainerPixels(canvasX, canvasY) {
        var c = getWhiteboardCanvas();
        var host = el.whiteboardContainer;
        if (!c || !host) return { x: 0, y: 0 };
        var cRect = c.getBoundingClientRect();
        var hRect = host.getBoundingClientRect();
        if (!cRect.width || !cRect.height) return { x: 0, y: 0 };
        var scaleX = cRect.width / c.width;
        var scaleY = cRect.height / c.height;
        return {
            x: cRect.left + canvasX * scaleX - hRect.left,
            y: cRect.top + canvasY * scaleY - hRect.top
        };
    }

    function updateRemoteCursor(nick, canvasX, canvasY) {
        if (!nick || nick === myNick || !el.whiteboardContainer) return;
        var px = whiteboardCanvasToContainerPixels(canvasX, canvasY);
        var id = whiteboardRemoteCursorDomId(nick);
        var elc = document.getElementById(id);
        if (!elc) {
            elc = document.createElement('div');
            elc.id = id;
            elc.className = 'remote-cursor';
            elc.setAttribute('data-nick', nick);
            elc.textContent = decodeHtmlEntities(String(nick));
            elc.style.backgroundColor = getStringColor(nick);
            el.whiteboardContainer.appendChild(elc);
        }
        elc.style.left = px.x + 'px';
        elc.style.top = px.y + 'px';
        elc.style.opacity = '1';
        if (cursorTimeouts[nick]) {
            clearTimeout(cursorTimeouts[nick]);
        }
        cursorTimeouts[nick] = setTimeout(function () {
            var nid = whiteboardRemoteCursorDomId(nick);
            var node = document.getElementById(nid);
            if (node) {
                node.style.opacity = '0';
            }
            delete cursorTimeouts[nick];
        }, 3000);
    }

    function whiteboardRemoteCursorFromDrawBatch(nick, body) {
        if (!body || typeof body !== 'string' || nick === myNick) return;
        var parts = body.split('|');
        var last = null;
        var i;
        for (i = 0; i < parts.length; i++) {
            var parsed = whiteboardParseSegmentColons(parts[i].trim());
            if (parsed) last = parsed;
        }
        if (last) {
            updateRemoteCursor(nick, last.x1, last.y1);
        }
    }

    function whiteboardRemoteCursorFromLegacyDraw(nick, line) {
        if (nick === myNick) return;
        var m = /^\[DRAW:([\d.-]+):([\d.-]+):([\d.-]+):([\d.-]+):([^:]+):([\d.-]+)\]/.exec(line.trim());
        if (m) {
            updateRemoteCursor(nick, parseFloat(m[3]), parseFloat(m[4]));
        }
    }

    function whiteboardRemoteCursorFromDrawText(nick, trimmed) {
        if (nick === myNick) return;
        var m = /^\[DRAW_TEXT:([\d.-]+):([\d.-]+):/.exec(trimmed.trim());
        if (m) {
            updateRemoteCursor(nick, parseFloat(m[1]), parseFloat(m[2]));
        }
    }

    function whiteboardClearRemoteCursors() {
        var k;
        for (k in cursorTimeouts) {
            if (Object.prototype.hasOwnProperty.call(cursorTimeouts, k)) {
                clearTimeout(cursorTimeouts[k]);
            }
        }
        cursorTimeouts = {};
        if (!el.whiteboardContainer) return;
        var nodes = el.whiteboardContainer.querySelectorAll('.remote-cursor');
        var ni;
        for (ni = 0; ni < nodes.length; ni++) {
            nodes[ni].remove();
        }
    }

    function whiteboardApplyBatchPayload(body) {
        if (!body || typeof body !== 'string') return;
        var chunks = body.split('|');
        var j;
        for (j = 0; j < chunks.length; j++) {
            var seg = chunks[j].trim();
            if (!seg) continue;
            var parsed = whiteboardParseSegmentColons(seg);
            if (parsed) {
                whiteboardStrokeSegmentDraw(parsed.x0, parsed.y0, parsed.x1, parsed.y1, parsed.col, parsed.w, true);
            }
        }
    }

    function whiteboardApplySingleLegacy(line) {
        var m = /^\[DRAW:([\d.-]+):([\d.-]+):([\d.-]+):([\d.-]+):([^:]+):([\d.-]+)\]/.exec(line.trim());
        if (!m) return;
        whiteboardStrokeSegmentDraw(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4]), m[5], parseFloat(m[6]), true);
    }

    function whiteboardGetTextPositionRoot() {
        return el.whiteboardContainer;
    }

    function whiteboardHideFloatingTextInput() {
        if (!el.floatingTextInput) return;
        el.floatingTextInput.value = '';
        el.floatingTextInput.classList.add('hidden');
        el.floatingTextInput.style.left = '';
        el.floatingTextInput.style.top = '';
        el.floatingTextInput.style.color = '';
        el.floatingTextInput.style.fontSize = '';
        el.floatingTextInput.style.fontFamily = '';
    }

    function whiteboardCommitFloatingText() {
        if (!el.floatingTextInput) return;
        var text = String(el.floatingTextInput.value || '').trim();
        if (text === '') {
            whiteboardHideFloatingTextInput();
            return;
        }
        var col = wbCurrentColor;
        var sz = wbCurrentBrush();
        whiteboardDrawTextOnCanvas(textPendingX, textPendingY, col, sz, text, false);
        var payload =
            '[DRAW_TEXT:' +
            String(Math.round(textPendingX * 100) / 100) +
            ':' +
            String(Math.round(textPendingY * 100) / 100) +
            ':' +
            col +
            ':' +
            String(sz) +
            ':' +
            encodeURIComponent(text) +
            ']';
        if (payload.length > MAX_SERVER_TEXT) {
            window.alert('Testo troppo lungo per la lavagna.');
            whiteboardHideFloatingTextInput();
            return;
        }
        deliverOutgoingToServer(payload, { skipInputClear: true, skipSendLock: true });
        whiteboardHideFloatingTextInput();
    }

    function whiteboardOpenFloatingTextInput(ev) {
        if (!activeRoomKey || !el.floatingTextInput) return;
        var root = whiteboardGetTextPositionRoot();
        if (!root) return;
        var p = whiteboardClientToCanvas(ev);
        textPendingX = p.x;
        textPendingY = p.y;
        var rr = root.getBoundingClientRect();
        var offX = ev.clientX - rr.left;
        var offY = ev.clientY - rr.top;
        var br = wbCurrentBrush();
        var inp = el.floatingTextInput;
        inp.classList.remove('hidden');
        inp.style.left = offX + 'px';
        inp.style.top = offY - br + 'px';
        inp.style.color = wbCurrentColor;
        inp.style.fontSize = br + 'px';
        inp.style.fontFamily = 'Arial';
        inp.value = '';
        setTimeout(function () {
            inp.focus();
        }, 0);
    }

    function bindFloatingTextInputOnce() {
        if (!el.floatingTextInput || el.floatingTextInput.dataset.bound) return;
        el.floatingTextInput.dataset.bound = '1';
        el.floatingTextInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                whiteboardCommitFloatingText();
            }
        });
        el.floatingTextInput.addEventListener('blur', function () {
            whiteboardCommitFloatingText();
        });
    }

    function whiteboardDrawTextOnCanvas(x, y, colorToken, sizePx, textPlain, isRemoteStroke) {
        var ctx = whiteboardEnsureContext();
        if (!ctx || textPlain == null || textPlain === '') return;
        var fs = Math.max(8, parseFloat(String(sizePx)) || 16);
        if (isNaN(fs)) fs = 16;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = colorToken || '#ffffff';
        ctx.font = fs + 'px Arial';
        ctx.textBaseline = 'top';
        ctx.fillText(textPlain, x, y);
        ctx.restore();
        if (isRemoteStroke) {
            ctx.beginPath();
        }
    }

    function whiteboardApplyDrawTextResolved(trimmed) {
        var m = /^\[DRAW_TEXT:([\d.-]+):([\d.-]+):([^:]+):([\d.-]+):(.+)\]$/.exec(trimmed.trim());
        if (!m) return;
        var rawEnc = m[5];
        var decoded;
        try {
            decoded = decodeURIComponent(rawEnc);
        } catch (e1) {
            return;
        }
        whiteboardDrawTextOnCanvas(
            parseFloat(m[1]),
            parseFloat(m[2]),
            m[3],
            parseFloat(m[4]),
            decoded,
            true
        );
    }

    function whiteboardUpdateCanvasCursor() {
        var c = getWhiteboardCanvas();
        if (!c) return;
        c.style.cursor = isTextTool ? 'text' : 'crosshair';
    }

    function whiteboardIsPanelOpen() {
        return el.whiteboardOverlay && !el.whiteboardOverlay.classList.contains('hidden');
    }

    function whiteboardOpenPanel() {
        if (!el.whiteboardOverlay || !activeRoomKey) return;
        el.whiteboardOverlay.classList.remove('hidden');
        el.whiteboardOverlay.setAttribute('aria-hidden', 'false');
        if (el.wbColor && el.wbColor.value) {
            wbCurrentColor = el.wbColor.value;
        }
        whiteboardEnsureContext();
        if (wbFlushIntervalId) clearInterval(wbFlushIntervalId);
        wbFlushIntervalId = setInterval(whiteboardFlushQueued, WB_FLUSH_MS);
        currentAppStatus = 'whiteboard';
        whiteboardUpdateCanvasCursor();
    }

    function whiteboardClosePanel() {
        whiteboardFlushQueued();
        if (wbFlushIntervalId) {
            clearInterval(wbFlushIntervalId);
            wbFlushIntervalId = null;
        }
        if (el.whiteboardOverlay) {
            el.whiteboardOverlay.classList.add('hidden');
            el.whiteboardOverlay.setAttribute('aria-hidden', 'true');
        }
        wbIsDrawing = false;
        currentAppStatus = 'chat';
        isTextTool = false;
        if (el.wbTextToolBtn) {
            el.wbTextToolBtn.classList.remove('wb-text-tool-on');
        }
        whiteboardHideFloatingTextInput();
        whiteboardClearRemoteCursors();
        whiteboardUpdateCanvasCursor();
    }

    function whiteboardOnPointerDown(ev) {
        if (!whiteboardIsPanelOpen() || ev.button !== 0) return;
        whiteboardEnsureContext();
        if (isTextTool) {
            whiteboardOpenFloatingTextInput(ev);
            return;
        }
        var p = whiteboardClientToCanvas(ev);
        wbIsDrawing = true;
        wbLastX = p.x;
        wbLastY = p.y;
    }

    function whiteboardOnPointerMove(ev) {
        if (isTextTool || !wbIsDrawing || !whiteboardIsPanelOpen()) return;
        var p = whiteboardClientToCanvas(ev);
        whiteboardStrokeSegmentDraw(wbLastX, wbLastY, p.x, p.y, wbWireColorToken(), wbCurrentBrush(), false);
        whiteboardQueueSegment(wbLastX, wbLastY, p.x, p.y);
        wbLastX = p.x;
        wbLastY = p.y;
    }

    function whiteboardOnPointerUp() {
        wbIsDrawing = false;
    }

    function whiteboardBindCanvas() {
        var c = getWhiteboardCanvas();
        if (!c || c.dataset.wbBound) return;
        c.dataset.wbBound = '1';
        c.addEventListener('mousedown', whiteboardOnPointerDown);
        c.addEventListener('mousemove', whiteboardOnPointerMove);
        c.addEventListener('mouseup', whiteboardOnPointerUp);
        c.addEventListener('mouseout', whiteboardOnPointerUp);
        c.addEventListener(
            'touchstart',
            function (e) {
                if (!whiteboardIsPanelOpen()) return;
                if (e.touches.length !== 1) return;
                e.preventDefault();
                whiteboardOnPointerDown({
                    button: 0,
                    clientX: e.touches[0].clientX,
                    clientY: e.touches[0].clientY
                });
            },
            { passive: false }
        );
        c.addEventListener(
            'touchmove',
            function (e) {
                if (!wbIsDrawing || e.touches.length !== 1) return;
                e.preventDefault();
                whiteboardOnPointerMove({
                    clientX: e.touches[0].clientX,
                    clientY: e.touches[0].clientY
                });
            },
            { passive: false }
        );
        c.addEventListener('touchend', whiteboardOnPointerUp);
        c.addEventListener('touchcancel', whiteboardOnPointerUp);
    }

    function whiteboardClearAllAndBroadcast() {
        whiteboardFlushQueued();
        whiteboardClearCanvasVisual();
        deliverOutgoingToServer('[DRAW_CLEAR]', { skipInputClear: true, skipSendLock: true });
    }

    function closeAllReactPickers() {
        if (!el.messages) return;
        var open = el.messages.querySelectorAll('.msg-react-picker--open');
        for (var i = 0; i < open.length; i++) {
            open[i].classList.remove('msg-react-picker--open');
        }
    }

    function flushPendingReactions() {
        if (!pendingReactions.length || !el.messages) return;
        var batch = pendingReactions.slice();
        pendingReactions = [];
        for (var i = 0; i < batch.length; i++) {
            var id = batch[i].id;
            var em = batch[i].emoji;
            var wrap = el.messages.querySelector('.msg[data-id="' + String(id) + '"]');
            if (wrap) {
                applyReactionToMessageDom(id, em);
            } else {
                pendingReactions.push({ id: id, emoji: em });
            }
        }
    }

    function applyReactionToMessageDom(targetMsgId, emoji) {
        if (!emoji || !el.messages) return;
        var wrap = el.messages.querySelector('.msg[data-id="' + String(targetMsgId) + '"]');
        if (!wrap) {
            pendingReactions.push({ id: targetMsgId, emoji: emoji });
            return;
        }
        var container = wrap.querySelector('.reactions-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'reactions-container';
            var footer = wrap.querySelector('.msg-footer');
            if (footer) {
                wrap.insertBefore(container, footer);
            } else {
                wrap.appendChild(container);
            }
        }
        var badges = container.querySelectorAll('.reaction-badge');
        var j;
        var found = null;
        for (j = 0; j < badges.length; j++) {
            var emEl = badges[j].querySelector('.reaction-emoji');
            if (emEl && emEl.textContent === emoji) {
                found = badges[j];
                break;
            }
        }
        if (found) {
            var cnt = found.querySelector('.reaction-count');
            if (cnt) {
                var n = parseInt(cnt.textContent, 10) || 0;
                cnt.textContent = String(n + 1);
            }
        } else {
            var badge = document.createElement('span');
            badge.className = 'reaction-badge';
            badge.setAttribute('title', 'Reazioni');
            var em = document.createElement('span');
            em.className = 'reaction-emoji';
            em.textContent = emoji;
            var c = document.createElement('span');
            c.className = 'reaction-count';
            c.textContent = '1';
            badge.appendChild(em);
            badge.appendChild(document.createTextNode(' '));
            badge.appendChild(c);
            container.appendChild(badge);
        }
    }

    function buildMessageFooterActions(wrap, m, nickPlain, resolvedTrim) {
        var footer = document.createElement('div');
        footer.className = 'msg-footer';

        var replyBtn = document.createElement('button');
        replyBtn.type = 'button';
        replyBtn.className = 'btn-msg-action btn-msg-reply';
        replyBtn.textContent = 'Rispondi';
        replyBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            closeAllReactPickers();
            insertReplyPrefix(m.id, nickPlain, resolvedTrim);
        });

        var reactWrap = document.createElement('div');
        reactWrap.className = 'msg-react-wrap';

        var reactBtn = document.createElement('button');
        reactBtn.type = 'button';
        reactBtn.className = 'btn-msg-action btn-msg-react';
        reactBtn.setAttribute('aria-expanded', 'false');
        reactBtn.setAttribute('aria-haspopup', 'true');
        reactBtn.title = 'Reagisci';
        reactBtn.textContent = '👍';

        var picker = document.createElement('div');
        picker.className = 'msg-react-picker';
        picker.setAttribute('role', 'menu');

        var ei;
        for (ei = 0; ei < REACT_PICKER_EMOJIS.length; ei++) {
            (function (em) {
                var eb = document.createElement('button');
                eb.type = 'button';
                eb.className = 'msg-react-picker-item';
                eb.textContent = em;
                eb.setAttribute('role', 'menuitem');
                eb.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var payload = '[REACT:' + m.id + ':' + em + ']';
                    deliverOutgoingToServer(payload, { skipInputClear: true, skipSendLock: true });
                    picker.classList.remove('msg-react-picker--open');
                    reactBtn.setAttribute('aria-expanded', 'false');
                });
                picker.appendChild(eb);
            })(REACT_PICKER_EMOJIS[ei]);
        }

        reactBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var isOpen = picker.classList.contains('msg-react-picker--open');
            closeAllReactPickers();
            if (!isOpen) {
                picker.classList.add('msg-react-picker--open');
                reactBtn.setAttribute('aria-expanded', 'true');
            }
        });

        reactWrap.appendChild(reactBtn);
        reactWrap.appendChild(picker);

        footer.appendChild(replyBtn);
        footer.appendChild(reactWrap);
        wrap.appendChild(footer);
    }
    var HACK_FAKE_LINES = [
        '[+] Bypassing Kernel Anti-Cheat...',
        '[*] Dumping Memory at 0x7FFA2B...',
        '[+] Extracting Offsets... SUCCESS',
        '[*] Injecting payload.dll...',
        '[+] Hooking ntdll.dll!NtReadVirtualMemory',
        '[*] Enumerating module list... 0x180000000',
        '[+] Resolving IAT... OK',
        '[*] Scanning heap regions...',
        '[+] Pattern scan: 12 candidates',
        '[*] Bruteforcing XOR key... 0x4A',
        '[+] Patch guard disabled (simulated)',
        '[*] Writing trampoline at 0x140012A00...',
        '[+] Remote thread created TID=0x3F2A',
        '[*] Waiting for handshake... OK',
        '[+] Dumping stack frame chain...',
        '[*] Leaking handle table... 128 entries',
        '[+] Clearing traces in EventLog...',
        '[*] Mapping physical pages...',
        '[+] ROP chain built (18 gadgets)',
        '[*] Pivoting stack to RWX region...',
        '[+] SUCCESS — payload staged'
    ];

    var MAX_FILE_DROP_BYTES = 1048576;
    var typingToTrueTimer = null;
    var typingToFalseTimer = null;

    var MAIN_SCREEN_IDS = ['login-screen', 'lobby-screen', 'waiting-screen', 'chat-screen'];

    var bossKeyActive = false;
    var lastEscapePressAt = 0;
    var BOSS_FAKE_DOCUMENT_TITLE = 'query_lab.py — Informatica';

    function stopTimer(t) {
        if (t) {
            clearInterval(t);
        }
        return null;
    }

    function stopAllPolls() {
        lobbyTimer = stopTimer(lobbyTimer);
        waitingTimer = stopTimer(waitingTimer);
        chatTimer = stopTimer(chatTimer);
    }

    /**
     * Mostra una sola schermata principale; tutte le altre ricevono .hidden.
     * @param {string} screenId uno tra login-screen, lobby-screen, waiting-screen, chat-screen
     */
    function showScreen(screenId) {
        var ok = false;
        var j;
        for (j = 0; j < MAIN_SCREEN_IDS.length; j++) {
            if (MAIN_SCREEN_IDS[j] === screenId) {
                ok = true;
                break;
            }
        }
        if (!ok) return;

        var i;
        for (i = 0; i < MAIN_SCREEN_IDS.length; i++) {
            var sid = MAIN_SCREEN_IDS[i];
            var node = document.getElementById(sid);
            if (!node) continue;
            node.classList.add('hidden');
            if (sid === 'chat-screen') {
                node.classList.remove('is-on');
            }
        }

        var t = document.getElementById(screenId);
        if (t) {
            t.classList.remove('hidden');
            if (screenId === 'chat-screen') {
                t.classList.add('is-on');
            }
        }
    }

    function showLoginError(msg) {
        el.loginError.textContent = msg;
        el.loginError.hidden = false;
    }

    function hideLoginError() {
        el.loginError.textContent = '';
        el.loginError.hidden = true;
    }

    function showLobbyError(msg) {
        if (!el.lobbyError) return;
        el.lobbyError.textContent = msg;
        el.lobbyError.hidden = !msg;
    }

    function hideLobbyError() {
        if (el.lobbyError) {
            el.lobbyError.textContent = '';
            el.lobbyError.hidden = true;
        }
    }

    function showCreateError(msg) {
        if (!el.createRoomError) return;
        el.createRoomError.textContent = msg;
        el.createRoomError.hidden = !msg;
    }

    function hideCreateError() {
        if (el.createRoomError) {
            el.createRoomError.textContent = '';
            el.createRoomError.hidden = true;
        }
    }

    function setConnState(state) {
        if (!el.connStatus) return;
        el.connStatus.classList.remove('ok', 'err');
        if (state === 'ok') el.connStatus.classList.add('ok');
        if (state === 'err') el.connStatus.classList.add('err');
    }

    function decodeHtmlEntities(s) {
        if (!s) return '';
        var t = document.createElement('textarea');
        t.innerHTML = s;
        return t.value;
    }

    function formatTime(unixSec) {
        var d = new Date(unixSec * 1000);
        return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    }

    function formatExportDateTime(unixSec) {
        var d = new Date(unixSec * 1000);
        return d.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'medium' });
    }

    function updateRoomTitle() {
        if (el.roomDisplay) {
            el.roomDisplay.textContent = activeRoomKey || '';
        }
    }

    function invalidateCryptoCache() {
        /* CryptoJS non usa cache di chiave derivata; funzione mantenuta per compatibilità con i flussi stanza/login. */
    }

    function clearAllBurnTimeouts() {
        for (var i = 0; i < burnTimeouts.length; i++) {
            var s = burnTimeouts[i];
            if (s && s.to) clearTimeout(s.to);
            if (s && s.iv) clearInterval(s.iv);
        }
        burnTimeouts = [];
    }

    function resetTitleBlink() {
        if (titleBlinkTimer) {
            clearInterval(titleBlinkTimer);
            titleBlinkTimer = null;
        }
        if (!bossKeyActive) {
            document.title = storedPageTitle;
        }
        hiddenUnread = 0;
    }

    function requestNotificationPermission() {
        if (typeof Notification === 'undefined' || !Notification.requestPermission) return;
        try {
            Notification.requestPermission().catch(function () {});
        } catch (e) {}
    }

    function tryNativeNotification(previewBody) {
        if (bossKeyActive) return;
        if (!document.hidden) return;
        if (typeof Notification === 'undefined') return;
        if (Notification.permission !== 'granted') return;
        try {
            var body = previewBody ? String(previewBody).replace(/\s+/g, ' ').slice(0, 200) : 'Apri la scheda per leggere.';
            new Notification('Nuovo messaggio in ' + (activeRoomKey || 'chat'), { body: body });
        } catch (e) {}
    }

    function bumpHiddenUnread(previewBody) {
        if (bossKeyActive) return;
        if (!document.hidden) return;
        hiddenUnread += 1;
        tryNativeNotification(previewBody);
        if (!titleBlinkTimer) {
            var flip = false;
            titleBlinkTimer = setInterval(function () {
                if (bossKeyActive) return;
                document.title = flip ? storedPageTitle : '(' + hiddenUnread + ') Nuovo messaggio!';
                flip = !flip;
            }, 1300);
        }
    }

    function hasCryptoJs() {
        return typeof CryptoJS !== 'undefined' && CryptoJS.AES && typeof CryptoJS.AES.encrypt === 'function';
    }

    function encryptTextForSend(plainText) {
        if (!roomPassword || !hasCryptoJs()) {
            return Promise.resolve(plainText);
        }
        try {
            var cipherStr = CryptoJS.AES.encrypt(plainText, roomPassword).toString();
            return Promise.resolve('enc:cjs:' + cipherStr);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    function decryptTextIfEncrypted(stored) {
        if (!stored || typeof stored !== 'string') {
            return Promise.resolve(stored);
        }
        if (stored.indexOf('enc:cjs:') === 0) {
            if (!roomPassword || !hasCryptoJs()) {
                return Promise.resolve(stored);
            }
            var payload = stored.slice(8);
            try {
                var dec = CryptoJS.AES.decrypt(payload, roomPassword);
                var plain = dec.toString(CryptoJS.enc.Utf8);
                if (!plain) {
                    return Promise.resolve(stored);
                }
                return Promise.resolve(plain);
            } catch (e) {
                return Promise.resolve(stored);
            }
        }
        if (stored.indexOf('enc:v1:') === 0) {
            return Promise.resolve(stored);
        }
        return Promise.resolve(stored);
    }

    function resolveMessageTextForDisplay(encodedFromServer) {
        var raw = decodeHtmlEntities(encodedFromServer);
        return decryptTextIfEncrypted(raw);
    }

    function mentionsMyNick(text) {
        if (!myNick || !text) return false;
        var at = '@' + myNick;
        var idx = text.indexOf(at);
        while (idx !== -1) {
            var beforeOk = idx === 0 || !/\w/.test(text.charAt(idx - 1));
            var afterIdx = idx + at.length;
            var afterOk = afterIdx >= text.length || !/\w/.test(text.charAt(afterIdx));
            if (beforeOk && afterOk) return true;
            idx = text.indexOf(at, idx + 1);
        }
        return false;
    }

    function getStringColor(str) {
        var s = String(str || '');
        var h = 0;
        for (var i = 0; i < s.length; i++) {
            h = (h << 5) - h + s.charCodeAt(i);
            h |= 0;
        }
        var hue = Math.abs(h) % 360;
        return 'hsl(' + hue + ', 70%, 65%)';
    }

    function resetPresenceState() {
        lastOnlineUsers = [];
        presenceSnapshotDone = false;
        onlineUsersForUi = [];
        if (el.onlineUsersList) {
            el.onlineUsersList.innerHTML = '';
        }
        hideMentionsDropdown();
    }

    function sortedCopyArray(arr) {
        return (arr || []).slice().sort();
    }

    function appendLocalSystemInfo(line, kind) {
        if (!el.messages) return;
        localInfoSeq += 1;
        var wrap = document.createElement('article');
        wrap.className =
            'msg-system-line ' + (kind === 'leave' ? 'sys-msg-leave' : 'sys-msg-join');
        wrap.setAttribute('data-local-info', String(localInfoSeq));
        wrap.setAttribute('role', 'status');
        wrap.textContent = line;
        el.messages.appendChild(wrap);
        scrollMessagesToBottom();
    }

    function normalizeOnlineUsersApi(raw) {
        var out = [];
        if (!Array.isArray(raw)) return out;
        var i;
        for (i = 0; i < raw.length; i++) {
            var item = raw[i];
            if (typeof item === 'string') {
                out.push({ nick: item, status: 'chat', time: 0 });
            } else if (item && typeof item === 'object' && typeof item.nick === 'string') {
                var st = item.status === 'whiteboard' ? 'whiteboard' : 'chat';
                out.push({
                    nick: item.nick,
                    status: st,
                    time: parseInt(String(item.time), 10) || 0
                });
            }
        }
        out.sort(function (a, b) {
            return a.nick < b.nick ? -1 : a.nick > b.nick ? 1 : 0;
        });
        return out;
    }

    function processPresenceOnlineUsers(onlineRaw) {
        if (!activeRoomKey || !myNick) return;
        var nextFull = normalizeOnlineUsersApi(onlineRaw);
        var next = nextFull.map(function (u) {
            return u.nick;
        });
        if (!presenceSnapshotDone) {
            lastOnlineUsers = next.slice();
            onlineUsersForUi = nextFull.slice();
            presenceSnapshotDone = true;
            return;
        }
        var prevSet = {};
        var nextSet = {};
        var i;
        for (i = 0; i < lastOnlineUsers.length; i++) {
            prevSet[lastOnlineUsers[i]] = true;
        }
        for (i = 0; i < next.length; i++) {
            nextSet[next[i]] = true;
        }
        for (i = 0; i < next.length; i++) {
            if (!prevSet[next[i]]) {
                appendLocalSystemInfo('[INFO] ' + next[i] + ' è entrato nella stanza.', 'join');
            }
        }
        for (i = 0; i < lastOnlineUsers.length; i++) {
            if (!nextSet[lastOnlineUsers[i]]) {
                appendLocalSystemInfo('[INFO] ' + lastOnlineUsers[i] + ' è uscito dalla stanza.', 'leave');
            }
        }
        lastOnlineUsers = next.slice();
        onlineUsersForUi = nextFull.slice();
    }

    function updateOnlineUsersListUI(list) {
        if (!el.onlineUsersList) return;
        el.onlineUsersList.innerHTML = '';
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var nick = typeof entry === 'object' && entry && entry.nick != null ? entry.nick : String(entry || '');
            var st = typeof entry === 'object' && entry && entry.status === 'whiteboard' ? 'whiteboard' : 'chat';
            var li = document.createElement('li');
            li.className = 'online-user-item';
            var dot = document.createElement('span');
            dot.className = 'online-dot';
            dot.setAttribute('aria-hidden', 'true');
            var statusIco = document.createElement('span');
            statusIco.className = 'online-app-status';
            statusIco.textContent = st === 'whiteboard' ? '🎨' : '💬';
            statusIco.title = st === 'whiteboard' ? 'In lavagna' : 'In chat';
            statusIco.setAttribute('aria-label', st === 'whiteboard' ? 'In lavagna' : 'In chat');
            var name = document.createElement('span');
            name.className = 'online-name';
            name.textContent = decodeHtmlEntities(nick);
            li.appendChild(dot);
            li.appendChild(statusIco);
            li.appendChild(name);
            el.onlineUsersList.appendChild(li);
        }
    }

    function buildReplyPrefix(msgId, nick, fullResolvedText) {
        var cleaned = String(fullResolvedText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\]/g, '');
        var snippet;
        if (cleaned.length <= REPLY_SNIPPET_MAX) {
            snippet = cleaned;
        } else {
            snippet = cleaned.slice(0, REPLY_SNIPPET_MAX) + '...';
        }
        var safeNick = String(nick || '').replace(/\|/g, '·');
        return '[REPLY:' + msgId + '|' + safeNick + '|' + snippet + ']';
    }

    /**
     * Risposta a immagine: payload [REPLY_IMG:nick:base64troncato] (nick senza ']', troncato max 50).
     */
    function buildReplyImgPrefix(nick, resolvedTrim) {
        var rest = String(resolvedTrim || '').trim();
        if (rest.indexOf('[IMG]') !== 0) return null;
        var tail = rest.slice(5);
        var ix = tail.indexOf('base64,');
        if (ix === -1) return null;
        var b64 = tail.slice(ix + 7).replace(/\s/g, '');
        var trunc = b64.slice(0, 50);
        if (!trunc.length) return null;
        var safeNick = String(nick || '').replace(/\]/g, '').replace(/\r|\n/g, ' ').trim();
        if (!safeNick.length) safeNick = '?';
        return '[REPLY_IMG:' + safeNick + ':' + trunc + ']';
    }

    function insertReplyPrefix(msgId, nick, fullResolvedText) {
        if (!el.msgInput) return;
        var imgPref = buildReplyImgPrefix(nick, fullResolvedText);
        var prefix = (imgPref != null ? imgPref : buildReplyPrefix(msgId, nick, fullResolvedText)) + '\n';
        el.msgInput.value = prefix + el.msgInput.value;
        el.msgInput.focus();
        var pos = prefix.length;
        el.msgInput.setSelectionRange(pos, pos);
        hideMentionsDropdown();
    }

    function getMentionMatch(text, caret) {
        if (caret == null || caret < 0) {
            caret = text.length;
        }
        var before = text.slice(0, caret);
        var m = before.match(/@([^\s@]*)$/);
        if (!m) return null;
        return {
            start: before.length - m[0].length,
            end: caret,
            query: m[1] || ''
        };
    }

    function hideMentionsDropdown() {
        mentionFiltered = [];
        if (el.mentionsDropdown) {
            el.mentionsDropdown.classList.add('hidden');
            el.mentionsDropdown.innerHTML = '';
        }
    }

    function isMentionsDropdownOpen() {
        return !!(el.mentionsDropdown && !el.mentionsDropdown.classList.contains('hidden') && mentionFiltered.length);
    }

    function updateMentionsDropdown() {
        if (!el.msgInput || !el.mentionsDropdown || !activeRoomKey) {
            hideMentionsDropdown();
            return;
        }
        var pos = el.msgInput.selectionStart;
        var val = el.msgInput.value;
        var mm = getMentionMatch(val, pos);
        if (!mm) {
            hideMentionsDropdown();
            return;
        }
        var q = (mm.query || '').toLowerCase();
        var list = onlineUsersForUi || [];
        var filtered = [];
        var i;
        for (i = 0; i < list.length; i++) {
            var entry = list[i];
            var n = typeof entry === 'object' && entry && entry.nick != null ? entry.nick : entry;
            var nickPlain = decodeHtmlEntities(String(n));
            var nd = nickPlain.toLowerCase();
            if (!q || nd.indexOf(q) === 0) {
                filtered.push(nickPlain);
            }
        }
        if (!filtered.length) {
            hideMentionsDropdown();
            return;
        }
        mentionFiltered = filtered.slice(0, 8);
        el.mentionsDropdown.innerHTML = '';
        for (var j = 0; j < mentionFiltered.length; j++) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mentions-dropdown-item';
            btn.textContent = decodeHtmlEntities(mentionFiltered[j]);
            btn.setAttribute('data-idx', String(j));
            btn.addEventListener('mousedown', function (ev) {
                ev.preventDefault();
                var ix = parseInt(ev.currentTarget.getAttribute('data-idx'), 10);
                applyMentionPick(isNaN(ix) ? 0 : ix);
            });
            el.mentionsDropdown.appendChild(btn);
        }
        el.mentionsDropdown.classList.remove('hidden');
    }

    function applyMentionPick(idx) {
        if (!el.msgInput) return;
        var caret = el.msgInput.selectionStart;
        var val = el.msgInput.value;
        var mm = getMentionMatch(val, caret);
        if (!mm || !mentionFiltered.length) return;
        var pick = mentionFiltered[idx];
        if (pick == null) return;
        var before = val.slice(0, mm.start);
        var after = val.slice(mm.end);
        var insert = '@' + pick + ' ';
        el.msgInput.value = before + insert + after;
        var nc = before.length + insert.length;
        el.msgInput.setSelectionRange(nc, nc);
        el.msgInput.focus();
        hideMentionsDropdown();
    }

    function openE2eePasswordModal(title, hint) {
        return new Promise(function (resolve) {
            e2eeModalResolve = resolve;
            if (el.modalE2eeTitle) el.modalE2eeTitle.textContent = title || 'Password E2EE';
            if (el.modalE2eeHint) el.modalE2eeHint.textContent = hint || '';
            if (el.e2eePassInput) el.e2eePassInput.value = '';
            if (el.modalE2ee) el.modalE2ee.removeAttribute('hidden');
            setTimeout(function () {
                if (el.e2eePassInput) el.e2eePassInput.focus();
            }, 30);
        });
    }

    function closeE2eeModalWithResult(val) {
        if (el.modalE2ee) el.modalE2ee.setAttribute('hidden', '');
        if (e2eeModalResolve) {
            e2eeModalResolve(val);
            e2eeModalResolve = null;
        }
    }

    function tryParseReplyBlock(textPlain) {
        var m = /^\[REPLY:(\d+)\|([^|]+)\|([\s\S]*?)\]\s*/.exec(textPlain);
        if (!m) return null;
        return {
            msgId: m[1],
            replyNick: m[2],
            snippet: m[3],
            rest: textPlain.slice(m[0].length)
        };
    }

    function tryParseReplyImgBlock(textPlain) {
        if (!textPlain || textPlain.indexOf('[REPLY_IMG:') !== 0) return null;
        var close = textPlain.indexOf(']');
        if (close < 12) return null;
        var inner = textPlain.slice(11, close);
        var li = inner.lastIndexOf(':');
        if (li < 1) return null;
        var trunc = inner.slice(li + 1);
        var nick = inner.slice(0, li);
        if (!/^[A-Za-z0-9+/=]{1,50}$/.test(trunc)) return null;
        return {
            replyNick: nick,
            truncRef: trunc,
            rest: textPlain.slice(close + 1).replace(/^\s+/, '')
        };
    }

    function renderReplyQuoteBlock(bodyEl, rp) {
        var quote = document.createElement('blockquote');
        quote.className = 'msg-reply-quote';
        var qh = document.createElement('div');
        qh.className = 'msg-reply-head';
        qh.textContent = 'Risposta a messaggio #' + rp.msgId + ' · ' + rp.replyNick;
        var qs = document.createElement('div');
        qs.className = 'msg-reply-snippet';
        qs.textContent = rp.snippet;
        quote.appendChild(qh);
        quote.appendChild(qs);
        bodyEl.appendChild(quote);
    }

    function renderReplyImgQuoteBlock(bodyEl, rp) {
        var quote = document.createElement('blockquote');
        quote.className = 'msg-reply-quote msg-reply-quote--media';
        var qh = document.createElement('div');
        qh.className = 'msg-reply-head';
        qh.textContent = 'Risposta a un media';
        var nickDisp = decodeHtmlEntities(rp.replyNick || '');
        var qs = document.createElement('div');
        qs.className = 'msg-reply-snippet msg-reply-snippet--media';
        qs.textContent = '📷 [Immagine di ' + nickDisp + ']';
        quote.appendChild(qh);
        quote.appendChild(qs);
        bodyEl.appendChild(quote);
    }

    function appendCodeBlock(parent, code) {
        var pre = document.createElement('pre');
        pre.className = 'msg-pre';
        var codeEl = document.createElement('code');
        codeEl.className = 'msg-code-block';
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        parent.appendChild(pre);
    }

    function appendPlainOrMe(parent, segment) {
        var m = /^\*([\s\S]*)\*$/.exec(segment);
        if (m && m[1].indexOf('*') === -1) {
            var em = document.createElement('em');
            em.className = 'msg-me-line';
            em.textContent = m[1];
            parent.appendChild(em);
            return;
        }
        if (segment.length) {
            var span = document.createElement('span');
            span.className = 'msg-text-run';
            span.textContent = segment;
            parent.appendChild(span);
        }
    }

    function appendFragmentsWithCodeBlocks(parent, textPlain) {
        var re = /```([\s\S]*?)```/g;
        var last = 0;
        var m;
        while ((m = re.exec(textPlain)) !== null) {
            if (m.index > last) {
                appendPlainOrMe(parent, textPlain.slice(last, m.index));
            }
            appendCodeBlock(parent, m[1]);
            last = m.lastIndex;
        }
        if (last < textPlain.length) {
            appendPlainOrMe(parent, textPlain.slice(last));
        }
    }

    function renderImgMessage(bodyEl, textPlain) {
        var rest = textPlain.slice(5);
        if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(rest)) {
            var img = document.createElement('img');
            img.className = 'msg-inline-img';
            img.alt = 'Immagine';
            img.loading = 'lazy';
            img.src = rest;
            bodyEl.appendChild(img);
        } else {
            bodyEl.textContent = textPlain;
        }
    }

    function renderFileAttachment(bodyEl, textPlain) {
        bodyEl.textContent = '';
        var fm = /^\[FILE:([^\]]+)\]([\s\S]+)$/.exec(textPlain);
        if (!fm) {
            bodyEl.textContent = textPlain;
            return;
        }
        var fname = fm[1];
        var dataHref = fm[2].trim();
        if (dataHref.indexOf('data:') !== 0) {
            var err = document.createElement('span');
            err.className = 'msg-file-error';
            err.textContent = 'Allegato non valido.';
            bodyEl.appendChild(err);
            return;
        }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-file-attach';
        btn.textContent = '📄 Scarica ' + fname;
        btn.addEventListener('click', function () {
            var a = document.createElement('a');
            a.href = dataHref;
            a.download = fname;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        });
        bodyEl.appendChild(btn);
    }

    function renderBurnMessage(wrap, bodyEl, textPlain) {
        var bm = /^\[BURN:(\d+)\]([\s\S]*)$/.exec(textPlain);
        if (!bm) {
            appendFragmentsWithCodeBlocks(bodyEl, textPlain);
            return;
        }
        var sec = parseInt(bm[1], 10);
        if (isNaN(sec) || sec < 1) sec = 1;
        if (sec > 86400) sec = 86400;
        var inner = bm[2] || '';

        appendFragmentsWithCodeBlocks(bodyEl, inner);

        var timerEl = document.createElement('div');
        timerEl.className = 'msg-burn-timer';
        bodyEl.appendChild(timerEl);

        var left = sec;
        timerEl.textContent = 'Autodistruzione tra ' + left + 's';
        var burnIv = setInterval(function () {
            left -= 1;
            if (left <= 0) {
                clearInterval(burnIv);
                timerEl.textContent = 'Eliminato';
            } else {
                timerEl.textContent = 'Autodistruzione tra ' + left + 's';
            }
        }, 1000);

        var tid = setTimeout(function () {
            clearInterval(burnIv);
            if (wrap && wrap.parentNode) {
                wrap.parentNode.removeChild(wrap);
            }
        }, sec * 1000);
        burnTimeouts.push({ to: tid, iv: burnIv });
    }

    function renderMessageBody(wrap, bodyEl, textPlain) {
        bodyEl.textContent = '';

        var rpi = tryParseReplyImgBlock(textPlain);
        if (rpi) {
            renderReplyImgQuoteBlock(bodyEl, rpi);
            if (rpi.rest && rpi.rest.trim()) {
                var afterImg = document.createElement('div');
                afterImg.className = 'msg-reply-after';
                bodyEl.appendChild(afterImg);
                renderMessageBody(wrap, afterImg, rpi.rest.trim());
            }
            return;
        }

        var rp = tryParseReplyBlock(textPlain);
        if (rp) {
            renderReplyQuoteBlock(bodyEl, rp);
            if (rp.rest && rp.rest.trim()) {
                var afterEl = document.createElement('div');
                afterEl.className = 'msg-reply-after';
                bodyEl.appendChild(afterEl);
                renderMessageBody(wrap, afterEl, rp.rest.trim());
            }
            return;
        }

        if (textPlain.indexOf('[IMG]') === 0) {
            renderImgMessage(bodyEl, textPlain);
            return;
        }
        if (/^\[FILE:/.test(textPlain)) {
            renderFileAttachment(bodyEl, textPlain);
            return;
        }
        if (/^\[BURN:\d+\]/.test(textPlain)) {
            renderBurnMessage(wrap, bodyEl, textPlain);
            return;
        }

        var m = /^\*([\s\S]*)\*$/.exec(textPlain);
        if (m && m[1].indexOf('*') === -1 && textPlain.indexOf('```') === -1) {
            var em = document.createElement('em');
            em.className = 'msg-me-line';
            em.textContent = m[1];
            bodyEl.appendChild(em);
            return;
        }

        if (textPlain.indexOf('```') !== -1) {
            appendFragmentsWithCodeBlocks(bodyEl, textPlain);
            return;
        }

        bodyEl.textContent = textPlain;
    }

    function parsePollCommand(line) {
        if (!/^\/poll(\s|$)/i.test(line)) return null;
        var rest = line.replace(/^\/poll\s+/i, '').trim();
        var parts = [];
        var re = /"((?:[^"\\]|\\.)*)"/g;
        var q;
        while ((q = re.exec(rest)) !== null) {
            parts.push(q[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));
        }
        if (parts.length < 3 || parts.length > 5) return null;
        return { question: parts[0], options: parts.slice(1) };
    }

    function mergePollVoteCounts(pollId, numOptions) {
        var next = [];
        var prev = pollVoteStore[pollId];
        var i;
        for (i = 0; i < numOptions; i++) {
            next.push(prev && prev[i] != null ? prev[i] : 0);
        }
        pollVoteStore[pollId] = next;
    }

    function applyVoteToPollUI(pollIdStr, optIdx) {
        if (!pollVoteStore[pollIdStr]) {
            pollVoteStore[pollIdStr] = [];
        }
        var arr = pollVoteStore[pollIdStr];
        while (arr.length <= optIdx) {
            arr.push(0);
        }
        if (optIdx < 0) return;
        arr[optIdx] += 1;
        if (!el.messages) return;
        var root = el.messages.querySelector('.msg-poll[data-poll-id="' + pollIdStr + '"]');
        if (root) {
            updatePollBarsForRoot(root, pollIdStr);
        }
    }

    function updatePollBarsForRoot(root, pollIdStr) {
        var arr = pollVoteStore[pollIdStr];
        if (!arr) return;
        var total = 0;
        var i;
        for (i = 0; i < arr.length; i++) {
            total += arr[i] || 0;
        }
        var rows = root.querySelectorAll('.msg-poll-row');
        for (i = 0; i < rows.length; i++) {
            var idx = parseInt(rows[i].getAttribute('data-option-index'), 10);
            var c = !isNaN(idx) && arr[idx] != null ? arr[idx] : 0;
            var pct = total > 0 ? Math.round((c * 1000) / total) / 10 : 0;
            var fill = rows[i].querySelector('.msg-poll-fill');
            var pctEl = rows[i].querySelector('.msg-poll-pct');
            if (fill) fill.style.width = pct + '%';
            if (pctEl) pctEl.textContent = pct + '%';
        }
    }

    function onPollVoteClick(ev) {
        var btn = ev.currentTarget;
        if (!btn || !activeRoomKey || !myNick) return;
        var pid = btn.getAttribute('data-poll-id');
        var idx = parseInt(btn.getAttribute('data-option-index'), 10);
        if (!pid || isNaN(idx)) return;
        var voteWire = '[VOTE:' + pid + ':' + idx + ']';
        deliverOutgoingToServer(voteWire, { skipInputClear: true, skipSendLock: true });
    }

    function renderPollMessage(wrap, bodyEl, resolvedFull) {
        bodyEl.textContent = '';
        bodyEl.className = 'msg-body msg-poll-body';
        var pm = /^\[POLL:(\d+)\]\s*(.*)$/.exec(resolvedFull.trim());
        if (!pm) {
            bodyEl.textContent = resolvedFull;
            return;
        }
        var pollId = pm[1];
        var tail = pm[2];
        var parts = tail.split(' | ').map(function (s) {
            return String(s).trim();
        });
        if (parts.length < 2) {
            bodyEl.textContent = resolvedFull;
            return;
        }
        var question = parts[0];
        var options = parts.slice(1);
        wrap.classList.add('msg-poll');
        wrap.setAttribute('data-poll-id', pollId);

        mergePollVoteCounts(pollId, options.length);

        var qEl = document.createElement('div');
        qEl.className = 'msg-poll-question';
        qEl.textContent = question;
        bodyEl.appendChild(qEl);

        var optsWrap = document.createElement('div');
        optsWrap.className = 'msg-poll-options';
        var i;
        for (i = 0; i < options.length; i++) {
            var row = document.createElement('div');
            row.className = 'msg-poll-row';
            row.setAttribute('data-option-index', String(i));
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'msg-poll-vote-btn';
            btn.textContent = options[i];
            btn.setAttribute('data-poll-id', pollId);
            btn.setAttribute('data-option-index', String(i));
            btn.addEventListener('click', onPollVoteClick);
            var track = document.createElement('div');
            track.className = 'msg-poll-track';
            var fill = document.createElement('div');
            fill.className = 'msg-poll-fill';
            var pct = document.createElement('span');
            pct.className = 'msg-poll-pct';
            pct.textContent = '0%';
            track.appendChild(fill);
            row.appendChild(btn);
            row.appendChild(track);
            row.appendChild(pct);
            optsWrap.appendChild(row);
        }
        bodyEl.appendChild(optsWrap);
        updatePollBarsForRoot(wrap, pollId);
    }

    function stopHackOverlay() {
        if (hackInterval) {
            clearInterval(hackInterval);
            hackInterval = null;
        }
        if (hackEndTimer) {
            clearTimeout(hackEndTimer);
            hackEndTimer = null;
        }
        if (el.hackTerminal) {
            el.hackTerminal.textContent = '';
        }
        if (el.hackOverlay) {
            el.hackOverlay.classList.add('hidden');
            el.hackOverlay.setAttribute('aria-hidden', 'true');
        }
    }

    function startHackOverlay() {
        stopHackOverlay();
        if (!el.hackOverlay || !el.hackTerminal) return;
        el.hackOverlay.classList.remove('hidden');
        el.hackOverlay.setAttribute('aria-hidden', 'false');
        hackInterval = setInterval(function () {
            var line = document.createElement('div');
            line.className = 'hack-line';
            line.textContent = HACK_FAKE_LINES[Math.floor(Math.random() * HACK_FAKE_LINES.length)];
            el.hackTerminal.appendChild(line);
            el.hackTerminal.scrollTop = el.hackTerminal.scrollHeight;
        }, 48);
        hackEndTimer = setTimeout(function () {
            stopHackOverlay();
        }, 4500);
    }

    function deliverOutgoingToServer(outgoing, options) {
        options = options || {};
        var skipInputClear = options.skipInputClear === true;
        var skipSendLock = options.skipSendLock === true;
        if (!outgoing || !activeRoomKey || !myNick) return;
        if (outgoing.length > MAX_SERVER_TEXT) {
            window.alert('Messaggio troppo lungo (max ' + MAX_SERVER_TEXT + ' caratteri).');
            return;
        }

        var done = function () {
            if (!skipSendLock && el.sendBtn) el.sendBtn.disabled = false;
        };

        if (!skipSendLock && el.sendBtn) el.sendBtn.disabled = true;

        var sendPayload = function (textToSend) {
            fetch('api.php?action=send', {
                method: 'POST',
                cache: 'no-store',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({ room: activeRoomKey, nick: myNick, text: textToSend })
            })
                .then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                })
                .then(function (data) {
                    if (!data || data.ok !== true) {
                        throw new Error(data && data.error ? data.error : 'Invio fallito');
                    }
                    if (typeof data.room_key === 'string' && data.room_key.length) {
                        activeRoomKey = data.room_key;
                        updateRoomTitle();
                    }
                    roomWasPersisted = true;
                    if (!skipInputClear && el.msgInput) {
                        el.msgInput.value = '';
                        el.msgInput.focus();
                    }
                })
                .catch(function () {
                    setConnState('err');
                })
                .then(done, done);
        };

        if (roomPassword && hasCryptoJs()) {
            encryptTextForSend(outgoing)
                .then(function (cipher) {
                    if (cipher.length > MAX_SERVER_TEXT) {
                        window.alert('Messaggio cifrato troppo lungo (max ' + MAX_SERVER_TEXT + ' caratteri).');
                        done();
                        return;
                    }
                    sendPayload(cipher);
                })
                .catch(function () {
                    setConnState('err');
                    done();
                });
        } else {
            sendPayload(outgoing);
        }
    }

    function postSetTyping(isTyping) {
        if (!activeRoomKey || !myNick) return;
        fetch('api.php?action=set_typing', {
            method: 'POST',
            cache: 'no-store',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                room: activeRoomKey,
                nick: myNick,
                is_typing: !!isTyping
            })
        }).catch(function () {});
    }

    function scheduleTypingFromInput() {
        if (!activeRoomKey || !myNick) return;
        if (typingToTrueTimer) {
            clearTimeout(typingToTrueTimer);
        }
        typingToTrueTimer = setTimeout(function () {
            typingToTrueTimer = null;
            postSetTyping(true);
        }, 200);

        if (typingToFalseTimer) {
            clearTimeout(typingToFalseTimer);
        }
        typingToFalseTimer = setTimeout(function () {
            typingToFalseTimer = null;
            postSetTyping(false);
        }, 2000);
    }

    function flushTypingState() {
        if (typingToTrueTimer) {
            clearTimeout(typingToTrueTimer);
            typingToTrueTimer = null;
        }
        if (typingToFalseTimer) {
            clearTimeout(typingToFalseTimer);
            typingToFalseTimer = null;
        }
        postSetTyping(false);
        hideMentionsDropdown();
        if (el.chatScreen) {
            el.chatScreen.classList.remove('chat-screen--drag');
        }
        if (el.typingIndicator) {
            el.typingIndicator.classList.add('hidden');
            el.typingIndicator.textContent = '';
        }
    }

    function updateTypingIndicatorFromServer(typingArr) {
        if (!el.typingIndicator) return;
        if (!Array.isArray(typingArr)) typingArr = [];
        var others = [];
        var i;
        for (i = 0; i < typingArr.length; i++) {
            var dec = decodeHtmlEntities(typingArr[i]);
            if (dec && dec !== myNick) {
                others.push(dec);
            }
        }
        if (!others.length) {
            el.typingIndicator.classList.add('hidden');
            el.typingIndicator.textContent = '';
            return;
        }
        el.typingIndicator.classList.remove('hidden');
        var label;
        if (others.length === 1) {
            label = others[0] + ' sta scrivendo…';
        } else {
            var slice = others.slice(0, 3);
            label = slice.join(', ') + (others.length > 3 ? '…' : '') + ' stanno scrivendo…';
        }
        el.typingIndicator.textContent = label;
    }

    function processDroppedFile(file) {
        if (!file || !file.size) return;
        if (file.size > MAX_FILE_DROP_BYTES) {
            window.alert('File troppo grande (massimo 1 MB).');
            return;
        }
        var rawName = file.name || 'file.bin';
        var safeName = String(rawName).replace(/[\[\]]/g, '_').replace(/[\\/]/g, '_');
        if (!safeName.length) safeName = 'file.bin';
        var reader = new FileReader();
        reader.onerror = function () {
            window.alert('Impossibile leggere il file.');
        };
        reader.onload = function () {
            var dataUrl = reader.result;
            if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) {
                window.alert('Formato file non supportato.');
                return;
            }
            var payload = '[FILE:' + safeName + ']' + dataUrl;
            deliverOutgoingToServer(payload, {});
        };
        reader.readAsDataURL(file);
    }

    function bindChatFileDragDrop() {
        if (!el.chatScreen) return;
        el.chatScreen.addEventListener('dragenter', function (e) {
            if (!activeRoomKey) return;
            e.preventDefault();
            el.chatScreen.classList.add('chat-screen--drag');
        });
        el.chatScreen.addEventListener('dragover', function (e) {
            if (!activeRoomKey) return;
            e.preventDefault();
        });
        el.chatScreen.addEventListener('dragleave', function (e) {
            if (!el.chatScreen.contains(e.relatedTarget)) {
                el.chatScreen.classList.remove('chat-screen--drag');
            }
        });
        el.chatScreen.addEventListener('drop', function (e) {
            if (!activeRoomKey) return;
            e.preventDefault();
            el.chatScreen.classList.remove('chat-screen--drag');
            var dt = e.dataTransfer;
            if (!dt || !dt.files || !dt.files.length) return;
            processDroppedFile(dt.files[0]);
        });
    }

    function isControlWireMessageSkipReadReceipt(trimmed) {
        if (!trimmed) return true;
        return (
            /^\[READ:\d+\]\s*$/.test(trimmed) ||
            /^\[REACT:\d+:/.test(trimmed) ||
            /^\[VOTE:\d+:\d+\]\s*$/.test(trimmed) ||
            /^\[DRAWB\]/.test(trimmed) ||
            /^\[DRAW_CLEAR\]/.test(trimmed) ||
            /^\[DRAW:/.test(trimmed) ||
            /^\[DRAW_TEXT:/.test(trimmed)
        );
    }

    function ensureOutgoingMessageTicks(wrap) {
        if (!wrap || !wrap.classList.contains('me')) return;
        if (wrap.querySelector('.message-ticks')) return;
        var tick = document.createElement('span');
        tick.className = 'message-ticks';
        tick.setAttribute('aria-hidden', 'true');
        wrap.appendChild(tick);
    }

    function maybeSendReadReceipt(msgId, resolvedTrim, msgTimeSec) {
        if (!activeRoomKey || !myNick) return;
        var tid = parseInt(String(msgId), 10);
        if (isNaN(tid) || tid < 1) return;
        if (readReceiptSentSet[tid]) return;
        if (isControlWireMessageSkipReadReceipt(resolvedTrim)) return;
        if (typeof msgTimeSec !== 'number' || isNaN(msgTimeSec)) return;
        if (msgTimeSec < readReceiptMinEligibleTimeSec) return;
        readReceiptSentSet[tid] = true;
        if (document.hidden) {
            if (pendingReadReceipts.indexOf(tid) === -1) {
                pendingReadReceipts.push(tid);
            }
            return;
        }
        deliverOutgoingToServer('[READ:' + tid + ']', { skipInputClear: true, skipSendLock: true });
    }

    function flushPendingReadReceipts() {
        if (document.hidden || !activeRoomKey || !myNick) return;
        if (!pendingReadReceipts.length) return;
        var list = pendingReadReceipts.slice();
        pendingReadReceipts.length = 0;
        var i;
        for (i = 0; i < list.length; i++) {
            (function (tid, delayMs) {
                setTimeout(function () {
                    if (!activeRoomKey || !myNick || document.hidden) return;
                    deliverOutgoingToServer('[READ:' + tid + ']', {
                        skipInputClear: true,
                        skipSendLock: true
                    });
                }, delayMs);
            })(list[i], i * 50);
        }
    }

    function exportChatToTxtFile() {
        if (!el.messages) return;
        var parts = [];
        var articles = el.messages.querySelectorAll('article.msg');
        var i;
        for (i = 0; i < articles.length; i++) {
            var art = articles[i];
            var ts = parseInt(art.getAttribute('data-msg-time'), 10);
            var when = !isNaN(ts) ? formatExportDateTime(ts) : '?';
            var nickEl = art.querySelector('.msg-nick');
            var nick = nickEl ? nickEl.textContent.replace(/\s+/g, ' ').trim() : '?';
            var body = art.querySelector('.msg-body');
            var lineBody;
            if (!body) {
                lineBody = '';
            } else if (body.querySelector('.msg-inline-img')) {
                lineBody = '[Immagine condivisa]';
            } else if (body.querySelector('.msg-file-attach')) {
                lineBody = '[File condiviso]';
            } else if (art.classList.contains('msg-poll')) {
                var qEl = body.querySelector('.msg-poll-question');
                lineBody = '[Sondaggio] ' + (qEl ? qEl.textContent.replace(/\s+/g, ' ').trim() : '');
            } else {
                lineBody = body.innerText.replace(/\s+/g, ' ').trim();
            }
            parts.push('[' + when + '] ' + nick + ': ' + lineBody);
        }
        var text = parts.join('\r\n');
        var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'chat_export.txt';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 4000);
    }

    function appendMessageNode(m) {
        resolveMessageTextForDisplay(m.text).then(function (resolved) {
            var resolvedTrim = resolved.trim();
            var nickPlainEarly = decodeHtmlEntities(m.nick);
            if (/^\[DRAW_CLEAR\]\s*$/.test(resolvedTrim)) {
                whiteboardClearCanvasVisual();
                whiteboardClearRemoteCursors();
                return;
            }
            if (/^\[DRAWB\]/.test(resolvedTrim)) {
                if (nickPlainEarly !== myNick) {
                    var batchBody = resolvedTrim.slice(WB_DRAW_PREFIX.length);
                    whiteboardApplyBatchPayload(batchBody);
                    whiteboardRemoteCursorFromDrawBatch(nickPlainEarly, batchBody);
                }
                return;
            }
            if (/^\[DRAW:/.test(resolvedTrim)) {
                if (nickPlainEarly !== myNick) {
                    whiteboardApplySingleLegacy(resolvedTrim);
                    whiteboardRemoteCursorFromLegacyDraw(nickPlainEarly, resolvedTrim);
                }
                return;
            }
            if (/^\[DRAW_TEXT:/.test(resolvedTrim)) {
                if (nickPlainEarly !== myNick) {
                    whiteboardApplyDrawTextResolved(resolvedTrim);
                    whiteboardRemoteCursorFromDrawText(nickPlainEarly, resolvedTrim);
                }
                return;
            }
            if (/^\[VOTE:\d+:\d+\]\s*$/.test(resolvedTrim)) {
                var vm = resolvedTrim.match(/^\[VOTE:(\d+):(\d+)\]\s*$/);
                if (vm) {
                    applyVoteToPollUI(vm[1], parseInt(vm[2], 10));
                }
                return;
            }
            if (/^\[REACT:\d+:/.test(resolvedTrim)) {
                var prm = resolvedTrim.match(/^\[REACT:(\d+):([^\]]+)\]\s*$/);
                if (prm) {
                    applyReactionToMessageDom(parseInt(prm[1], 10), prm[2].trim());
                    flushPendingReactions();
                }
                return;
            }
            if (/^\[READ:(\d+)\]\s*$/.test(resolvedTrim)) {
                var readM = resolvedTrim.match(/^\[READ:(\d+)\]\s*$/);
                if (readM && nickPlainEarly !== myNick && el.messages) {
                    var ticksEl = el.messages.querySelector(
                        '.msg.me[data-id="' + readM[1] + '"] .message-ticks'
                    );
                    if (ticksEl) ticksEl.classList.add('read-ticks');
                }
                return;
            }

            var nickPlain = nickPlainEarly;

            var wrap = document.createElement('article');
            wrap.className = 'msg' + (nickPlain === myNick ? ' me' : '');
            wrap.dataset.id = String(m.id);
            wrap.setAttribute('data-msg-time', String(m.time));

            var meta = document.createElement('div');
            meta.className = 'msg-meta';

            var nickSpan = document.createElement('span');
            nickSpan.className = 'msg-nick';
            nickSpan.textContent = nickPlain;
            nickSpan.style.color = getStringColor(nickPlain);

            var timeSpan = document.createElement('span');
            timeSpan.className = 'msg-time';
            timeSpan.textContent = formatTime(m.time);

            meta.appendChild(nickSpan);
            meta.appendChild(timeSpan);

            var body = document.createElement('div');
            body.className = 'msg-body';

            wrap.appendChild(meta);
            wrap.appendChild(body);

            wrap.addEventListener('contextmenu', function (ev) {
                ev.preventDefault();
                insertReplyPrefix(m.id, nickPlain, resolvedTrim);
            });

            if (/^\[POLL:\d+\]/.test(resolvedTrim)) {
                renderPollMessage(wrap, body, resolved);
            } else {
                if (mentionsMyNick(resolved)) {
                    wrap.classList.add('msg-mention');
                }
                renderMessageBody(wrap, body, resolved);
            }

            buildMessageFooterActions(wrap, m, nickPlain, resolvedTrim);
            if (nickPlain === myNick) {
                ensureOutgoingMessageTicks(wrap);
            }
            el.messages.appendChild(wrap);
            flushPendingReactions();

            if (nickPlain !== myNick) {
                maybeSendReadReceipt(m.id, resolvedTrim, m.time);
            }

            scrollMessagesToBottom();
        });
    }

    function clearMessages() {
        clearAllBurnTimeouts();
        pollVoteStore = {};
        pendingReactions = [];
        readReceiptSentSet = {};
        pendingReadReceipts.length = 0;
        while (el.messages.firstChild) {
            el.messages.removeChild(el.messages.firstChild);
        }
    }

    function updateHostPanel(waitingList) {
        if (!el.hostPanel || !el.hostWaitingList) return;
        el.hostWaitingList.innerHTML = '';
        if (!isHostCurrent || !waitingList || waitingList.length === 0) {
            el.hostPanel.hidden = true;
            return;
        }
        el.hostPanel.hidden = false;
        for (var i = 0; i < waitingList.length; i++) {
            var wnick = waitingList[i];
            var li = document.createElement('li');
            li.className = 'host-wait-item';
            var span = document.createElement('span');
            span.className = 'nick';
            span.textContent = decodeHtmlEntities(wnick);
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-approve';
            btn.textContent = 'Approva';
            btn.dataset.target = wnick;
            btn.addEventListener('click', function (ev) {
                var t = ev.currentTarget && ev.currentTarget.dataset ? ev.currentTarget.dataset.target : '';
                if (t) approveUser(t);
            });
            li.appendChild(span);
            li.appendChild(btn);
            el.hostWaitingList.appendChild(li);
        }
    }

    function approveUser(targetSan) {
        if (!activeRoomKey || !myNick || !targetSan) return;
        fetch('api.php?action=approve_user', {
            method: 'POST',
            cache: 'no-store',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ room: activeRoomKey, host: myNick, target: targetSan })
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!data || data.ok !== true) {
                    throw new Error(data && data.error ? data.error : 'Approvazione fallita');
                }
            })
            .catch(function () {
                window.alert('Impossibile approvare l’utente. Verifica di essere l’host.');
            });
    }

    function pollChat() {
        if (!activeRoomKey || !myNick) return;

        var url =
            'api.php?action=fetch&room=' +
            encodeURIComponent(activeRoomKey) +
            '&after=' +
            encodeURIComponent(String(lastMessageId)) +
            '&nick=' +
            encodeURIComponent(myNick) +
            '&status=' +
            encodeURIComponent(currentAppStatus);

        if (typeof fetch !== 'function') {
            setConnState('err');
            return;
        }

        fetch(url, {
            method: 'GET',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!data || data.ok !== true) {
                    throw new Error(data && data.error ? data.error : 'Risposta non valida');
                }

                if (typeof data.room_key === 'string' && data.room_key.length) {
                    activeRoomKey = data.room_key;
                    updateRoomTitle();
                }

                if (data.room_present === true) {
                    roomWasPersisted = true;
                }

                if (data.room_present === false && roomWasPersisted) {
                    stopAllPolls();
                    enterLobbyFromChat('La stanza è stata chiusa.');
                    return;
                }

                if (data.access !== true) {
                    stopAllPolls();
                    enterLobbyFromChat('Accesso ai messaggi di questa stanza non consentito. Se è privata, attendi l’approvazione dell’host dalla lobby.');
                    return;
                }

                isHostCurrent = data.is_host === true;
                if (el.deleteRoomBtn) {
                    el.deleteRoomBtn.hidden = !isHostCurrent;
                }
                updateHostPanel(data.waiting_list || []);

                setConnState('ok');
                if (Array.isArray(data.messages)) {
                    data.messages.forEach(function (m) {
                        if (m.id > lastMessageId) {
                            lastMessageId = m.id;
                            appendMessageNode(m);
                            if (document.hidden && decodeHtmlEntities(m.nick) !== myNick) {
                                resolveMessageTextForDisplay(m.text).then(function (preview) {
                                    var pv = preview.trim();
                                    if (/^\[VOTE:\d+:\d+\]\s*$/.test(pv)) {
                                        return;
                                    }
                                    if (/^\[POLL:\d+\]/.test(pv)) {
                                        bumpHiddenUnread('[Sondaggio]');
                                        return;
                                    }
                                    if (/^\[REACT:\d+:/.test(pv)) {
                                        return;
                                    }
                                    if (/^\[READ:\d+\]\s*$/.test(pv)) {
                                        return;
                                    }
                                    if (/^\[DRAWB\]/.test(pv) || /^\[DRAW_CLEAR\]/.test(pv) || /^\[DRAW:/.test(pv) || /^\[DRAW_TEXT:/.test(pv)) {
                                        return;
                                    }
                                    if (/^\[FILE:/.test(pv)) {
                                        bumpHiddenUnread('[File]');
                                        return;
                                    }
                                    var short =
                                        preview.indexOf('[IMG]') === 0 ? '[Immagine]' : preview.replace(/\s+/g, ' ').slice(0, 200);
                                    bumpHiddenUnread(short);
                                });
                            }
                        }
                    });
                }
                updateTypingIndicatorFromServer(data.typing || []);
                var online = Array.isArray(data.online_users) ? data.online_users : [];
                processPresenceOnlineUsers(online);
                updateOnlineUsersListUI(onlineUsersForUi);
            })
            .catch(function () {
                setConnState('err');
            });
    }

    function pollWaitingFetch() {
        if (!waitingRoomKey || !myNick) return;

        var url =
            'api.php?action=fetch&room=' +
            encodeURIComponent(waitingRoomKey) +
            '&after=0&nick=' +
            encodeURIComponent(myNick) +
            '&status=' +
            encodeURIComponent(currentAppStatus);

        fetch(url, { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!data || data.ok !== true) return;

                if (data.room_present === false) {
                    stopAllPolls();
                    showLobbyScreen();
                    showLobbyError('La stanza non esiste più.');
                    return;
                }

                if (data.access === true) {
                    stopAllPolls();
                    activeRoomKey = waitingRoomKey;
                    waitingRoomKey = '';
                    lastMessageId = 0;
                    clearMessages();
                    readReceiptMinEligibleTimeSec = Math.floor(Date.now() / 1000) - 5;
                    resetPresenceState();
                    roomWasPersisted = true;
                    showChatShell();
                    chatTimer = setInterval(pollChat, POLL_CHAT_MS);
                    pollChat();
                }
            })
            .catch(function () {});
    }

    function fetchLobbyOnce() {
        if (typeof fetch !== 'function') return;
        fetch('api.php?action=lobby', { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!data || data.ok !== true || !Array.isArray(data.rooms)) {
                    throw new Error('Lobby non valida');
                }
                hideLobbyError();
                renderLobbyRooms(data.rooms);
            })
            .catch(function () {
                showLobbyError('Impossibile caricare la lobby. Riprova.');
            });
    }

    function renderLobbyRooms(rooms) {
        if (!el.lobbyList || !el.lobbyEmpty) return;
        el.lobbyList.innerHTML = '';
        if (!rooms.length) {
            el.lobbyEmpty.hidden = false;
            return;
        }
        el.lobbyEmpty.hidden = true;
        for (var i = 0; i < rooms.length; i++) {
            var r = rooms[i];
            var li = document.createElement('li');
            li.className = 'lobby-item';

            var meta = document.createElement('div');
            meta.className = 'lobby-item-meta';
            var nameEl = document.createElement('div');
            nameEl.className = 'lobby-item-name';
            nameEl.textContent = r.room || '';
            var det = document.createElement('div');
            det.className = 'lobby-item-details';
            var hostPlain = decodeHtmlEntities(r.host || '');
            det.appendChild(document.createTextNode('Host: ' + hostPlain + ' '));
            var badge = document.createElement('span');
            badge.className = 'badge-type ' + (r.type === 'private' ? 'badge-type-private' : 'badge-type-public');
            badge.textContent = r.type === 'private' ? 'Privata' : 'Pubblica';
            det.appendChild(badge);
            meta.appendChild(nameEl);
            meta.appendChild(det);

            var actions = document.createElement('div');
            actions.className = 'lobby-item-actions';

            if (r.type === 'private') {
                var bReq = document.createElement('button');
                bReq.type = 'button';
                bReq.className = 'btn btn-primary';
                bReq.textContent = 'Richiedi accesso';
                bReq.dataset.room = r.room;
                bReq.addEventListener('click', onLobbyRequestPrivate);
                actions.appendChild(bReq);
            } else {
                var bIn = document.createElement('button');
                bIn.type = 'button';
                bIn.className = 'btn btn-primary';
                bIn.textContent = 'Entra';
                bIn.dataset.room = r.room;
                bIn.addEventListener('click', onLobbyEnterPublic);
                actions.appendChild(bIn);
            }

            li.appendChild(meta);
            li.appendChild(actions);
            el.lobbyList.appendChild(li);
        }
    }

    function onLobbyEnterPublic(ev) {
        var room = ev.currentTarget.dataset.room;
        if (!room) return;
        openE2eePasswordModal(
            'Password E2EE',
            'Opzionale; non viene inviata al server. Usa la stessa chiave dei compagni di stanza.'
        ).then(function (pwd) {
            if (pwd === null) return;
            enterChatWithRoom(room, pwd);
        });
    }

    function onLobbyRequestPrivate(ev) {
        var room = ev.currentTarget.dataset.room;
        if (!room) return;
        openE2eePasswordModal(
            'Password E2EE',
            'Solo nel browser, in attesa di approvazione. Opzionale se la stanza non usa E2EE.'
        ).then(function (pwd) {
            if (pwd === null) return;
            postJson('api.php?action=request_join', { room: room, nick: myNick })
                .then(function () {
                    enterWaitingForRoom(room, pwd);
                })
                .catch(function (err) {
                    window.alert(
                        err && err.message
                            ? err.message
                            : 'Impossibile inviare la richiesta. Verifica rete e api.php.'
                    );
                });
        });
    }

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            cache: 'no-store',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(body)
        }).then(function (res) {
            return res.text().then(function (text) {
                var j = null;
                if (text) {
                    try {
                        j = JSON.parse(text);
                    } catch (parseErr) {
                        var snippet = text.replace(/\s+/g, ' ').slice(0, 180);
                        throw new Error(
                            'Risposta non JSON dal server (HTTP ' +
                                res.status +
                                '). Spesso è un errore PHP: controlla il log Apache e che api.php sia raggiungibile. Anteprima: ' +
                                snippet
                        );
                    }
                }
                if (!res.ok) {
                    var errHttp = j && j.error ? String(j.error) : 'HTTP ' + res.status;
                    throw new Error(errHttp);
                }
                if (!j || j.ok !== true) {
                    throw new Error(j && j.error ? String(j.error) : 'Operazione non riuscita');
                }
                return j;
            });
        });
    }

    function enterWaitingForRoom(room, pwd) {
        flushTypingState();
        resetPresenceState();
        stopAllPolls();
        hideLobbyScreen();
        waitingRoomKey = room;
        roomPassword = pwd || '';
        invalidateCryptoCache();
        if (el.waitingRoomName) el.waitingRoomName.textContent = room;
        showScreen('waiting-screen');
        waitingTimer = setInterval(pollWaitingFetch, POLL_WAITING_MS);
        pollWaitingFetch();
    }

    function enterChatWithRoom(room, pwd) {
        flushTypingState();
        resetPresenceState();
        stopAllPolls();
        hideLobbyScreen();
        activeRoomKey = room;
        waitingRoomKey = '';
        roomPassword = pwd || '';
        invalidateCryptoCache();
        lastMessageId = 0;
        clearMessages();
        readReceiptMinEligibleTimeSec = Math.floor(Date.now() / 1000) - 5;
        whiteboardResetForNewRoom();
        roomWasPersisted = true;
        updateRoomTitle();
        if (el.youNick) el.youNick.textContent = myNick;
        showChatShell();
        chatTimer = setInterval(pollChat, POLL_CHAT_MS);
        pollChat();
    }

    function showChatShell() {
        showScreen('chat-screen');
        if (el.whiteboardOpenBtn) el.whiteboardOpenBtn.hidden = false;
        if (el.msgInput) el.msgInput.focus();
    }

    function hideLobbyScreen() {
        lobbyTimer = stopTimer(lobbyTimer);
    }

    function showLobbyScreen() {
        showScreen('lobby-screen');
        if (el.lobbyYouNick) el.lobbyYouNick.textContent = myNick;
        lobbyTimer = setInterval(fetchLobbyOnce, POLL_LOBBY_MS);
        fetchLobbyOnce();
    }

    function enterLobbyFromChat(msg) {
        resetTitleBlink();
        flushTypingState();
        resetPresenceState();
        clearAllBurnTimeouts();
        invalidateCryptoCache();
        roomPassword = '';
        lastMessageId = 0;
        activeRoomKey = '';
        waitingRoomKey = '';
        roomWasPersisted = false;
        isHostCurrent = false;
        readReceiptMinEligibleTimeSec = 9007199254740991;
        clearMessages();
        whiteboardResetForNewRoom();
        if (el.whiteboardOpenBtn) el.whiteboardOpenBtn.hidden = true;
        if (el.msgInput) el.msgInput.value = '';
        updateRoomTitle();
        if (el.hostPanel) el.hostPanel.hidden = true;
        if (el.deleteRoomBtn) el.deleteRoomBtn.hidden = true;
        stopAllPolls();
        showLobbyScreen();
        if (msg) window.alert(msg);
    }

    function applySlashCommands(trimmed) {
        if (!trimmed || trimmed.charAt(0) !== '/') {
            return { outgoing: trimmed };
        }
        if (trimmed === '/clear') {
            clearMessages();
            return { handled: true };
        }
        if (/^\/poll(\s|$)/i.test(trimmed)) {
            var parsedPoll = parsePollCommand(trimmed);
            if (!parsedPoll) {
                window.alert('Uso: /poll "Domanda" "Opzione1" "Opzione2" ["Op3"] ["Op4"]\nMinimo 2 opzioni, massimo 4.');
                return { handled: true };
            }
            var pollId = Date.now();
            var wirePoll = '[POLL:' + pollId + '] ' + parsedPoll.question + ' | ' + parsedPoll.options.join(' | ');
            return { outgoing: wirePoll };
        }
        if (/^\/burn(\s|$)/i.test(trimmed)) {
            var bm = trimmed.match(/^\/burn\s+(\d{1,6})\s+([\s\S]+)$/i);
            if (!bm) {
                window.alert('Uso: /burn [secondi] [messaggio]\nEsempio: /burn 30 Ricordati di spegnere il PC');
                return { handled: true };
            }
            var secs = parseInt(bm[1], 10);
            if (secs < 1 || secs > 86400) {
                window.alert('I secondi devono essere tra 1 e 86400.');
                return { handled: true };
            }
            return { outgoing: '[BURN:' + secs + ']' + bm[2] };
        }
        if (/^\/nick(\s|$)/i.test(trimmed)) {
            var nn = trimmed.replace(/^\/nick\s+/i, '').trim();
            if (nn.length < 1) {
                return { handled: true };
            }
            if (nn.length > 32) {
                window.alert('Nickname massimo 32 caratteri.');
                return { handled: true };
            }
            myNick = nn;
            if (el.youNick) el.youNick.textContent = myNick;
            if (el.lobbyYouNick) el.lobbyYouNick.textContent = myNick;
            return { handled: true };
        }
        if (/^\/me(\s|$)/i.test(trimmed)) {
            var action = trimmed.replace(/^\/me\s*/i, '').trim();
            if (!action) {
                return { handled: true };
            }
            return { outgoing: '*' + action + '*' };
        }
        if (/^\/hack\s*$/i.test(trimmed)) {
            startHackOverlay();
            return { handled: true };
        }
        return { outgoing: trimmed };
    }

    function dataUrlFromCanvas(canvas, q) {
        try {
            var webp = canvas.toDataURL('image/webp', q);
            if (webp && webp.indexOf('data:image/webp') === 0) {
                return webp;
            }
        } catch (e1) {}
        try {
            return canvas.toDataURL('image/jpeg', q);
        } catch (e2) {
            return canvas.toDataURL('image/png');
        }
    }

    function buildImgPayloadFromFile(file, callback) {
        var reader = new FileReader();
        reader.onerror = function () {
            callback(null);
        };
        reader.onload = function () {
            var dataUrl = reader.result;
            if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) {
                callback(null);
                return;
            }
            var img = new Image();
            img.onload = function () {
                var w = img.naturalWidth || img.width;
                var h = img.naturalHeight || img.height;
                if (!w || !h) {
                    callback(null);
                    return;
                }
                var maxSide = 1080;
                var scale = Math.min(1, maxSide / w, maxSide / h);
                var tw0 = Math.max(1, Math.floor(w * scale));
                var qualities = [0.92, 0.88, 0.85, 0.8, 0.72, 0.62, 0.52, 0.42, 0.32];
                var widthSteps = [1, 0.9, 0.78, 0.66, 0.54, 0.42, 0.32, 0.24];
                var idxW = 0;
                var idxQ = 0;

                function tryEncode() {
                    var tw = Math.max(1, Math.floor(tw0 * widthSteps[Math.min(idxW, widthSteps.length - 1)]));
                    var th = Math.max(1, Math.round((h * tw) / w));
                    var canvas = document.createElement('canvas');
                    canvas.width = tw;
                    canvas.height = th;
                    var ctx = canvas.getContext('2d');
                    if (!ctx) {
                        callback(null);
                        return;
                    }
                    ctx.drawImage(img, 0, 0, tw, th);
                    var q = qualities[Math.min(idxQ, qualities.length - 1)];
                    var out = dataUrlFromCanvas(canvas, q);
                    var payload = '[IMG]' + out;
                    if (payload.length <= MAX_SERVER_TEXT) {
                        callback(payload);
                        return;
                    }
                    if (idxQ + 1 < qualities.length) {
                        idxQ += 1;
                    } else {
                        idxQ = 0;
                        idxW += 1;
                    }
                    if (idxW >= widthSteps.length) {
                        window.alert('Immagine troppo grande per il limite del server (' + MAX_SERVER_TEXT + ' caratteri). Prova un\'immagine più piccola.');
                        callback(null);
                        return;
                    }
                    tryEncode();
                }
                tryEncode();
            };
            img.onerror = function () {
                callback(null);
            };
            img.src = dataUrl;
        };
        reader.readAsDataURL(file);
    }

    function insertAtCursor(textarea, text) {
        var start = textarea.selectionStart || 0;
        var end = textarea.selectionEnd || 0;
        var v = textarea.value;
        textarea.value = v.slice(0, start) + text + v.slice(end);
        var pos = start + text.length;
        textarea.selectionStart = textarea.selectionEnd = pos;
    }

    function onPasteImage(e) {
        var cd = e.clipboardData;
        if (!cd || !cd.items) return;
        var i;
        for (i = 0; i < cd.items.length; i++) {
            if (cd.items[i].type && cd.items[i].type.indexOf('image/') === 0) {
                e.preventDefault();
                var file = cd.items[i].getAsFile();
                if (!file) return;
                buildImgPayloadFromFile(file, function (payload) {
                    if (!payload) return;
                    insertAtCursor(el.msgInput, payload);
                });
                return;
            }
        }
    }

    function sendMessage() {
        var raw = el.msgInput.value;
        var trimmed = raw.trim();
        if (!trimmed || !myNick || !activeRoomKey) return;

        var slash = applySlashCommands(trimmed);
        if (slash.handled) {
            el.msgInput.value = '';
            el.msgInput.focus();
            return;
        }
        if (typingToTrueTimer) {
            clearTimeout(typingToTrueTimer);
            typingToTrueTimer = null;
        }
        if (typingToFalseTimer) {
            clearTimeout(typingToFalseTimer);
            typingToFalseTimer = null;
        }
        postSetTyping(false);
        var outgoing = slash.outgoing != null ? slash.outgoing : trimmed;
        deliverOutgoingToServer(outgoing, {});
    }

    function deleteRoom() {
        if (!activeRoomKey || !myNick) return;
        if (!window.confirm('Eliminare definitivamente questa stanza per tutti i partecipanti? I messaggi andranno persi.')) {
            return;
        }

        fetch('api.php?action=delete_room', {
            method: 'POST',
            cache: 'no-store',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ room: activeRoomKey, host: myNick })
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!data || data.ok !== true) {
                    throw new Error(data && data.error ? data.error : 'Eliminazione fallita');
                }
                enterLobbyFromChat(null);
            })
            .catch(function () {
                setConnState('err');
                window.alert('Impossibile eliminare la stanza. Solo l’host può farlo.');
            });
    }

    function openCreateModal() {
        hideCreateError();
        if (el.createRoomName) el.createRoomName.value = '';
        if (el.createRoomPass) el.createRoomPass.value = '';
        if (el.modalCreate) el.modalCreate.removeAttribute('hidden');
    }

    function closeCreateModal() {
        if (el.modalCreate) el.modalCreate.setAttribute('hidden', '');
        hideCreateError();
    }

    function openInfoModal() {
        if (!el.infoModal) return;
        el.infoModal.removeAttribute('hidden');
    }

    function closeInfoModal() {
        if (!el.infoModal) return;
        el.infoModal.setAttribute('hidden', '');
    }

    function activateBossKey() {
        if (bossKeyActive) return;
        bossKeyActive = true;
        if (titleBlinkTimer) {
            clearInterval(titleBlinkTimer);
            titleBlinkTimer = null;
        }
        document.title = BOSS_FAKE_DOCUMENT_TITLE;
        if (el.chatAppShell) el.chatAppShell.classList.add('hidden');
        if (el.bossScreen) {
            el.bossScreen.classList.add('boss-screen--visible');
            el.bossScreen.setAttribute('aria-hidden', 'false');
        }
    }

    function deactivateBossKey() {
        if (!bossKeyActive) return;
        bossKeyActive = false;
        lastEscapePressAt = 0;
        if (el.chatAppShell) el.chatAppShell.classList.remove('hidden');
        if (el.bossScreen) {
            el.bossScreen.classList.remove('boss-screen--visible');
            el.bossScreen.setAttribute('aria-hidden', 'true');
        }
        document.title = storedPageTitle;
    }

    function onGlobalKeydown(e) {
        if (bossKeyActive) {
            if (e.altKey && !e.repeat && e.code === 'KeyX') {
                e.preventDefault();
                deactivateBossKey();
            }
            return;
        }
        if (e.key === 'Escape' && !e.repeat) {
            if (el.floatingTextInput && document.activeElement === el.floatingTextInput) {
                e.preventDefault();
                whiteboardHideFloatingTextInput();
                return;
            }
            if (whiteboardIsPanelOpen()) {
                e.preventDefault();
                whiteboardClosePanel();
                return;
            }
            closeAllReactPickers();
            var now = Date.now();
            if (lastEscapePressAt && now - lastEscapePressAt <= 500) {
                e.preventDefault();
                lastEscapePressAt = 0;
                activateBossKey();
            } else {
                lastEscapePressAt = now;
            }
        }
    }

    function submitCreateRoom(e) {
        e.preventDefault();
        hideCreateError();
        var name = el.createRoomName && el.createRoomName.value ? el.createRoomName.value.trim() : '';
        var pwd = el.createRoomPass && el.createRoomPass.value ? el.createRoomPass.value : '';
        var typeRadios = document.querySelectorAll('input[name="create-room-type"]');
        var rtype = 'public';
        for (var i = 0; i < typeRadios.length; i++) {
            if (typeRadios[i].checked) rtype = typeRadios[i].value;
        }
        if (name.length < 1) {
            showCreateError('Inserisci un nome stanza.');
            return;
        }
        if (name.length > 48) {
            showCreateError('Nome troppo lungo (max 48).');
            return;
        }
        if (pwd.length > 64) {
            showCreateError('Password E2EE troppo lunga (max 64).');
            return;
        }

        postJson('api.php?action=create_room', { room: name, nick: myNick, type: rtype })
            .then(function (data) {
                closeCreateModal();
                hideLobbyScreen();
                enterChatWithRoom(data.room_key || name, pwd);
            })
            .catch(function (err) {
                var msg =
                    err && err.message
                        ? err.message
                        : 'Impossibile creare la stanza (rete o risposta dal server non valida).';
                showCreateError(msg);
            });
    }

    function onLoginSubmit(e) {
        e.preventDefault();
        hideLoginError();
        var nick = el.nickInput && el.nickInput.value ? el.nickInput.value.trim() : '';
        if (nick.length < 1) {
            showLoginError('Inserisci un nickname.');
            return;
        }
        if (nick.length > 32) {
            showLoginError('Nickname troppo lungo (max 32).');
            return;
        }
        myNick = nick;
        if (el.youNick) el.youNick.textContent = myNick;
        requestNotificationPermission();
        showLobbyScreen();
    }

    function onLobbyLogout() {
        stopAllPolls();
        flushTypingState();
        resetPresenceState();
        myNick = '';
        activeRoomKey = '';
        waitingRoomKey = '';
        roomPassword = '';
        pendingReadReceipts.length = 0;
        readReceiptSentSet = {};
        invalidateCryptoCache();
        if (el.nickInput) el.nickInput.value = '';
        showScreen('login-screen');
        hideLoginError();
        hideLobbyError();
    }

    function onWaitingCancel() {
        flushTypingState();
        resetPresenceState();
        stopAllPolls();
        waitingRoomKey = '';
        roomPassword = '';
        pendingReadReceipts.length = 0;
        invalidateCryptoCache();
        showLobbyScreen();
    }

    function onBackToLobby() {
        if (!window.confirm('Lasciare la stanza e tornare alla lobby?')) return;
        flushTypingState();
        resetPresenceState();
        stopAllPolls();
        resetTitleBlink();
        clearAllBurnTimeouts();
        invalidateCryptoCache();
        roomPassword = '';
        lastMessageId = 0;
        activeRoomKey = '';
        waitingRoomKey = '';
        roomWasPersisted = false;
        isHostCurrent = false;
        readReceiptMinEligibleTimeSec = 9007199254740991;
        clearMessages();
        if (el.msgInput) el.msgInput.value = '';
        updateRoomTitle();
        if (el.hostPanel) el.hostPanel.hidden = true;
        if (el.deleteRoomBtn) el.deleteRoomBtn.hidden = true;
        showLobbyScreen();
    }

    function bindEvents() {
        if (el.loginForm) {
            el.loginForm.addEventListener('submit', onLoginSubmit);
        }

        if (el.lobbyLogoutBtn) el.lobbyLogoutBtn.addEventListener('click', onLobbyLogout);
        if (el.lobbyCreateBtn) el.lobbyCreateBtn.addEventListener('click', openCreateModal);
        if (el.waitingCancelBtn) el.waitingCancelBtn.addEventListener('click', onWaitingCancel);

        if (el.createRoomForm) el.createRoomForm.addEventListener('submit', submitCreateRoom);
        if (el.createRoomCancel) el.createRoomCancel.addEventListener('click', closeCreateModal);
        if (el.modalCreate) {
            el.modalCreate.addEventListener('click', function (ev) {
                if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close-modal') !== null) {
                    closeCreateModal();
                }
            });
        }

        if (el.infoHelpBtn) el.infoHelpBtn.addEventListener('click', openInfoModal);
        if (el.infoModalCloseBtn) el.infoModalCloseBtn.addEventListener('click', closeInfoModal);
        if (el.infoModalCloseX) el.infoModalCloseX.addEventListener('click', closeInfoModal);
        if (el.infoModal) {
            el.infoModal.addEventListener('click', function (ev) {
                if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close-info') !== null) {
                    closeInfoModal();
                }
            });
        }

        if (el.deleteRoomBtn) el.deleteRoomBtn.addEventListener('click', deleteRoom);
        if (el.backLobbyBtn) el.backLobbyBtn.addEventListener('click', onBackToLobby);

        if (el.saveChatBtn) {
            el.saveChatBtn.addEventListener('click', function () {
                exportChatToTxtFile();
            });
        }

        if (el.sendBtn) el.sendBtn.addEventListener('click', sendMessage);

        if (el.e2eePassOk) {
            el.e2eePassOk.addEventListener('click', function () {
                var raw = el.e2eePassInput ? String(el.e2eePassInput.value) : '';
                if (raw.length > 64) {
                    window.alert('Password massimo 64 caratteri.');
                    return;
                }
                closeE2eeModalWithResult(raw);
            });
        }
        if (el.e2eePassCancel) {
            el.e2eePassCancel.addEventListener('click', function () {
                closeE2eeModalWithResult(null);
            });
        }
        if (el.modalE2ee) {
            el.modalE2ee.addEventListener('click', function (ev) {
                if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close-e2ee') !== null) {
                    closeE2eeModalWithResult(null);
                }
            });
        }

        document.addEventListener('mousedown', function (ev) {
            var t = ev.target;
            if (
                !(
                    t &&
                    t.closest &&
                    (t.closest('.msg-react-wrap') ||
                        t.closest('#whiteboard-overlay') ||
                        t.closest('#whiteboard-container') ||
                        t.closest('#floating-text-input'))
                )
            ) {
                closeAllReactPickers();
            }
            if (!el.mentionsDropdown || el.mentionsDropdown.classList.contains('hidden')) return;
            if (el.composerStack && el.composerStack.contains(t)) return;
            if (el.mentionsDropdown.contains(t)) return;
            hideMentionsDropdown();
        });

        if (el.msgInput) {
            el.msgInput.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && isMentionsDropdownOpen()) {
                    e.preventDefault();
                    hideMentionsDropdown();
                    return;
                }
                if (e.key === 'Tab' && isMentionsDropdownOpen()) {
                    e.preventDefault();
                    applyMentionPick(0);
                    return;
                }
                if ((e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey) {
                    if (isMentionsDropdownOpen()) {
                        e.preventDefault();
                        applyMentionPick(0);
                        return;
                    }
                    e.preventDefault();
                    sendMessage();
                }
            });
            el.msgInput.addEventListener('paste', onPasteImage);
            el.msgInput.addEventListener('input', function () {
                scheduleTypingFromInput();
                updateMentionsDropdown();
            });
            el.msgInput.addEventListener('blur', function () {
                setTimeout(hideMentionsDropdown, 150);
            });
        }

        bindChatFileDragDrop();

        if (el.whiteboardOpenBtn) {
            el.whiteboardOpenBtn.addEventListener('click', function () {
                whiteboardOpenPanel();
            });
        }
        if (el.whiteboardCloseBtn) {
            el.whiteboardCloseBtn.addEventListener('click', function () {
                whiteboardClosePanel();
            });
        }
        if (el.wbClearAllBtn) {
            el.wbClearAllBtn.addEventListener('click', function () {
                whiteboardClearAllAndBroadcast();
            });
        }
        if (el.wbEraserBtn) {
            el.wbEraserBtn.addEventListener('click', function () {
                wbIsEraser = !wbIsEraser;
                if (wbIsEraser) {
                    isTextTool = false;
                    if (el.wbTextToolBtn) el.wbTextToolBtn.classList.remove('wb-text-tool-on');
                    el.wbEraserBtn.classList.add('wb-eraser-on');
                } else {
                    el.wbEraserBtn.classList.remove('wb-eraser-on');
                }
                whiteboardUpdateCanvasCursor();
            });
        }
        if (el.wbColor) {
            el.wbColor.addEventListener('input', function () {
                wbIsEraser = false;
                isTextTool = false;
                wbCurrentColor = el.wbColor.value || wbCurrentColor;
                if (el.wbEraserBtn) el.wbEraserBtn.classList.remove('wb-eraser-on');
                if (el.wbTextToolBtn) el.wbTextToolBtn.classList.remove('wb-text-tool-on');
                whiteboardUpdateCanvasCursor();
            });
        }
        if (el.wbTextToolBtn) {
            el.wbTextToolBtn.addEventListener('click', function () {
                isTextTool = !isTextTool;
                if (isTextTool) {
                    wbIsEraser = false;
                    if (el.wbEraserBtn) el.wbEraserBtn.classList.remove('wb-eraser-on');
                    el.wbTextToolBtn.classList.add('wb-text-tool-on');
                } else {
                    el.wbTextToolBtn.classList.remove('wb-text-tool-on');
                }
                whiteboardUpdateCanvasCursor();
            });
        }
        whiteboardBindCanvas();
        bindFloatingTextInputOnce();

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
                resetTitleBlink();
                flushPendingReadReceipts();
            }
        });
        window.addEventListener('focus', function () {
            if (!document.hidden) {
                resetTitleBlink();
                flushPendingReadReceipts();
            }
        });

        document.addEventListener('keydown', onGlobalKeydown, true);
    }

    function init() {
        storedPageTitle = document.title;

        el = {
            chatAppShell: document.getElementById('chat-app-shell'),
            bossScreen: document.getElementById('boss-screen'),
            loginScreen: document.getElementById('login-screen'),
            loginForm: document.getElementById('login-form'),
            nickInput: document.getElementById('nick-input'),
            loginError: document.getElementById('login-error'),
            lobbyScreen: document.getElementById('lobby-screen'),
            lobbyYouNick: document.getElementById('lobby-you-nick'),
            lobbyList: document.getElementById('lobby-list'),
            lobbyEmpty: document.getElementById('lobby-empty'),
            lobbyError: document.getElementById('lobby-error'),
            lobbyCreateBtn: document.getElementById('lobby-create-btn'),
            lobbyLogoutBtn: document.getElementById('lobby-logout-btn'),
            waitingScreen: document.getElementById('waiting-screen'),
            waitingRoomName: document.getElementById('waiting-room-name'),
            waitingCancelBtn: document.getElementById('waiting-cancel-btn'),
            modalCreate: document.getElementById('modal-create'),
            createRoomForm: document.getElementById('create-room-form'),
            createRoomName: document.getElementById('create-room-name'),
            createRoomPass: document.getElementById('create-room-pass'),
            createRoomCancel: document.getElementById('create-room-cancel'),
            createRoomError: document.getElementById('create-room-error'),
            chatScreen: document.getElementById('chat-screen'),
            hostPanel: document.getElementById('host-panel'),
            hostWaitingList: document.getElementById('host-waiting-list'),
            youNick: document.getElementById('you-nick'),
            roomDisplay: document.getElementById('room-display'),
            deleteRoomBtn: document.getElementById('delete-room-btn'),
            backLobbyBtn: document.getElementById('back-lobby-btn'),
            saveChatBtn: document.getElementById('save-chat-btn'),
            infoHelpBtn: document.getElementById('info-help-btn'),
            infoModal: document.getElementById('info-modal'),
            infoModalCloseBtn: document.getElementById('info-modal-close-btn'),
            infoModalCloseX: document.getElementById('info-modal-close-x'),
            hackOverlay: document.getElementById('hack-overlay'),
            hackTerminal: document.getElementById('hack-terminal'),
            connStatus: document.getElementById('conn-status'),
            messages: document.getElementById('messages'),
            chatMessages: document.getElementById('chat-messages'),
            msgInput: document.getElementById('msg-input'),
            sendBtn: document.getElementById('send-btn'),
            typingIndicator: document.getElementById('typing-indicator'),
            composerStack: document.getElementById('composer-stack'),
            mentionsDropdown: document.getElementById('mentions-dropdown'),
            onlineUsersList: document.getElementById('online-users-list'),
            modalE2ee: document.getElementById('modal-e2ee'),
            modalE2eeTitle: document.getElementById('modal-e2ee-title'),
            modalE2eeHint: document.getElementById('modal-e2ee-hint'),
            e2eePassInput: document.getElementById('e2ee-pass-input'),
            e2eePassOk: document.getElementById('e2ee-pass-ok'),
            e2eePassCancel: document.getElementById('e2ee-pass-cancel'),
            whiteboardOpenBtn: document.getElementById('whiteboard-open-btn'),
            whiteboardOverlay: document.getElementById('whiteboard-overlay'),
            whiteboardContainer: document.getElementById('whiteboard-container'),
            floatingTextInput: document.getElementById('floating-text-input'),
            whiteboardCloseBtn: document.getElementById('whiteboard-close-btn'),
            whiteboard: document.getElementById('whiteboard'),
            wbColor: document.getElementById('wb-color'),
            wbSize: document.getElementById('wb-size'),
            wbEraserBtn: document.getElementById('wb-eraser'),
            wbClearAllBtn: document.getElementById('wb-clear-all'),
            wbTextToolBtn: document.getElementById('wb-text-tool')
        };

        var required = [
            'chatAppShell',
            'bossScreen',
            'loginScreen',
            'loginForm',
            'nickInput',
            'loginError',
            'lobbyScreen',
            'lobbyList',
            'lobbyEmpty',
            'chatScreen',
            'youNick',
            'roomDisplay',
            'messages',
            'msgInput',
            'sendBtn'
        ];
        for (var i = 0; i < required.length; i++) {
            var k = required[i];
            if (!el[k]) {
                window.alert('Chat: elemento DOM mancante (' + k + '). Verifica index.html.');
                return;
            }
        }

        bindEvents();

        showScreen('login-screen');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
