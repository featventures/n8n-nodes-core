/**
 * Pure helpers shared by the CORE and CORE Trigger nodes. No n8n runtime imports here (types
 * only), so they are unit tested with node:test without an n8n instance.
 */
import type { FieldType, IDataObject } from 'n8n-workflow';

/** A field as returned by GET /v1/entities/{slug}/fields. */
export interface CoreField {
	slug: string;
	name: string;
	type: string;
	required: boolean;
	multiple: boolean;
	read_only: boolean;
	options?: Array<{ value: string; label: string }>;
	related_entity?: string | null;
}

/** A record as returned by the Connect API. */
export interface CoreRecord {
	id: string;
	entity?: string;
	created_at?: string;
	updated_at?: string;
	data?: IDataObject | null;
}

/** Keys of the record envelope that always win over a data field with the same slug. */
export const RECORD_META_KEYS = ['id', 'entity', 'created_at', 'updated_at'] as const;

/**
 * One n8n item per record: `{ id, entity, created_at, updated_at, ...data }`. A data field whose
 * slug clashes with a meta key (or with an `extra` key) is kept under `data_<slug>`.
 */
export function flattenRecord(record: CoreRecord, extra: IDataObject = {}): IDataObject {
	const out: IDataObject = { ...extra };
	for (const key of RECORD_META_KEYS) {
		if (record[key] !== undefined) out[key] = record[key] as string;
	}
	const reserved = new Set<string>(Object.keys(out));
	for (const [slug, value] of Object.entries(record.data ?? {})) {
		out[reserved.has(slug) ? `data_${slug}` : slug] = value;
	}
	return out;
}

/** Field types whose values are lists. */
const ARRAY_TYPES = new Set([
	'files',
	'gallery',
	'linked_records',
	'users',
	'repeater',
	'nested_records',
]);
const NUMBER_TYPES = new Set(['number', 'currency', 'percent', 'auto_number']);
const DATE_TYPES = new Set(['date', 'datetime', 'created_at', 'updated_at']);

/** CORE field type → n8n resource mapper field type. */
export function mapFieldType(field: Pick<CoreField, 'type' | 'multiple' | 'options'>): FieldType {
	const t = field.type;
	if (t === 'select') {
		if (field.multiple) return 'array';
		return field.options && field.options.length > 0 ? 'options' : 'string';
	}
	if (t === 'relation') return field.multiple ? 'array' : 'string';
	if (ARRAY_TYPES.has(t)) return 'array';
	if (NUMBER_TYPES.has(t)) return 'number';
	if (DATE_TYPES.has(t)) return 'dateTime';
	if (t === 'checkbox') return 'boolean';
	if (t === 'daterange') return 'object';
	return 'string';
}

/** Field types that can never identify a record for "Create or Update" (mirrors the API). */
const NON_KEYABLE_TYPES = new Set([
	'linked_records',
	'users',
	'relation',
	'files',
	'gallery',
	'repeater',
	'nested_records',
	'daterange',
	'formula',
	'rollup',
	'automation_button',
	'created_at',
	'updated_at',
	'created_by',
	'updated_by',
]);

export function canMatchOn(field: CoreField): boolean {
	if (field.read_only) return false;
	if (NON_KEYABLE_TYPES.has(field.type)) return false;
	if (field.type === 'select' && field.multiple) return false;
	return true;
}

export const FILTER_OPERATORS = [
	'eq',
	'neq',
	'contains',
	'gt',
	'gte',
	'lt',
	'lte',
	'empty',
	'not_empty',
	'in',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface SearchFilter {
	field: string;
	operator: FilterOperator | string;
	value?: unknown;
}

function filterValue(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/**
 * Filters → query string pairs for GET /v1/records/{slug}:
 * `eq` → `where[f]=v`, other operators → `where[f][op]=v`, `empty`/`not_empty` → `=true`.
 */
export function filtersToQuery(filters: SearchFilter[]): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const f of filters) {
		const field = (f.field ?? '').trim();
		if (!field) continue;
		const op = (f.operator || 'eq') as string;
		if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
			throw new Error(`Unknown filter operator "${op}"`);
		}
		if (op === 'eq') pairs.push([`where[${field}]`, filterValue(f.value)]);
		else if (op === 'empty' || op === 'not_empty') pairs.push([`where[${field}][${op}]`, 'true']);
		else pairs.push([`where[${field}][${op}]`, filterValue(f.value)]);
	}
	return pairs;
}

/** Encodes query pairs, keeping the brackets of `where[...]` readable. */
export function encodeQuery(pairs: Array<[string, string]>): string {
	return pairs
		.map(
			([k, v]) =>
				`${encodeURIComponent(k).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(v)}`,
		)
		.join('&');
}

/** `sort` parameter: `field` ascending, `-field` descending. */
export function sortParam(
	field: string | undefined,
	direction: string | undefined,
): string | undefined {
	const f = (field ?? '').trim();
	if (!f) return undefined;
	return direction === 'desc' ? `-${f}` : f;
}

/**
 * Body of a write from the resource mapper values. Read-only fields, fields not in the schema
 * and (unless `keepEmpty`) empty values are dropped, so an update only touches what was mapped.
 */
export function buildWriteBody(
	values: IDataObject | null | undefined,
	fields: CoreField[],
	options: { keepEmpty?: boolean } = {},
): IDataObject {
	const bySlug = new Map(fields.map((f) => [f.slug, f]));
	const body: IDataObject = {};
	for (const [slug, value] of Object.entries(values ?? {})) {
		const field = bySlug.get(slug);
		if (!field || field.read_only) continue;
		if (!options.keepEmpty && (value === undefined || value === null || value === '')) continue;
		if (value === undefined) continue;
		body[slug] = value;
	}
	return body;
}

/** Seconds to wait after a 429: the Retry-After header, at least 1 s, at most 30 s. */
export function retryAfterSeconds(header: unknown): number {
	const raw = Array.isArray(header) ? header[0] : header;
	const n = Number.parseInt(String(raw ?? ''), 10);
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.min(n, 30);
}

/** The Connect URL without a trailing slash (and without a pasted `/v1`). */
export function normalizeBaseUrl(url: string): string {
	return String(url ?? '')
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/v1$/, '');
}

/** Readable message from a Connect error envelope `{ error: { code, message, field?, allowed? } }`. */
export function describeApiError(body: unknown): {
	code?: string;
	message?: string;
	description?: string;
} {
	let parsed = body;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return {};
		}
	}
	const err = (parsed as { error?: unknown } | null)?.error as
		| { code?: unknown; message?: unknown; field?: unknown; allowed?: unknown }
		| undefined;
	if (!err || typeof err !== 'object') return {};
	const code = typeof err.code === 'string' ? err.code : undefined;
	const message = typeof err.message === 'string' ? err.message : undefined;
	const parts: string[] = [];
	if (code) parts.push(`Code: ${code}`);
	if (typeof err.field === 'string') parts.push(`Field: ${err.field}`);
	if (Array.isArray(err.allowed) && err.allowed.length > 0) {
		parts.push(`Allowed: ${err.allowed.map((a) => String(a)).join(', ')}`);
	}
	return { code, message, description: parts.join(' · ') || undefined };
}
