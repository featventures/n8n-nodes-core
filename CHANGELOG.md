# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-30

### Added

- **CORE API** credential: Connect URL + API key (`Authorization: Bearer core_…`), tested with `GET /v1/me`.
- **CORE** node
  - Record: Create, Create or Update (upsert on a field picked from a list), Update (only the
    mapped fields), Delete (to the trash), Get, Search (filters, Return All / Limit, sort).
  - Entity: List, Get Fields.
  - Entity picker from the list or by slug; fields mapped with n8n's resource mapper (types,
    select options, required fields; read-only fields left out).
  - One item per record with the data at the top level (`data_<slug>` on a clash with the
    record metadata); readable API errors; Continue On Fail; one retry after a 429.
- **CORE Trigger** node: record created / updated / deleted, optional field filter for updates,
  self-registering webhook subscription, HMAC-SHA256 signature check with a 5-minute window.
