# SQL Read-Only API

A small, **read-only** web API for one table in SQL Server Express. It is meant to run on a PC in your home network, and your Android phone uses it from the browser. The API serves its own phone-friendly page with search, sort and paging, so you don't need to install an app.

```
Android phone ──Wi-Fi──▶ PC running this API (port 8080) ──▶ SQL Server Express
```

## Why it can only read

It is read-only in three separate places:

1. **Database login.** `sql/create-readonly-user.sql` creates a login that has `SELECT` on your one table and nothing else. SQL Server itself refuses any write, even if the API had a bug.
2. **HTTP.** Every method except `GET` and `HEAD` gets `405 This API is read-only`. The code has no routes that write anything.
3. **SQL generation.** The code only ever builds `SELECT` statements. Column names are checked against the table's real columns, and every value goes in as a typed parameter, so SQL injection isn't possible.

On top of that, it only answers devices with a local-network IP address (`LAN_ONLY=true`). You can also require an API key (`API_KEY`).

## Setup (Windows PC)

### 1. Install Node.js
Install the **LTS** version (20.12 or newer) from https://nodejs.org.

### 2. Prepare SQL Server Express
1. **Turn on SQL logins.** In SSMS, right-click the server, then *Properties → Security → SQL Server and Windows Authentication mode*. Restart the SQL Server service.
2. **Create the read-only login.** Open `sql/create-readonly-user.sql` in SSMS. Replace `MyDatabase`, `dbo.Customers` and the password with your own values, then run it.
3. **Turn on TCP/IP.** SQL Server Express ships with TCP/IP off. Open *SQL Server Configuration Manager → SQL Server Network Configuration → Protocols for SQLEXPRESS*, enable **TCP/IP**, and restart the SQL Server service.
   - *Only needed if the API runs on a different PC from SQL Server:* also start the **SQL Server Browser** service, or set a fixed port (TCP/IP → IP Addresses → IPAll → TCP Port = `1433`) and use `DB_PORT=1433`. Then allow that port through Windows Firewall on the SQL Server PC.

### 3. Configure and start the API
In this folder:

```bat
npm install
copy .env.example .env
notepad .env
npm start
```

In `.env`, fill in `DB_NAME`, `DB_USER`, `DB_PASSWORD` and `DB_TABLE`, and pick a long random `API_KEY`. On startup the API prints the address to use:

```
Serving dbo.Customers (6 columns, read-only)
Open on your phone:
  http://192.168.1.20:8080/
```

### 4. Let the phone reach the API
Windows Firewall blocks incoming connections by default. Run this once in an **administrator** command prompt:

```bat
netsh advfirewall firewall add rule name="SQL Read-Only API" dir=in action=allow protocol=TCP localport=8080 profile=private
```

Make sure your Wi-Fi network is set to **Private** in Windows (Settings → Network → Wi-Fi → your network → Private network).

### 5. Use it on Android
1. Connect the phone to the same Wi-Fi.
2. In Chrome, open the address the API printed (for example `http://192.168.1.20:8080/`).
3. Enter your API key when the page asks for it. It is saved on the phone.
4. Optional: in Chrome's menu, tap **Add to Home screen** to get an app-like icon.

> Tip: give the PC a fixed IP address (a DHCP reservation in your router) so the address doesn't change.

### Keep it running (optional)
To start the API automatically when the PC boots, create a Windows Task Scheduler task with these settings:
- **Trigger:** "At startup"
- **Action:** `node.exe` with the argument `src\server.js`
- **Start in:** this folder

## API reference

If `API_KEY` is set, send it as the `X-API-Key` header or as `?key=...`.

| Endpoint | Description |
|---|---|
| `GET /api/health` | `{"status":"ok"}`. Needs no key. |
| `GET /api/columns` | Column names and types, plus the ID column |
| `GET /api/rows` | Filtered and paged rows: `{ total, limit, offset, rows }` |
| `GET /api/rows/{id}` | One row by primary key (or `ID_COLUMN`) |

### `/api/rows` query parameters

| Parameter | Example | Meaning |
|---|---|---|
| `search` | `search=austin` | Matches text anywhere in any text column |
| `Column` | `City=Austin` | Exact match |
| `Column.op` | `Balance.gte=100` | `eq ne gt gte lt lte contains startswith in null` |
| `fields` | `fields=Id,Name` | Return only these columns |
| `sort`, `order` | `sort=Name&order=desc` | Sort the results |
| `limit`, `offset` | `limit=25&offset=50` | Paging (`limit` is capped at `MAX_ROWS`) |

More examples:

```
/api/rows?City=Austin&Active=true
/api/rows?Id.in=1,4,9
/api/rows?Name.startswith=Ann
/api/rows?Joined.gte=2024-01-01&Joined.lt=2025-01-01
/api/rows?Joined.null=true
```

Filters are case-insensitive by column name. An unknown column or a malformed value returns `400` with a message.

Columns of type binary, image, rowversion, geography/geometry, hierarchyid and sql_variant are left out of the results.

### Calling it from your own Android app
Any HTTP client works, for example:

```
GET http://192.168.1.20:8080/api/rows?search=ann
X-API-Key: <your key>
```

Android 9+ blocks plain `http://` in apps by default. Allow cleartext traffic for your PC's IP with a `network_security_config.xml`. Browsers and automation apps such as *HTTP Shortcuts* or *Tasker* don't need this.

## Notes
- **It only serves one table.** To expose a different table, change `DB_TABLE` in `.env` and restart. Views work too, but set `ID_COLUMN` for them.
- **The connection is plain HTTP.** That is fine inside your home network. Don't forward this port on your router, because the API is not designed to face the internet.
- **Tests.** `npm test` runs the tests. They use a fake database, so they don't need SQL Server.
