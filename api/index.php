<?php
function log_error($message) {
    $logFile = dirname(__FILE__) . '/../storage/api-error.log';
    $dir = dirname($logFile);
    if (!is_dir($dir) && !@mkdir($dir, 0777, true) && !is_dir($dir)) {
        return;
    }
    @file_put_contents($logFile, date('c') . ' ' . $message . "\n", FILE_APPEND);
}

function append_debug_log($filePath, $message)
{
    $directory = dirname($filePath);
    if (!is_dir($directory) && !@mkdir($directory, 0777, true) && !is_dir($directory)) {
        return false;
    }

    return @file_put_contents($filePath, $message, FILE_APPEND) !== false;
}

log_error('[API] Script started');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

function set_status($status)
{
    static $messages = array(
        200 => 'OK',
        204 => 'No Content',
        400 => 'Bad Request',
        404 => 'Not Found',
        405 => 'Method Not Allowed',
        423 => 'Locked',
        500 => 'Internal Server Error'
    );

    if (function_exists('http_response_code')) {
        http_response_code((int) $status);
        return;
    }

    $code = (int) $status;
    $message = isset($messages[$code]) ? $messages[$code] : 'OK';
    $protocol = isset($_SERVER['SERVER_PROTOCOL']) ? $_SERVER['SERVER_PROTOCOL'] : 'HTTP/1.1';
    header($protocol . ' ' . $code . ' ' . $message);
}

function json_flags()
{
    static $flags = null;
    if ($flags !== null) {
        return $flags;
    }

    $flags = 0;
    if (defined('JSON_UNESCAPED_UNICODE')) {
        $flags |= JSON_UNESCAPED_UNICODE;
    }
    if (defined('JSON_UNESCAPED_SLASHES')) {
        $flags |= JSON_UNESCAPED_SLASHES;
    }
    if (defined('JSON_PRETTY_PRINT')) {
        $flags |= JSON_PRETTY_PRINT;
    }

    return $flags;
}

function send_json($data, $status)
{
    set_status($status);
    echo json_encode($data, json_flags());
    exit;
}

function server_value($key, $default)
{
    return isset($_SERVER[$key]) ? $_SERVER[$key] : $default;
}

function env_value($key, $default)
{
    $value = getenv($key);
    if ($value === false || $value === null || $value === '') {
        return $default;
    }

    return $value;
}

function array_value($array, $key, $default)
{
    if (!is_array($array) || !array_key_exists($key, $array)) {
        return $default;
    }

    return $array[$key];
}

function strip_utf8_bom($text)
{
    $text = is_string($text) ? $text : '';
    if (strncmp($text, "\xEF\xBB\xBF", 3) === 0) {
        return substr($text, 3);
    }

    return $text;
}

function current_scheme()
{
    $forwarded = trim((string) server_value('HTTP_X_FORWARDED_PROTO', ''));
    if ($forwarded !== '') {
        $parts = explode(',', $forwarded);
        $primary = strtolower(trim($parts[0]));
        return $primary === 'https' ? 'https' : 'http';
    }

    $https = strtolower((string) server_value('HTTPS', ''));
    return ($https !== '' && $https !== 'off') ? 'https' : 'http';
}

function get_base_path()
{
    $scriptName = str_replace('\\', '/', (string) server_value('SCRIPT_NAME', '/api/index.php'));
    $directory = str_replace('\\', '/', dirname($scriptName));
    $basePath = preg_replace('#/api(?:/index\.php)?$#i', '', $directory);

    if (!is_string($basePath) || $basePath === '.' || $basePath === '/') {
        return '';
    }

    return rtrim($basePath, '/');
}

function get_public_base_url()
{
    $configured = rtrim((string) env_value('PUBLIC_BASE_URL', ''), '/');
    if ($configured !== '') {
        return $configured;
    }

    $host = (string) server_value('HTTP_HOST', 'localhost');
    return rtrim(current_scheme() . '://' . $host . get_base_path(), '/');
}

function get_data_file_candidates()
{
    $candidates = array();
    $configured = trim((string) env_value('DATA_FILE', ''));
    if ($configured !== '') {
        $candidates[] = $configured;
    }

    $root = dirname(dirname(__FILE__));
    $candidates[] = $root . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'lab_data.json';
    $candidates[] = $root . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'lab_data.json';
    $candidates[] = $root . DIRECTORY_SEPARATOR . 'lab_data.json';

    $unique = array();
    foreach ($candidates as $candidate) {
        $normalized = str_replace(array('/', '\\'), DIRECTORY_SEPARATOR, (string) $candidate);
        if ($normalized === '' || in_array($normalized, $unique, true)) {
            continue;
        }
        $unique[] = $normalized;
    }

    log_error('[API] get_data_file_candidates: ' . json_encode($unique));
    return $unique;
}

function ensure_directory_exists($directory)
{
    if (is_dir($directory)) {
        return true;
    }

    $result = @mkdir($directory, 0777, true) || is_dir($directory);
    if (!$result) {
        log_error('[API] ensure_directory_exists: failed to create ' . $directory);
    }
    return $result;
}

function is_writable_target($file)
{
    $directory = dirname($file);
    if (!ensure_directory_exists($directory)) {
        log_error('[API] is_writable_target: directory not creatable: ' . $directory);
        return false;
    }

    if (file_exists($file)) {
        $writable = is_writable($file);
        if (!$writable) {
            log_error('[API] is_writable_target: file not writable: ' . $file);
        }
        return $writable;
    }

    $writable = is_writable($directory);
    if (!$writable) {
        log_error('[API] is_writable_target: directory not writable: ' . $directory);
    }
    return $writable;
}

function select_primary_data_file($candidates)
{
    log_error('[API] select_primary_data_file: candidates=' . json_encode($candidates));
    foreach ($candidates as $candidate) {
        if (is_writable_target($candidate)) {
            log_error('[API] select_primary_data_file: selected writable=' . $candidate);
            return $candidate;
        }
    }

    if (!empty($candidates)) {
        log_error('[API] select_primary_data_file: fallback to first=' . $candidates[0]);
        return $candidates[0];
    }

    return dirname(dirname(__FILE__)) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'lab_data.json';
}

function get_database_file()
{
    return dirname(dirname(__FILE__)) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'lab_data.db';
}

function get_database_connection()
{
    log_error('[API] get_database_connection: sqlite disabled in JSON-only mode');
    return null;
}

function is_sqlite_ready()
{
    log_error('[API] is_sqlite_ready: false');
    return false;
}

function initialize_database($pdo)
{
    log_error('[API] initialize_database: starting');
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS orders (
            patient_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    ");
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    ");
    $pdo->exec("
        CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders (updated_at);
    ");
    log_error('[API] initialize_database: success');
}

function get_backup_directory()
{
    return dirname(dirname(__FILE__)) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'backups';
}

function cleanup_old_backups($directory, $limit)
{
    if (!is_dir($directory)) {
        return;
    }

    $files = glob($directory . DIRECTORY_SEPARATOR . '*.bak.json');
    if (!is_array($files)) {
        return;
    }

    usort($files, function ($left, $right) {
        return (int) @filemtime($right) - (int) @filemtime($left);
    });

    $limit = (int) $limit;
    if ($limit < 1) {
        $limit = 25;
    }

    foreach (array_slice($files, $limit) as $file) {
        @unlink($file);
    }
}

function create_backup_copy($file, $content)
{
    $text = strip_utf8_bom(is_string($content) ? $content : '');
    if (trim($text) === '') {
        return;
    }

    $directory = get_backup_directory();
    if (!ensure_directory_exists($directory)) {
        return;
    }

    $safeName = preg_replace('/[^\w.\-]+/u', '_', basename($file));
    $stamp = gmdate('Y-m-d\TH-i-s') . '-' . substr(str_replace('.', '', (string) microtime(true)), -6);
    $backupFile = $directory . DIRECTORY_SEPARATOR . $safeName . '.' . $stamp . '.bak.json';
    @file_put_contents($backupFile, $text);
    cleanup_old_backups($directory, 25);
}

function read_latest_backup_orders()
{
    $directory = get_backup_directory();
    if (!is_dir($directory)) {
        return array();
    }

    $files = glob($directory . DIRECTORY_SEPARATOR . '*.bak.json');
    if (!is_array($files) || empty($files)) {
        return array();
    }

    usort($files, function ($left, $right) {
        return (int) @filemtime($right) - (int) @filemtime($left);
    });

    foreach ($files as $file) {
        $text = @file_get_contents($file);
        if ($text === false) {
            continue;
        }

        $decoded = decode_orders($text);
        if (!empty($decoded) || trim(strip_utf8_bom($text)) === '[]') {
            return $decoded;
        }
    }

    return array();
}

function generate_share_token()
{
    $random = '';
    if (function_exists('random_bytes')) {
        try {
            $random = bin2hex(random_bytes(4));
        } catch (Exception $exception) {
            $random = '';
        }
    }

    if ($random === '') {
        $random = substr(md5(uniqid('', true) . mt_rand()), 0, 8);
    }

    return 'res_' . base_convert((string) round(microtime(true) * 1000), 10, 36) . '_' . $random;
}

function default_public_settings()
{
    return array(
        'headerTitle' => 'نتائج التحاليل الطبية',
        'headerLead' => 'المنصة المعتمدة لعرض النتائج',
        'footerText' => 'النتائج الظاهرة هنا مرتبطة بالطلب المحفوظ في النظام.'
    );
}

function normalize_order($order)
{
    $patient = is_array(array_value($order, 'patient', null)) ? $order['patient'] : array();
    $patientId = array_key_exists('patient_id', $order) ? $order['patient_id'] : array_value($patient, 'id', null);
    $shareToken = array_key_exists('share_token', $order) ? $order['share_token'] : array_value($patient, 'share_token', generate_share_token());
    $resultsPublished = !empty($order['results_published']) || !empty(array_value($patient, 'results_published', false));
    $publishedAt = array_key_exists('published_at', $order) ? $order['published_at'] : array_value($patient, 'published_at', null);
    $createdAt = array_key_exists('created_at', $order) ? $order['created_at'] : array_value($order, 'date', gmdate('c'));
    $updatedAt = array_key_exists('updated_at', $order) ? $order['updated_at'] : array_value($order, 'date', $createdAt);
    $settings = is_array(array_value($order, 'settings', null)) ? $order['settings'] : array();
    $defaultSettings = default_public_settings();

    $patient['id'] = $patientId;
    $patient['share_token'] = $shareToken;
    $patient['results_published'] = $resultsPublished;
    $patient['published_at'] = $publishedAt;

    return array(
        'patient_id' => $patientId,
        'patient' => $patient,
        'order' => array_values(is_array(array_value($order, 'order', null)) ? $order['order'] : array()),
        'settings' => array(
            'headerTitle' => array_value($settings, 'headerTitle', $defaultSettings['headerTitle']),
            'headerLead' => array_value($settings, 'headerLead', $defaultSettings['headerLead']),
            'footerText' => array_value($settings, 'footerText', $defaultSettings['footerText'])
        ),
        'created_at' => $createdAt,
        'updated_at' => $updatedAt,
        'share_token' => $shareToken,
        'results_published' => $resultsPublished,
        'published_at' => $publishedAt
    );
}

function decode_orders($text)
{
    $text = strip_utf8_bom($text);
    if (trim($text) === '') {
        return array();
    }

    $decoded = json_decode($text, true);
    if (!is_array($decoded)) {
        return array();
    }

    $normalized = array();
    foreach ($decoded as $row) {
        if (is_array($row)) {
            $normalized[] = normalize_order($row);
        }
    }

    return array_values($normalized);
}

function read_orders($files)
{
    foreach ($files as $file) {
        if (!file_exists($file) || !is_readable($file)) {
            continue;
        }

        $handle = @fopen($file, 'rb');
        if ($handle === false) {
            continue;
        }

        if (function_exists('flock')) {
            @flock($handle, LOCK_SH);
        }

        $text = stream_get_contents($handle);
        if ($text === false) {
            $text = '';
        }

        if (function_exists('flock')) {
            @flock($handle, LOCK_UN);
        }
        fclose($handle);

        $decoded = decode_orders($text);
        if (!empty($decoded) || trim($text) === '' || trim($text) === '[]') {
            return $decoded;
        }
    }

    return read_latest_backup_orders();
}

function mutate_orders($file, $readCandidates, $callback)
{
    log_error('[API] mutate_orders: starting for file=' . $file);
    $directory = dirname($file);
    if (!ensure_directory_exists($directory)) {
        log_error('[API] mutate_orders: cannot create directory: ' . $directory);
        send_json(array(
            'message' => 'Could not create data directory',
            'path' => $directory
        ), 500);
    }

    if (!file_exists($file)) {
        @file_put_contents($file, '[]');
    }

    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        log_error('[API] mutate_orders: cannot open file: ' . $file);
        send_json(array(
            'message' => 'Could not open data file for writing',
            'path' => $file
        ), 500);
    }

    if (function_exists('flock')) {
        @flock($handle, LOCK_EX);
    }

    rewind($handle);
    $text = stream_get_contents($handle);
    if ($text === false) {
        $text = '';
    }

    if (trim($text) !== '') {
        $decodedOrders = decode_orders($text);
        if (!empty($decodedOrders) || trim($text) === '[]') {
            $orders = $decodedOrders;
        } else {
            $orders = read_latest_backup_orders();
        }
    } else {
        $orders = array();
    }

    $result = $callback($orders);
    $normalized = array();
    foreach ($orders as $entry) {
        $normalized[] = normalize_order($entry);
    }

    if (trim($text) !== '') {
        create_backup_copy($file, $text);
    }

    rewind($handle);
    ftruncate($handle, 0);
    $json = json_encode(array_values($normalized), json_flags());
    if ($json === false) {
        log_error('[API] mutate_orders: json_encode failed: ' . json_last_error_msg());
        $json = '[]';
    }
    $written = fwrite($handle, $json);

    fflush($handle);
    if (function_exists('flock')) {
        @flock($handle, LOCK_UN);
    }
    fclose($handle);

    if ($written === false) {
        log_error('[API] mutate_orders: fwrite failed for file=' . $file);
        send_json(array(
            'message' => 'Could not write data file',
            'path' => $file
        ), 500);
    }

    log_error('[API] mutate_orders: success, wrote ' . strlen($json) . ' bytes to ' . $file);
    return $result;
}

function find_order_index($orders, $patientId)
{
    foreach ($orders as $index => $order) {
        $currentId = array_value($order, 'patient_id', '');
        if ((string) $currentId === (string) $patientId) {
            return $index;
        }
    }

    return -1;
}

function get_route()
{
    if (isset($_GET['route'])) {
        return trim((string) $_GET['route'], '/');
    }

    $uriPath = parse_url((string) server_value('REQUEST_URI', ''), PHP_URL_PATH);
    if (!is_string($uriPath)) {
        return '';
    }

    $trimmed = trim($uriPath, '/');
    $position = strpos($trimmed, 'api/');
    if ($position === false) {
        return '';
    }

    return trim(substr($trimmed, $position + 4), '/');
}

function get_json_payload()
{
    $raw = @file_get_contents('php://input');
    $raw = strip_utf8_bom($raw === false ? '' : $raw);

    if (trim($raw) === '') {
        log_error('[API] get_json_payload: empty input');
        return array();
    }

    $decoded = json_decode($raw, true);
    if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
        log_error('[API] get_json_payload: JSON decode error: ' . json_last_error_msg() . ' for input: ' . substr($raw, 0, 100));
        return array();
    }
    return is_array($decoded) ? $decoded : array();
}

function error_payload($message, $details, $file, $line)
{
    return array(
        'status' => 'error',
        'message' => $message,
        'error' => $details,
        'file' => $file,
        'line' => $line
    );
}

set_error_handler(function ($severity, $message, $file, $line) {
    if (!(error_reporting() & $severity)) {
        return false;
    }

    log_error('[API] PHP warning: ' . $message . ' in ' . $file . ':' . $line);
    return true;
});

set_exception_handler(function ($exception) {
    $message = is_object($exception) && method_exists($exception, 'getMessage') ? $exception->getMessage() : 'Unhandled exception';
    $file = is_object($exception) && method_exists($exception, 'getFile') ? $exception->getFile() : '';
    $line = is_object($exception) && method_exists($exception, 'getLine') ? $exception->getLine() : 0;
    send_json(error_payload('Internal Server Error', $message, $file, $line), 500);
});

register_shutdown_function(function () {
    $error = error_get_last();
    if (!$error || headers_sent()) {
        return;
    }

    $fatalTypes = array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR);
    if (!in_array($error['type'], $fatalTypes, true)) {
        return;
    }

    header('Content-Type: application/json; charset=utf-8');
    set_status(500);
    echo json_encode(error_payload('Internal Server Error', $error['message'], $error['file'], $error['line']), json_flags());
});

$requestMethod = server_value('REQUEST_METHOD', 'GET');
if ($requestMethod === 'OPTIONS') {
    set_status(204);
    exit;
}

$dataFileCandidates = get_data_file_candidates();
$dataFile = select_primary_data_file($dataFileCandidates);

$route = get_route();
$method = strtoupper((string) server_value('REQUEST_METHOD', 'GET'));
$parts = $route === '' ? array() : explode('/', $route);

log_error('[API] Starting request: route=' . $route . ', method=' . $method . ', dataFile=' . $dataFile);

if ($route === '' || $route === 'health') {
    log_error('[API] health: starting');
    $dbStatus = 'json';
    $connected = is_writable_target($dataFile);

    log_error('[API] health: dbStatus=' . $dbStatus . ', connected=' . ($connected ? 'true' : 'false'));
    send_json(array(
        'status' => 'ok',
        'db' => $dbStatus,
        'connected' => $connected,
        'runtime' => 'php'
    ), 200);
}

if ($route === 'config') {
    send_json(array(
        'publicBaseUrl' => get_public_base_url(),
        'centerName' => env_value('CENTER_NAME', 'مختبر التحاليل الطبية'),
        'runtime' => 'php'
    ), 200);
}

if (array_value($parts, 0, '') === 'public-results' && isset($parts[1]) && $method === 'GET') {
    $token = $parts[1];
    $orders = read_orders($dataFileCandidates);

    foreach ($orders as $order) {
        if ((string) array_value($order, 'share_token', '') !== (string) $token) {
            continue;
        }

        $safeOrder = normalize_order($order);
        if (empty($safeOrder['results_published'])) {
            send_json(array(
                'message' => 'Results are not published yet',
                'published' => false,
                'settings' => $safeOrder['settings']
            ), 423);
        }

        send_json(array(
            'patient_id' => $safeOrder['patient_id'],
            'patient' => $safeOrder['patient'],
            'order' => $safeOrder['order'],
            'settings' => $safeOrder['settings'],
            'created_at' => $safeOrder['created_at'],
            'updated_at' => $safeOrder['updated_at'],
            'share_token' => $safeOrder['share_token'],
            'results_published' => $safeOrder['results_published'],
            'published_at' => $safeOrder['published_at']
        ), 200);
    }

    send_json(array('message' => 'Result link not found'), 404);
}

if (array_value($parts, 0, '') === 'orders') {
    if (count($parts) === 1) {
        if ($method === 'GET') {
            $orders = read_orders($dataFileCandidates);
            usort($orders, function ($a, $b) {
                $left = (string) array_value($a, 'updated_at', array_value($a, 'created_at', ''));
                $right = (string) array_value($b, 'updated_at', array_value($b, 'created_at', ''));
                return strcmp($right, $left);
            });
            send_json($orders, 200);
        }

        if ($method === 'POST') {
            $rawInput = @file_get_contents('php://input');
            log_error('[API] POST /api/orders raw input: ' . substr($rawInput, 0, 200));
            $payload = get_json_payload();
            append_debug_log(
                dirname(__FILE__) . '/../storage/api-debug.log',
                date('c') . " POST /api/orders payload=" . json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n"
            );
            $patient = is_array(array_value($payload, 'patient', null)) ? $payload['patient'] : array();
            $orderItems = is_array(array_value($payload, 'order', null)) ? $payload['order'] : array();
            $settings = is_array(array_value($payload, 'settings', null)) ? $payload['settings'] : array();
            $patientId = array_value($patient, 'id', null);

            if ($patientId === null || $patientId === '') {
                send_json(array('error' => 'patient.id is required'), 400);
            }

            $now = gmdate('c');
            $response = mutate_orders($dataFile, $dataFileCandidates, function (&$orders) use ($patient, $patientId, $orderItems, $settings, $now) {
                $existingIndex = find_order_index($orders, $patientId);
                $existingEntry = $existingIndex >= 0 ? normalize_order($orders[$existingIndex]) : null;

                $entry = normalize_order(array(
                    'patient_id' => $patientId,
                    'patient' => array_merge($patient, array(
                        'results_published' => is_array($existingEntry) ? !empty($existingEntry['results_published']) : false,
                        'published_at' => is_array($existingEntry) ? array_value($existingEntry, 'published_at', null) : null,
                        'share_token' => is_array($existingEntry) ? array_value($existingEntry, 'share_token', array_value($patient, 'share_token', generate_share_token())) : array_value($patient, 'share_token', generate_share_token())
                    )),
                    'order' => $orderItems,
                    'settings' => !empty($settings) ? $settings : (is_array($existingEntry) ? array_value($existingEntry, 'settings', array()) : array()),
                    'created_at' => is_array($existingEntry) ? array_value($existingEntry, 'created_at', $now) : $now,
                    'updated_at' => $now,
                    'share_token' => is_array($existingEntry) ? array_value($existingEntry, 'share_token', array_value($patient, 'share_token', generate_share_token())) : array_value($patient, 'share_token', generate_share_token()),
                    'results_published' => is_array($existingEntry) ? !empty($existingEntry['results_published']) : false,
                    'published_at' => is_array($existingEntry) ? array_value($existingEntry, 'published_at', null) : null
                ));

                if ($existingIndex >= 0) {
                    $orders[$existingIndex] = $entry;
                } else {
                    $orders[] = $entry;
                }

                return array(
                    'saved' => true,
                    'patientId' => $patientId,
                    'date' => $now,
                    'shareToken' => $entry['share_token'],
                    'resultsPublished' => $entry['results_published'],
                    'publishedAt' => $entry['published_at']
                );
            });

            send_json($response, 200);
        }

        send_json(array('message' => 'Method not allowed'), 405);
    }

    $patientId = array_value($parts, 1, null);
    if ($patientId === null) {
        send_json(array('message' => 'Order route is incomplete'), 404);
    }

    if (count($parts) === 2 && $method === 'GET') {
        $orders = read_orders($dataFileCandidates);
        foreach ($orders as $order) {
            if ((string) array_value($order, 'patient_id', '') === (string) $patientId) {
                send_json(normalize_order($order), 200);
            }
        }

        send_json(array('message' => 'Order not found'), 404);
    }

    if (count($parts) === 2 && $method === 'DELETE') {
        $deleted = mutate_orders($dataFile, $dataFileCandidates, function (&$orders) use ($patientId) {
            $before = count($orders);
            $filtered = array();

            foreach ($orders as $order) {
                if ((string) array_value($order, 'patient_id', '') !== (string) $patientId) {
                    $filtered[] = $order;
                }
            }

            $orders = array_values($filtered);
            return count($orders) !== $before;
        });

        if (!$deleted) {
            send_json(array('message' => 'Order not found'), 404);
        }

        send_json(array('deleted' => true), 200);
    }

    if (count($parts) === 3 && $method === 'POST' && in_array($parts[2], array('publish', 'unpublish'), true)) {
        $shouldPublish = $parts[2] === 'publish';
        $response = mutate_orders($dataFile, $dataFileCandidates, function (&$orders) use ($patientId, $shouldPublish) {
            $index = find_order_index($orders, $patientId);
            if ($index < 0) {
                return null;
            }

            $entry = normalize_order($orders[$index]);
            $entry['results_published'] = $shouldPublish;
            $entry['published_at'] = $shouldPublish ? gmdate('c') : null;
            $entry['patient']['results_published'] = $entry['results_published'];
            $entry['patient']['published_at'] = $entry['published_at'];
            $orders[$index] = $entry;

            return array(
                'published' => $shouldPublish,
                'patientId' => ctype_digit((string) $patientId) ? (int) $patientId : $patientId,
                'publishedAt' => $entry['published_at'],
                'shareToken' => $entry['share_token']
            );
        });

        if ($response === null) {
            send_json(array('message' => 'Order not found'), 404);
        }

        send_json($response, 200);
    }
}

send_json(array(
    'message' => 'Route not found',
    'route' => $route
), 404);
