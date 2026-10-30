// Runs against the compiled helpers (`npm test` builds them to dist-test/ first). Plain JS on
// purpose: the n8n strict lint forbids node:test imports in .ts files and its config is locked.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
	buildWriteBody,
	canMatchOn,
	describeApiError,
	encodeQuery,
	filtersToQuery,
	flattenRecord,
	mapFieldType,
	normalizeBaseUrl,
	retryAfterSeconds,
	sortParam,
} from '../dist-test/nodes/Core/helpers.js';
import { computeSignature, verifySignature } from '../dist-test/nodes/CoreTrigger/signature.js';

const field = (over) => ({
	slug: 'f',
	name: 'F',
	type: 'text',
	required: false,
	multiple: false,
	read_only: false,
	...over,
});

describe('signature', () => {
	it('matches the documented test vector', () => {
		const expected =
			'sha256=' +
			createHmac('sha256', 'whsec_test')
				.update('1700000000.{"event":"record.created"}')
				.digest('hex');
		assert.equal(
			computeSignature('whsec_test', 1700000000, '{"event":"record.created"}'),
			expected,
		);
		assert.equal(
			computeSignature('whsec_test', '1700000000', '{"event":"record.created"}'),
			expected,
		);
	});

	const body = '{"event":"record.created"}';
	const sig = computeSignature('whsec_test', '1700000000', body);

	it('accepts a valid signature inside the window', () => {
		const r = verifySignature({
			secret: 'whsec_test',
			timestamp: '1700000000',
			signature: sig,
			rawBody: body,
			nowSeconds: 1700000299,
		});
		assert.deepEqual(r, { valid: true });
	});

	it('rejects a timestamp older or newer than 300 s', () => {
		for (const now of [1700000301, 1699999699]) {
			const r = verifySignature({
				secret: 'whsec_test',
				timestamp: '1700000000',
				signature: sig,
				rawBody: body,
				nowSeconds: now,
			});
			assert.deepEqual(r, { valid: false, reason: 'stale_timestamp' });
		}
	});

	it('rejects a tampered body, a wrong secret and missing headers', () => {
		const base = { timestamp: '1700000000', signature: sig, nowSeconds: 1700000000 };
		assert.equal(
			verifySignature({ ...base, secret: 'whsec_test', rawBody: body + ' ' }).valid,
			false,
		);
		assert.equal(verifySignature({ ...base, secret: 'other', rawBody: body }).valid, false);
		assert.deepEqual(
			verifySignature({ ...base, secret: 'whsec_test', rawBody: body, signature: undefined }),
			{
				valid: false,
				reason: 'missing_headers',
			},
		);
		assert.deepEqual(verifySignature({ ...base, secret: '', rawBody: body }), {
			valid: false,
			reason: 'missing_headers',
		});
	});
});

describe('flattenRecord', () => {
	it('puts data at the top level next to the record meta', () => {
		const out = flattenRecord({
			id: 'r1',
			entity: 'clienti',
			created_at: 'c',
			updated_at: 'u',
			data: { nome: 'Mario', stato: 'open' },
		});
		assert.deepEqual(out, {
			id: 'r1',
			entity: 'clienti',
			created_at: 'c',
			updated_at: 'u',
			nome: 'Mario',
			stato: 'open',
		});
	});

	it('keeps the meta on a clash and moves the field to data_<slug>', () => {
		const out = flattenRecord({ id: 'r1', entity: 'e', data: { id: 'X', entity: 'Y', name: 'n' } });
		assert.equal(out.id, 'r1');
		assert.equal(out.entity, 'e');
		assert.equal(out.data_id, 'X');
		assert.equal(out.data_entity, 'Y');
		assert.equal(out.name, 'n');
	});

	it('treats extra keys (trigger metadata) as reserved too', () => {
		const out = flattenRecord({ id: 'r1', data: { event: 'mine' } }, { event: 'record.updated' });
		assert.equal(out.event, 'record.updated');
		assert.equal(out.data_event, 'mine');
	});

	it('copes with a record without data', () => {
		assert.deepEqual(flattenRecord({ id: 'r1', data: null }), { id: 'r1' });
	});
});

describe('filtersToQuery', () => {
	it('maps operators to where[...] pairs', () => {
		const pairs = filtersToQuery([
			{ field: 'email', operator: 'eq', value: 'a@b.c' },
			{ field: 'importo', operator: 'gte', value: 100 },
			{ field: 'note', operator: 'empty', value: 'ignored' },
			{ field: 'stato', operator: 'in', value: 'open,closed' },
			{ field: 'tags', operator: 'in', value: ['a', 'b'] },
			{ field: '', operator: 'eq', value: 'skipped' },
		]);
		assert.deepEqual(pairs, [
			['where[email]', 'a@b.c'],
			['where[importo][gte]', '100'],
			['where[note][empty]', 'true'],
			['where[stato][in]', 'open,closed'],
			['where[tags][in]', 'a,b'],
		]);
	});

	it('refuses an unknown operator', () => {
		assert.throws(
			() => filtersToQuery([{ field: 'x', operator: 'like', value: 'y' }]),
			/Unknown filter operator/,
		);
	});

	it('encodes values but keeps the brackets readable', () => {
		const qs = encodeQuery([
			...filtersToQuery([{ field: 'nome', operator: 'contains', value: 'a&b c' }]),
			['limit', '100'],
		]);
		assert.equal(qs, 'where[nome][contains]=a%26b%20c&limit=100');
	});

	it('builds the sort parameter', () => {
		assert.equal(sortParam('created_at', 'desc'), '-created_at');
		assert.equal(sortParam('nome', 'asc'), 'nome');
		assert.equal(sortParam('', 'asc'), undefined);
	});
});

describe('mapFieldType', () => {
	const cases = [
		[{ type: 'text' }, 'string'],
		[{ type: 'email' }, 'string'],
		[{ type: 'number' }, 'number'],
		[{ type: 'currency' }, 'number'],
		[{ type: 'percent' }, 'number'],
		[{ type: 'date' }, 'dateTime'],
		[{ type: 'datetime' }, 'dateTime'],
		[{ type: 'checkbox' }, 'boolean'],
		[{ type: 'select', options: [{ value: 'open', label: 'Open' }] }, 'options'],
		[{ type: 'select', multiple: true, options: [{ value: 'a', label: 'A' }] }, 'array'],
		[{ type: 'select' }, 'string'],
		[{ type: 'relation' }, 'string'],
		[{ type: 'relation', multiple: true }, 'array'],
		[{ type: 'files' }, 'array'],
		[{ type: 'linked_records' }, 'array'],
		[{ type: 'daterange' }, 'object'],
		[{ type: 'something_new' }, 'string'],
	];
	for (const [f, expected] of cases) {
		it(`${f.type}${f.multiple ? ' (multiple)' : ''} → ${expected}`, () => {
			assert.equal(mapFieldType(field(f)), expected);
		});
	}

	it('only lets comparable writable fields identify a record', () => {
		assert.equal(canMatchOn(field({ type: 'email' })), true);
		assert.equal(canMatchOn(field({ type: 'relation' })), false);
		assert.equal(canMatchOn(field({ type: 'select', multiple: true })), false);
		assert.equal(canMatchOn(field({ type: 'text', read_only: true })), false);
	});
});

describe('buildWriteBody', () => {
	const fields = [
		field({ slug: 'nome' }),
		field({ slug: 'note' }),
		field({ slug: 'totale', type: 'formula', read_only: true }),
	];

	it('drops read-only, unknown and empty values', () => {
		const body = buildWriteBody(
			{ nome: 'Mario', note: '', totale: 5, extra: 'x', id: 'r1' },
			fields,
		);
		assert.deepEqual(body, { nome: 'Mario' });
	});

	it('keeps empty values when asked, to clear a field', () => {
		const body = buildWriteBody({ nome: 'Mario', note: null }, fields, { keepEmpty: true });
		assert.deepEqual(body, { nome: 'Mario', note: null });
	});
});

describe('transport helpers', () => {
	it('bounds Retry-After between 1 and 30 s', () => {
		assert.equal(retryAfterSeconds('12'), 12);
		assert.equal(retryAfterSeconds('120'), 30);
		assert.equal(retryAfterSeconds(undefined), 1);
		assert.equal(retryAfterSeconds(['5']), 5);
	});

	it('normalizes the Connect URL', () => {
		assert.equal(
			normalizeBaseUrl(' https://x.supabase.co/functions/v1/connect/ '),
			'https://x.supabase.co/functions/v1/connect',
		);
		assert.equal(
			normalizeBaseUrl('https://x.supabase.co/functions/v1/connect/v1'),
			'https://x.supabase.co/functions/v1/connect',
		);
	});

	it('reads the API error envelope', () => {
		const info = describeApiError({
			error: {
				code: 'select_option_invalid',
				field: 'stato',
				message: '"Boh" is not an option',
				allowed: ['Aperto', 'Chiuso'],
			},
		});
		assert.equal(info.message, '"Boh" is not an option');
		assert.equal(
			info.description,
			'Code: select_option_invalid · Field: stato · Allowed: Aperto, Chiuso',
		);
		assert.deepEqual(describeApiError('not json'), {});
	});
});
