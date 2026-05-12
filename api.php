<?php
/**
 * API chat multi-stanza — persistenza su stanze.php (nessun DB).
 * Struttura per stanza:
 * { "host", "type": "public"|"private", "waiting_list": [], "approved_users": [],
 *   "typing": [], "presence": { "nick": { "time": unix, "status": "chat"|"whiteboard" } }, "messages": [], "next_id": int }
 *
 * Azioni: lobby, create_room, request_join, approve_user, fetch, set_typing, send, delete_room
 * Le password E2EE restano solo lato client (mai salvate qui).
 */

declare(strict_types=1);

const STANZE_FILE = __DIR__ . '/stanze.php';
const STANZE_DATA_GUARD = '<' . '?php exit(); ?' . '>';
const MAX_MESSAGES = 100;
const MAX_NICK_LEN = 32;
const MAX_TEXT_LEN = 2000000;
const MAX_ROOM_LEN = 48;
const PRESENCE_TTL_SEC = 15;

header('Content-Type: application/json; charset=UTF-8');
header('X-Content-Type-Options: nosniff');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = isset($_GET['action']) ? (string) $_GET['action'] : '';

function sanitize_presence_status(?string $s): string {
    $s = $s !== null ? trim($s) : '';
    if ($s === 'whiteboard') {
        return 'whiteboard';
    }
    return 'chat';
}

function json_out(array $payload, int $httpCode = 200): void {
    http_response_code($httpCode);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit;
}

function sanitize_user_text(string $s, int $maxLen): string {
    $s = trim($s);
    if ($s === '') {
        return '';
    }
    $s = strip_tags($s);
    $s = htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    if (function_exists('mb_substr')) {
        $s = mb_substr($s, 0, $maxLen, 'UTF-8');
    } else {
        $s = substr($s, 0, $maxLen);
    }
    return $s;
}

function sanitize_room_name(string $s): string {
    $s = trim($s);
    $s = strip_tags($s);
    if (function_exists('mb_substr')) {
        $s = mb_substr($s, 0, MAX_ROOM_LEN, 'UTF-8');
    } else {
        $s = substr($s, 0, MAX_ROOM_LEN);
    }
    if (function_exists('preg_replace')) {
        $s = (string) preg_replace('/[^\p{L}\p{N} _.\-]+/u', '', $s);
    } else {
        $s = preg_replace('/[^a-zA-Z0-9 _.\-]+/', '', $s);
    }
    return trim($s);
}

function unwrap_stanze_file_content(string $raw): string {
    if ($raw === '') {
        return '';
    }
    if (strpos($raw, "\xEF\xBB\xBF") === 0) {
        $raw = substr($raw, 3);
    }
    if (strpos($raw, '<?php') === 0) {
        $len = strlen($raw);
        for ($i = 0; $i < $len; $i++) {
            if ($raw[$i] === "\n") {
                return substr($raw, $i + 1);
            }
            if ($raw[$i] === "\r") {
                $start = $i + 1;
                if ($start < $len && $raw[$start] === "\n") {
                    $start++;
                }
                return substr($raw, $start);
            }
        }
        return '';
    }
    return $raw;
}

/** Normalizza una stanza (migrazione da vecchio formato solo messages/next_id). */
function normalize_room_block(array $block): array {
    $messages = isset($block['messages']) && is_array($block['messages']) ? $block['messages'] : [];
    $nextId = max(1, (int) ($block['next_id'] ?? 1));
    $clean = [];
    foreach ($messages as $m) {
        if (!is_array($m)) {
            continue;
        }
        $clean[] = [
            'id' => (int) ($m['id'] ?? 0),
            'time' => (int) ($m['time'] ?? 0),
            'nick' => is_string($m['nick'] ?? null) ? $m['nick'] : '',
            'text' => is_string($m['text'] ?? null) ? $m['text'] : '',
        ];
    }
    $host = '';
    if (isset($block['host']) && is_string($block['host'])) {
        $host = sanitize_user_text($block['host'], MAX_NICK_LEN);
    }
    $type = (isset($block['type']) && $block['type'] === 'private') ? 'private' : 'public';
    $waiting = [];
    if (isset($block['waiting_list']) && is_array($block['waiting_list'])) {
        foreach ($block['waiting_list'] as $w) {
            if (is_string($w)) {
                $s = sanitize_user_text($w, MAX_NICK_LEN);
                if ($s !== '') {
                    $waiting[] = $s;
                }
            }
        }
        $waiting = array_values(array_unique($waiting));
    }
    $approved = [];
    if (isset($block['approved_users']) && is_array($block['approved_users'])) {
        foreach ($block['approved_users'] as $a) {
            if (is_string($a)) {
                $s = sanitize_user_text($a, MAX_NICK_LEN);
                if ($s !== '') {
                    $approved[] = $s;
                }
            }
        }
        $approved = array_values(array_unique($approved));
    }
    $typing = [];
    if (isset($block['typing']) && is_array($block['typing'])) {
        foreach ($block['typing'] as $t) {
            if (is_string($t)) {
                $s = sanitize_user_text($t, MAX_NICK_LEN);
                if ($s !== '') {
                    $typing[] = $s;
                }
            }
        }
        $typing = array_values(array_unique($typing));
    }
    $presence = [];
    if (isset($block['presence']) && is_array($block['presence'])) {
        foreach ($block['presence'] as $pNick => $pVal) {
            if (!is_string($pNick)) {
                continue;
            }
            $nk = sanitize_user_text($pNick, MAX_NICK_LEN);
            if ($nk === '') {
                continue;
            }
            if (is_array($pVal)) {
                $t = max(0, (int) ($pVal['time'] ?? 0));
                $st = sanitize_presence_status(isset($pVal['status']) && is_string($pVal['status']) ? $pVal['status'] : null);
                $presence[$nk] = ['time' => $t, 'status' => $st];
            } else {
                $presence[$nk] = ['time' => max(0, (int) $pVal), 'status' => 'chat'];
            }
        }
    }
    return [
        'host' => $host,
        'type' => $type,
        'waiting_list' => $waiting,
        'approved_users' => $approved,
        'typing' => $typing,
        'presence' => $presence,
        'messages' => $clean,
        'next_id' => $nextId,
    ];
}

function parse_stanze(string $raw): array {
    if ($raw === '') {
        return [];
    }
    try {
        $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $e) {
        return [];
    }
    if (!is_array($data)) {
        return [];
    }
    $out = [];
    foreach ($data as $name => $block) {
        if (!is_string($name) || $name === '' || !is_array($block)) {
            continue;
        }
        $out[$name] = normalize_room_block($block);
    }
    return $out;
}

function trim_room_messages(array &$roomState): void {
    $n = count($roomState['messages']);
    if ($n > MAX_MESSAGES) {
        $roomState['messages'] = array_slice($roomState['messages'], $n - MAX_MESSAGES);
    }
}

function open_stanze_read(): array {
    $fp = @fopen(STANZE_FILE, 'rb');
    if ($fp === false) {
        return [[], null];
    }
    if (!flock($fp, LOCK_SH)) {
        fclose($fp);
        return [[], null];
    }
    $raw = stream_get_contents($fp) ?: '';
    $payload = unwrap_stanze_file_content($raw);
    $stanze = parse_stanze($payload);
    flock($fp, LOCK_UN);
    fclose($fp);
    return [$stanze, null];
}

/**
 * Esegue una mutazione sul file stanze con lock esclusivo.
 *
 * @return array{ok: bool, reason: 'saved'|'reject'|'fopen'|'flock'|'encode'}
 */
function with_stanze_exclusive(callable $fn): array {
    $fp = @fopen(STANZE_FILE, 'cb+');
    if ($fp === false) {
        return ['ok' => false, 'reason' => 'fopen'];
    }
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        return ['ok' => false, 'reason' => 'flock'];
    }
    $raw = stream_get_contents($fp);
    if ($raw === false) {
        $raw = '';
    }
    $payload = unwrap_stanze_file_content($raw);
    $stanze = parse_stanze($payload);
    $callbackOk = $fn($stanze);
    if ($callbackOk) {
        try {
            ftruncate($fp, 0);
            rewind($fp);
            $json = count($stanze) === 0
                ? '{}'
                : json_encode($stanze, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
            $out = STANZE_DATA_GUARD . "\n" . $json;
            fwrite($fp, $out);
            fflush($fp);
        } catch (Throwable $e) {
            flock($fp, LOCK_UN);
            fclose($fp);
            return ['ok' => false, 'reason' => 'encode'];
        }
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    if ($callbackOk) {
        return ['ok' => true, 'reason' => 'saved'];
    }
    return ['ok' => false, 'reason' => 'reject'];
}

function room_prefer_body_then_get(?array $body): string {
    if ($body !== null && isset($body['room']) && is_string($body['room'])) {
        $r = sanitize_room_name($body['room']);
        if ($r !== '') {
            return $r;
        }
    }
    if (isset($_GET['room']) && is_string($_GET['room'])) {
        return sanitize_room_name($_GET['room']);
    }
    return '';
}

function nick_from_body_or_get(?array $body): string {
    if ($body !== null && isset($body['nick']) && is_string($body['nick'])) {
        $n = sanitize_user_text($body['nick'], MAX_NICK_LEN);
        if ($n !== '') {
            return $n;
        }
    }
    if (isset($_GET['nick']) && is_string($_GET['nick'])) {
        return sanitize_user_text($_GET['nick'], MAX_NICK_LEN);
    }
    return '';
}

function nick_list_contains(array $list, string $nickSan): bool {
    foreach ($list as $x) {
        if ($x === $nickSan) {
            return true;
        }
    }
    return false;
}

function is_room_host(array $state, string $nickSan): bool {
    return $nickSan !== '' && $state['host'] !== '' && $nickSan === $state['host'];
}

function can_access_private_room(array $state, string $nickSan): bool {
    if ($state['type'] !== 'private') {
        return true;
    }
    if (is_room_host($state, $nickSan)) {
        return true;
    }
    return nick_list_contains($state['approved_users'], $nickSan);
}

// --- lobby ---
if ($action === 'lobby' && $method === 'GET') {
    [$stanze] = open_stanze_read();
    $list = [];
    foreach ($stanze as $name => $state) {
        $list[] = [
            'room' => $name,
            'host' => $state['host'],
            'type' => $state['type'],
        ];
    }
    json_out(['ok' => true, 'rooms' => $list]);
}

// --- create_room ---
if ($action === 'create_room' && $method === 'POST') {
    $rawBody = file_get_contents('php://input');
    if ($rawBody === false || $rawBody === '') {
        json_out(['ok' => false, 'error' => 'Corpo richiesta vuoto.'], 400);
    }
    try {
        $body = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'JSON non valido.'], 400);
    }
    if (!is_array($body)) {
        json_out(['ok' => false, 'error' => 'Formato non valido.'], 400);
    }
    $room = room_prefer_body_then_get($body);
    $nick = nick_from_body_or_get($body);
    $typeIn = isset($body['type']) && is_string($body['type']) ? strtolower(trim($body['type'])) : 'public';
    $type = ($typeIn === 'private') ? 'private' : 'public';
    if ($room === '' || $nick === '') {
        json_out(['ok' => false, 'error' => 'room e nick obbligatori.'], 400);
    }
    $wr = with_stanze_exclusive(function (array &$stanze) use ($room, $nick, $type): bool {
        if (isset($stanze[$room])) {
            return false;
        }
        $stanze[$room] = [
            'host' => $nick,
            'type' => $type,
            'waiting_list' => [],
            'approved_users' => [$nick],
            'typing' => [],
            'presence' => [],
            'messages' => [],
            'next_id' => 1,
        ];
        return true;
    });
    if (!$wr['ok']) {
        if ($wr['reason'] === 'reject') {
            json_out(['ok' => false, 'error' => 'Questo nome di stanza è già in uso.'], 409);
        }
        $hint = 'Il server non riesce a scrivere il file stanze.php (apertura o lock). Controlla i permessi di scrittura per Apache/PHP sulla cartella della chat.';
        if ($wr['reason'] === 'encode') {
            $hint = 'Errore nel salvataggio dei dati (JSON). Verifica che stanze.php non sia corrotto.';
        }
        json_out(['ok' => false, 'error' => $hint], 503);
    }
    json_out(['ok' => true, 'room_key' => $room, 'type' => $type]);
}

// --- request_join ---
if ($action === 'request_join' && $method === 'POST') {
    $rawBody = file_get_contents('php://input');
    if ($rawBody === false || $rawBody === '') {
        json_out(['ok' => false, 'error' => 'Corpo richiesta vuoto.'], 400);
    }
    try {
        $body = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'JSON non valido.'], 400);
    }
    if (!is_array($body)) {
        json_out(['ok' => false, 'error' => 'Formato non valido.'], 400);
    }
    $room = room_prefer_body_then_get($body);
    $nick = nick_from_body_or_get($body);
    if ($room === '' || $nick === '') {
        json_out(['ok' => false, 'error' => 'room e nick obbligatori.'], 400);
    }
    $err = '';
    $wr = with_stanze_exclusive(function (array &$stanze) use ($room, $nick, &$err): bool {
        if (!isset($stanze[$room])) {
            $err = 'stanza_inesistente';
            return false;
        }
        $state = &$stanze[$room];
        if ($state['type'] !== 'private') {
            $err = 'non_privata';
            return false;
        }
        if (is_room_host($state, $nick) || nick_list_contains($state['approved_users'], $nick)) {
            return true;
        }
        if (!nick_list_contains($state['waiting_list'], $nick)) {
            $state['waiting_list'][] = $nick;
            $state['waiting_list'] = array_values(array_unique($state['waiting_list']));
        }
        return true;
    });
    if (!$wr['ok']) {
        if ($wr['reason'] !== 'reject') {
            json_out(['ok' => false, 'error' => 'Errore di scrittura su stanze.php (permessi o file bloccato).'], 503);
        }
        $code = $err === 'stanza_inesistente' ? 404 : 400;
        json_out(['ok' => false, 'error' => $err ?: 'richiesta_non_valida'], $code);
    }
    json_out(['ok' => true, 'room_key' => $room]);
}

// --- approve_user ---
if ($action === 'approve_user' && $method === 'POST') {
    $rawBody = file_get_contents('php://input');
    if ($rawBody === false || $rawBody === '') {
        json_out(['ok' => false, 'error' => 'Corpo richiesta vuoto.'], 400);
    }
    try {
        $body = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'JSON non valido.'], 400);
    }
    if (!is_array($body)) {
        json_out(['ok' => false, 'error' => 'Formato non valido.'], 400);
    }
    $room = room_prefer_body_then_get($body);
    $hostNick = isset($body['host']) && is_string($body['host']) ? sanitize_user_text($body['host'], MAX_NICK_LEN) : '';
    $target = isset($body['target']) && is_string($body['target']) ? sanitize_user_text($body['target'], MAX_NICK_LEN) : '';
    if ($room === '' || $hostNick === '' || $target === '') {
        json_out(['ok' => false, 'error' => 'room, host e target obbligatori.'], 400);
    }
    $err = '';
    $wr = with_stanze_exclusive(function (array &$stanze) use ($room, $hostNick, $target, &$err): bool {
        if (!isset($stanze[$room])) {
            $err = 'stanza_inesistente';
            return false;
        }
        $state = &$stanze[$room];
        if (!is_room_host($state, $hostNick)) {
            $err = 'non_host';
            return false;
        }
        if (!nick_list_contains($state['waiting_list'], $target)) {
            $err = 'non_in_coda';
            return false;
        }
        $state['waiting_list'] = array_values(array_filter($state['waiting_list'], function ($w) use ($target) {
            return $w !== $target;
        }));
        if (!nick_list_contains($state['approved_users'], $target)) {
            $state['approved_users'][] = $target;
        }
        return true;
    });
    if (!$wr['ok']) {
        if ($wr['reason'] !== 'reject') {
            json_out(['ok' => false, 'error' => 'Errore di scrittura su stanze.php (permessi o file bloccato).'], 503);
        }
        $code = $err === 'stanza_inesistente' ? 404 : 403;
        json_out(['ok' => false, 'error' => $err ?: 'errore'], $code);
    }
    json_out(['ok' => true, 'room_key' => $room]);
}

/** Legge is_typing da JSON (bool, int, string). */
function body_bool_is_typing(?array $body): bool {
    if ($body === null || !array_key_exists('is_typing', $body)) {
        return false;
    }
    $v = $body['is_typing'];
    if (is_bool($v)) {
        return $v;
    }
    if (is_int($v) || is_float($v)) {
        return ((int) $v) !== 0;
    }
    if (is_string($v)) {
        $s = strtolower(trim($v));

        return $s === 'true' || $s === '1' || $s === 'yes' || $s === 'on';
    }

    return false;
}

// --- set_typing ---
if ($action === 'set_typing' && $method === 'POST') {
    $rawBody = file_get_contents('php://input');
    if ($rawBody === false || $rawBody === '') {
        json_out(['ok' => false, 'error' => 'Corpo richiesta vuoto.'], 400);
    }
    try {
        $body = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'JSON non valido.'], 400);
    }
    if (!is_array($body)) {
        json_out(['ok' => false, 'error' => 'Formato non valido.'], 400);
    }
    $room = room_prefer_body_then_get($body);
    $nick = nick_from_body_or_get($body);
    $isTyping = body_bool_is_typing($body);
    if ($room === '' || $nick === '') {
        json_out(['ok' => false, 'error' => 'room e nick obbligatori.'], 400);
    }
    $err = '';
    $wr = with_stanze_exclusive(function (array &$stanze) use ($room, $nick, $isTyping, &$err): bool {
        if (!isset($stanze[$room])) {
            $err = 'stanza_inesistente';
            return false;
        }
        $state = &$stanze[$room];
        if (!can_access_private_room($state, $nick)) {
            $err = 'accesso_negato';
            return false;
        }
        if (!isset($state['typing']) || !is_array($state['typing'])) {
            $state['typing'] = [];
        }
        if ($isTyping) {
            if (!nick_list_contains($state['typing'], $nick)) {
                $state['typing'][] = $nick;
                $state['typing'] = array_values(array_unique($state['typing']));
            }
        } else {
            $state['typing'] = array_values(array_filter($state['typing'], function ($t) use ($nick) {
                return $t !== $nick;
            }));
        }
        return true;
    });
    if (!$wr['ok']) {
        if ($wr['reason'] !== 'reject') {
            json_out(['ok' => false, 'error' => 'Errore di scrittura su stanze.php (permessi o file bloccato).'], 503);
        }
        $code = $err === 'stanza_inesistente' ? 404 : 403;
        json_out(['ok' => false, 'error' => $err ?: 'errore'], $code);
    }
    json_out(['ok' => true, 'room_key' => $room]);
}

// --- fetch ---
if ($action === 'fetch' && $method === 'GET') {
    $room = room_from_request(false, null);
    if ($room === '') {
        json_out(['ok' => false, 'error' => 'Parametro room obbligatorio.'], 400);
    }
    $after = isset($_GET['after']) ? (int) $_GET['after'] : 0;
    $nick = isset($_GET['nick']) && is_string($_GET['nick']) ? sanitize_user_text($_GET['nick'], MAX_NICK_LEN) : '';
    if ($nick === '') {
        json_out(['ok' => false, 'error' => 'Parametro nick obbligatorio (GET).'], 400);
    }
    $clientStatus = isset($_GET['status']) && is_string($_GET['status']) ? sanitize_presence_status($_GET['status']) : 'chat';

    $fetchResult = null;
    $fetchWr = with_stanze_exclusive(function (array &$stanze) use ($room, $nick, $after, $clientStatus, &$fetchResult): bool {
        if (!isset($stanze[$room])) {
            $fetchResult = [
                'ok' => true,
                'access' => false,
                'messages' => [],
                'typing' => [],
                'online_users' => [],
                'room_present' => false,
                'room_key' => $room,
                'host' => '',
                'type' => 'public',
            ];
            return false;
        }
        $state = &$stanze[$room];
        $base = [
            'ok' => true,
            'room_present' => true,
            'room_key' => $room,
            'host' => $state['host'],
            'type' => $state['type'],
        ];
        $access = can_access_private_room($state, $nick);
        if (!$access) {
            $fetchResult = array_merge($base, [
                'access' => false,
                'messages' => [],
                'typing' => [],
                'online_users' => [],
            ]);
            return false;
        }
        if (!isset($state['presence']) || !is_array($state['presence'])) {
            $state['presence'] = [];
        }
        $now = time();
        $state['presence'][$nick] = ['time' => $now, 'status' => $clientStatus];
        foreach ($state['presence'] as $pNick => $pEntry) {
            $pTs = is_array($pEntry) ? (int) ($pEntry['time'] ?? 0) : (int) $pEntry;
            if ($now - $pTs > PRESENCE_TTL_SEC) {
                unset($state['presence'][$pNick]);
            }
        }
        $onlineUsers = [];
        foreach ($state['presence'] as $pNick => $pEntry) {
            $pTs = is_array($pEntry) ? (int) ($pEntry['time'] ?? 0) : (int) $pEntry;
            $pStatus = is_array($pEntry) ? sanitize_presence_status(isset($pEntry['status']) && is_string($pEntry['status']) ? $pEntry['status'] : null) : 'chat';
            $onlineUsers[] = [
                'nick' => $pNick,
                'time' => $pTs,
                'status' => $pStatus,
            ];
        }
        usort($onlineUsers, function (array $a, array $b): int {
            return strcmp($a['nick'], $b['nick']);
        });

        $out = [];
        foreach ($state['messages'] as $m) {
            $id = (int) ($m['id'] ?? 0);
            if ($id > $after) {
                $out[] = [
                    'id' => $id,
                    'time' => (int) ($m['time'] ?? 0),
                    'nick' => $m['nick'],
                    'text' => $m['text'],
                ];
            }
        }
        $typingOut = isset($state['typing']) && is_array($state['typing']) ? $state['typing'] : [];
        $resp = array_merge($base, [
            'access' => true,
            'messages' => $out,
            'is_host' => is_room_host($state, $nick),
            'typing' => $typingOut,
            'online_users' => $onlineUsers,
        ]);
        if ($state['type'] === 'private' && is_room_host($state, $nick)) {
            $resp['waiting_list'] = $state['waiting_list'];
        } else {
            $resp['waiting_list'] = [];
        }
        $fetchResult = $resp;
        return true;
    });

    if ($fetchResult === null) {
        $r = $fetchWr['reason'] ?? '';
        if ($r === 'fopen' || $r === 'flock' || $r === 'encode') {
            json_out(['ok' => false, 'error' => 'Errore di accesso a stanze.php (permessi o file bloccato).'], 503);
        }
        json_out(['ok' => false, 'error' => 'Impossibile leggere lo stato delle stanze.'], 500);
    }
    json_out($fetchResult);
}

/** GET room (solo query) */
function room_from_request(bool $isPost, ?array $body): string {
    if (isset($_GET['room']) && is_string($_GET['room'])) {
        return sanitize_room_name($_GET['room']);
    }
    if ($isPost && $body !== null && isset($body['room']) && is_string($body['room'])) {
        return sanitize_room_name($body['room']);
    }
    return '';
}

// --- send ---
if ($action === 'send' && $method === 'POST') {
    $rawBody = file_get_contents('php://input');
    if ($rawBody === false || $rawBody === '') {
        json_out(['ok' => false, 'error' => 'Corpo richiesta vuoto.'], 400);
    }
    try {
        $body = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'JSON non valido.'], 400);
    }
    if (!is_array($body)) {
        json_out(['ok' => false, 'error' => 'Formato non valido.'], 400);
    }
    $room = room_prefer_body_then_get($body);
    $nickIn = isset($body['nick']) && is_string($body['nick']) ? $body['nick'] : '';
    $textIn = isset($body['text']) && is_string($body['text']) ? $body['text'] : '';
    if ($room === '') {
        json_out(['ok' => false, 'error' => 'Parametro room obbligatorio.'], 400);
    }
    $nick = sanitize_user_text($nickIn, MAX_NICK_LEN);
    $text = sanitize_user_text($textIn, MAX_TEXT_LEN);
    if ($nick === '' || $text === '') {
        json_out(['ok' => false, 'error' => 'Nickname o messaggio vuoti o non validi.'], 400);
    }
    $newId = 0;
    $wr = with_stanze_exclusive(function (array &$stanze) use ($room, $nick, $text, &$newId): bool {
        if (!isset($stanze[$room])) {
            return false;
        }
        $state = &$stanze[$room];
        if (!can_access_private_room($state, $nick)) {
            return false;
        }
        if (!isset($state['messages']) || !is_array($state['messages'])) {
            $state['messages'] = [];
        }
        if (!isset($state['next_id'])) {
            $state['next_id'] = 1;
        }
        $state['next_id'] = max(1, (int) $state['next_id']);
        $newId = $state['next_id']++;
        $state['messages'][] = [
            'id' => $newId,
            'time' => time(),
            'nick' => $nick,
            'text' => $text,
        ];
        trim_room_messages($state);
        if (isset($state['typing']) && is_array($state['typing'])) {
            $state['typing'] = array_values(array_filter($state['typing'], function ($t) use ($nick) {
                return $t !== $nick;
            }));
        }
        return true;
    });
    if (!$wr['ok']) {
        if ($wr['reason'] !== 'reject') {
            json_out(['ok' => false, 'error' => 'Errore di scrittura su stanze.php (permessi o file bloccato).'], 503);
        }
        json_out(['ok' => false, 'error' => 'Invio non consentito o stanza inesistente.'], 403);
    }
    json_out(['ok' => true, 'id' => $newId, 'room_key' => $room]);
}

// --- delete_room ---
if ($action === 'delete_room') {
    $body = null;
    if ($method === 'POST') {
        $rawBody = file_get_contents('php://input');
        if ($rawBody !== false && $rawBody !== '') {
            try {
                $body = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
            } catch (Throwable $e) {
                $body = null;
            }
        }
    } elseif ($method !== 'GET') {
        json_out(['ok' => false, 'error' => 'Usa GET o POST per delete_room.'], 405);
    }
    $room = room_prefer_body_then_get(is_array($body) ? $body : null);
    $hostNick = is_array($body) && isset($body['host']) && is_string($body['host'])
        ? sanitize_user_text($body['host'], MAX_NICK_LEN)
        : nick_from_body_or_get($body);
    if ($room === '' || $hostNick === '') {
        json_out(['ok' => false, 'error' => 'room e host (nick) obbligatori.'], 400);
    }
    $err = '';
    $had = false;
    $wr = with_stanze_exclusive(function (array &$stanze) use ($room, $hostNick, &$had, &$err): bool {
        if (!isset($stanze[$room])) {
            $had = false;
            return true;
        }
        $state = $stanze[$room];
        if (!is_room_host($state, $hostNick)) {
            $err = 'non_host';
            return false;
        }
        $had = true;
        unset($stanze[$room]);
        return true;
    });
    if (!$wr['ok']) {
        if ($wr['reason'] !== 'reject') {
            json_out(['ok' => false, 'error' => 'Errore di scrittura su stanze.php (permessi o file bloccato).'], 503);
        }
        json_out(['ok' => false, 'error' => $err ?: 'Impossibile aggiornare.'], 403);
    }
    json_out(['ok' => true, 'deleted' => $had, 'room_key' => $room]);
}

json_out(['ok' => false, 'error' => 'Azione o metodo non supportati.'], 405);
