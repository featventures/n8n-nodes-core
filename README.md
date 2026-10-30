# @featventures/n8n-nodes-core

n8n community nodes for **CORE**: read, create, update and search the records of your CORE
workspace, and start a workflow when a record is created, updated or deleted.

The package contains:

- **CORE**, an action node for records and entities;
- **CORE Trigger**, a webhook trigger that registers itself in CORE;
- the **CORE API** credential.

Both nodes talk to the CORE **Connect API** (`/v1`), which takes one header and names entities and
fields by slug.

[Installation](#installation) ·
[Credentials](#credentials) ·
[Operations](#operations) ·
[Trigger](#trigger) ·
[Signature verification](#signature-verification) ·
[Compatibility](#compatibility) ·
[Development](#development) ·
[Changelog](#changelog)

## Installation

In n8n: **Settings › Community Nodes › Install**, enter `@featventures/n8n-nodes-core` and confirm.
See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/).

Self-hosted from the command line:

```bash
cd ~/.n8n/nodes && npm install @featventures/n8n-nodes-core
```

## Credentials

Create the connection in CORE first: **Integrations › n8n › Connect**. CORE shows two values:

| Credential field | Where it comes from                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connect URL**  | The Connect URL shown in CORE › Integrations › n8n (for example `https://<project>.supabase.co/functions/v1/connect`)                                        |
| **API Key**      | The key of that connection, starting with `core_`. CORE shows it **once**: copy it when the connection is created (you can regenerate it from the same page) |

Every request sends `Authorization: Bearer <API Key>`. n8n tests the credential with `GET /v1/me`.

The key belongs to a role: it sees and changes only the entities that role allows (Editor or
Viewer, on every entity or on the chosen ones). A revoked or regenerated key stops working at once.

## Operations

### Record

| Operation            | What it does                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create**           | Creates a record from the mapped fields                                                                                                         |
| **Create or Update** | Updates the record that has the same value in the field you pick in **Match On Field**; creates it if there is none (`POST ?upsert_on=<field>`) |
| **Update**           | Changes **only the fields you add** to the mapping (`PATCH`, a merge): the other fields keep their value                                        |
| **Delete**           | Moves the record to the trash                                                                                                                   |
| **Get**              | Reads one record by ID                                                                                                                          |
| **Search**           | Finds records with filters, with **Return All** (follows the pages) or a **Limit**, and an optional sort                                        |

**Entity** is picked from a list (the entities the key can read) or typed **By Slug**, also as an
expression.

**Fields** use n8n's field mapper, loaded from the entity: names, types (text, number, date,
yes/no, select with its options), required fields flagged. Computed and read-only fields (formulas,
rollups, automatic numbering, created/updated metadata) are not listed. You can also **Map
Automatically**: the input fields whose names match a field slug are sent.

Empty mapped values are not sent, so they never clear a field by accident. To clear a field, turn
on **Options › Send Empty Values**.

Values: for a **select** you can send the value or its label; a **relation** takes the ID of the
linked record (or its exact title).

**Search filters** are all combined with AND: `Equals`, `Not Equals`, `Contains`
(case-insensitive), `Greater Than`, `Greater Than or Equal`, `Less Than`, `Less Than or Equal`
(numbers and dates such as `2026-12-31`), `Is Empty`, `Is Not Empty`, `Is One Of` (comma-separated
values). Without a sort, the newest records come first.

### Entity

| Operation      | What it does                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| **List**       | The entities the key can read, with `can_create`, `can_update`, `can_delete`                             |
| **Get Fields** | The fields of an entity: slug, name, type, required, multiple, read-only, select options, related entity |

### Output

Every record becomes one item, with the record data at the top level:

```json
{
	"id": "…",
	"entity": "clienti",
	"created_at": "…",
	"updated_at": "…",
	"nome": "Mario",
	"email": "mario@example.com",
	"stato": "open"
}
```

If a field slug is the same as one of `id`, `entity`, `created_at`, `updated_at`, the record
metadata wins and the field is returned as `data_<slug>` (for example a field `id` becomes
`data_id`). Delete returns `{ "id": "…", "entity": "…", "deleted": true }`.

### Errors and limits

Errors carry CORE's readable message, and the details show the code (for example
`select_option_invalid`), the field and, when relevant, the allowed values. With **Continue On
Fail** the failing item outputs `{ "error": "…", "description": "…" }` and the others go on.

The API allows 120 requests per minute per key. On `429` the node waits for `Retry-After` (at most
30 seconds) and retries once.

## Trigger

**CORE Trigger** starts the workflow when a record of an entity is created, updated or deleted
(moving it to the trash counts as deleted). Parameters:

- **Entity**: from the list or by slug;
- **Events**: Record Created, Record Updated, Record Deleted (one or more);
- **Only When These Fields Change**: for Record Updated, start only when one of these fields
  changes (empty: any change).

When the workflow is activated (or you listen for a test event), the node registers a webhook
subscription in CORE (`POST /v1/subscriptions`) with its own URL and keeps the subscription ID and
signing secret in the workflow's static data. Deactivating the workflow removes it
(`DELETE /v1/subscriptions/{id}`). The subscription appears in CORE under the n8n connection.

Changes made with the same connection's key do not trigger it, so a workflow that updates the record
that started it does not loop.

Each execution receives one item:

```json
{
	"event": "record.updated",
	"delivery_id": "…",
	"occurred_at": "…",
	"entity_name": "Clienti",
	"changed_fields": ["stato"],
	"id": "…",
	"entity": "clienti",
	"created_at": "…",
	"updated_at": "…",
	"nome": "Mario",
	"stato": "closed"
}
```

The record data is flattened as in the CORE node; a field that clashes with one of the keys above is
returned as `data_<slug>`.

CORE needs to reach the webhook URL over **public https**: a local n8n (`localhost`, private IPs)
is refused. Use a tunnel or a public instance.

## Signature verification

Every delivery is signed. The trigger checks it before running the workflow and answers `401`
otherwise:

- `X-Core-Signature: sha256=<hex>`, the HMAC-SHA256 of `"<X-Core-Timestamp>.<raw body>"` with the
  subscription secret;
- `X-Core-Timestamp` must be within 5 minutes of the n8n clock (keep the server time in sync).

If you receive CORE webhooks in a plain **Webhook** node instead, verify them the same way:

```js
const crypto = require('crypto');
const t = headers['x-core-timestamp'];
const expected =
	'sha256=' + crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex');
const valid =
	expected === headers['x-core-signature'] && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

CORE expects a `2xx` within 10 seconds; otherwise it retries after 1, 5 and 30 minutes, and turns the
subscription off after 20 failed deliveries in a row.

## Compatibility

- n8n **1.x** with the community nodes API v1 (`n8nNodesApiVersion: 1`); built and linted with
  `@n8n/node-cli` 0.54 and tested against `n8n-workflow` 2.x.
- Node.js 20.15 or newer.
- No runtime dependencies (only Node's built-in `crypto` for the signature).
- CORE Connect API `v1`. `v1` never renames or removes fields or error codes.

## Development

```bash
npm install
npm run build   # n8n-node build → dist/
npm run lint    # n8n-node lint (strict, n8n Cloud rules)
npm test        # unit tests of the pure helpers (node:test)
npm run dev     # local n8n with the nodes loaded, at http://localhost:5678
```

Releases are published by `.github/workflows/publish.yml` on a version tag (`npm run release`), to
npm with provenance through GitHub Actions (npm Trusted Publishers).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

### 0.1.0

First release: CORE node (Record: Create, Create or Update, Update, Delete, Get, Search; Entity:
List, Get Fields), CORE Trigger (record created / updated / deleted, signed webhooks) and the CORE
API credential.

## License

[MIT](LICENSE.md)
