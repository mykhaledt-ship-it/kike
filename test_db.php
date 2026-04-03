<?php
include 'api/index.php';

echo "Testing database connection...\n";
$pdo = get_database_connection();
if ($pdo === null) {
    echo "Database connection failed. Using JSON fallback.\n";
    echo "SQLite ready: " . (is_sqlite_ready() ? 'Yes' : 'No') . "\n";
} else {
    echo "Database connection successful.\n";
    echo "SQLite ready: Yes\n";
}
?>