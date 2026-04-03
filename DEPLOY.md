# Deployment Guide

This project is now a Node.js + SQLite application.

Hosting requirements:
- Node.js hosting support
- Node.js 20 or later
- Ability to keep a Node process running
- Writable `storage/` directory

Deployment steps:
1. Upload the project files.
2. Run `npm install --production`.
3. Start the app with `npm start`.
4. Point the domain or reverse proxy to port `3100`, or set the `PORT` environment variable provided by the host.

Important files:
- `server.js`: main application server
- `storage/lab_system.sqlite`: SQLite database created automatically
- `storage/bootstrap-admin.txt`: initial admin login, secure or remove after first login

Routing note:
- On Node.js hosting, requests should be served by `server.js`.
- The frontend now prefers the REST API (`/api/...`) directly.
- `api/index.php` is only a legacy fallback and is not required for Node deployments.

Optional environment variables:
- `PORT`: server port
- `HOST`: bind host, default `0.0.0.0`
- `PUBLIC_BASE_URL`: public base URL for generated links
- `DATA_FILE`: legacy JSON file path for first-time import
- `CENTER_NAME`: default lab name
- `ADMIN_USERNAME`: bootstrap admin username override
- `ADMIN_PASSWORD`: bootstrap admin password override

Security note:
- Change the bootstrap admin password after first login.
- Restrict access to `storage/` if your hosting panel exposes raw files.
