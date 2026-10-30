import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { CoreField, CoreRecord, SearchFilter } from './helpers';
import { buildWriteBody, filtersToQuery, flattenRecord, sortParam } from './helpers';
import {
	getAllFields,
	getMappingFields,
	getMatchFields,
	getSortFields,
	searchEntities,
} from './methods';
import { entityLocator } from './entityLocator';
import { coreApiRequest, listEntities, listFields } from './transport';

/*
 * Programmatic style: the record fields come from a resource mapper whose schema depends on the
 * chosen entity, Search follows `next_cursor` across pages, and every write first needs the
 * entity's fields to drop read-only ones. Declarative routing cannot express those steps.
 */

const show = (resource: string, operation: string[]) => ({
	show: { resource: [resource], operation },
});

const RECORD_WRITE_OPS = ['create', 'upsert'];

const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Record', value: 'record' },
			{ name: 'Entity', value: 'entity' },
		],
		default: 'record',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['record'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create a record',
				action: 'Create a record',
			},
			{
				name: 'Create or Update',
				value: 'upsert',
				description: 'Create a new record, or update the current one if it already exists (upsert)',
				action: 'Create or update a record',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Move a record to the trash',
				action: 'Delete a record',
			},
			{ name: 'Get', value: 'get', description: 'Get a record by ID', action: 'Get a record' },
			{
				name: 'Search',
				value: 'search',
				description: 'Search records with filters',
				action: 'Search records',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Update the mapped fields of a record',
				action: 'Update a record',
			},
		],
		default: 'create',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['entity'] } },
		options: [
			{
				name: 'Get Fields',
				value: 'getFields',
				description: 'Get the fields of an entity',
				action: 'Get the fields of an entity',
			},
			{
				name: 'List',
				value: 'list',
				description: 'List the entities the API key can read',
				action: 'List entities',
			},
		],
		default: 'list',
	},
	{
		...entityLocator,
		displayOptions: { show: { resource: ['record'] } },
	},
	{
		...entityLocator,
		displayOptions: show('entity', ['getFields']),
	},
	{
		displayName: 'Record ID',
		name: 'recordId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: show('record', ['get', 'update', 'delete']),
		description: 'The ID of the record',
	},
	{
		displayName: 'Match On Field Name or ID',
		name: 'matchField',
		type: 'options',
		required: true,
		default: '',
		typeOptions: { loadOptionsMethod: 'getMatchFields', loadOptionsDependsOn: ['entity.value'] },
		displayOptions: show('record', ['upsert']),
		description:
			'The record with the same value in this field is updated; if there is none, a new record is created. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Fields',
		name: 'fields',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		displayOptions: show('record', RECORD_WRITE_OPS),
		typeOptions: {
			loadOptionsDependsOn: ['entity.value', 'operation'],
			resourceMapper: {
				resourceMapperMethod: 'getMappingFields',
				mode: 'add',
				fieldWords: { singular: 'field', plural: 'fields' },
				addAllFields: true,
				supportAutoMap: true,
				noFieldsError: 'This entity has no fields that can be written',
				multiKeyMatch: false,
			},
		},
	},
	{
		displayName: 'Fields',
		name: 'fieldsToUpdate',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		displayOptions: show('record', ['update']),
		typeOptions: {
			loadOptionsDependsOn: ['entity.value', 'operation'],
			resourceMapper: {
				resourceMapperMethod: 'getMappingFields',
				mode: 'add',
				fieldWords: { singular: 'field', plural: 'fields' },
				// Only the fields the user adds are sent: the others keep their value in CORE.
				addAllFields: false,
				supportAutoMap: true,
				noFieldsError: 'This entity has no fields that can be written',
				multiKeyMatch: false,
			},
		},
	},
	{
		displayName: 'Options',
		name: 'writeOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show('record', ['create', 'upsert', 'update']),
		options: [
			{
				displayName: 'Send Empty Values',
				name: 'keepEmpty',
				type: 'boolean',
				default: false,
				description:
					'Whether to send fields left empty (to clear them in CORE). Off: empty fields are not sent and keep their value.',
			},
		],
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'fixedCollection',
		placeholder: 'Add filter',
		default: {},
		typeOptions: { multipleValues: true },
		displayOptions: show('record', ['search']),
		description: 'All the filters must match (AND)',
		options: [
			{
				displayName: 'Condition',
				name: 'conditions',
				values: [
					{
						displayName: 'Field Name or ID',
						name: 'field',
						type: 'options',
						default: '',
						typeOptions: {
							loadOptionsMethod: 'getAllFields',
							loadOptionsDependsOn: ['entity.value'],
						},
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Operator',
						name: 'operator',
						type: 'options',
						default: 'eq',
						options: [
							{ name: 'Contains', value: 'contains' },
							{ name: 'Equals', value: 'eq' },
							{ name: 'Greater Than', value: 'gt' },
							{ name: 'Greater Than or Equal', value: 'gte' },
							{ name: 'Is Empty', value: 'empty' },
							{ name: 'Is Not Empty', value: 'not_empty' },
							{ name: 'Is One Of', value: 'in' },
							{ name: 'Less Than', value: 'lt' },
							{ name: 'Less Than or Equal', value: 'lte' },
							{ name: 'Not Equals', value: 'neq' },
						],
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						displayOptions: { hide: { operator: ['empty', 'not_empty'] } },
						description: 'For "Is One Of", separate the values with commas',
					},
				],
			},
		],
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: show('record', ['search']),
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: ['record'], operation: ['search'], returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Options',
		name: 'searchOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show('record', ['search']),
		options: [
			{
				displayName: 'Sort By Name or ID',
				name: 'sortField',
				type: 'options',
				default: '',
				typeOptions: { loadOptionsMethod: 'getSortFields', loadOptionsDependsOn: ['entity.value'] },
				description:
					'Default: newest first. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Sort Direction',
				name: 'sortDirection',
				type: 'options',
				default: 'asc',
				options: [
					{ name: 'Ascending', value: 'asc' },
					{ name: 'Descending', value: 'desc' },
				],
			},
		],
	},
];

/** Records per page asked to the API (its maximum). */
const PAGE_SIZE = 100;

export class Core implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CORE',
		name: 'core',
		icon: { light: 'file:core.svg', dark: 'file:core.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read, create, update and search records in CORE',
		defaults: { name: 'CORE' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'coreApi', required: true }],
		properties,
	};

	methods = {
		listSearch: { searchEntities },
		loadOptions: { getMatchFields, getAllFields, getSortFields },
		resourceMapping: { getMappingFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const fieldsCache = new Map<string, CoreField[]>();

		const fieldsOf = async (entity: string, itemIndex: number): Promise<CoreField[]> => {
			let fields = fieldsCache.get(entity);
			if (!fields) {
				fields = await listFields.call(this, entity, itemIndex);
				fieldsCache.set(entity, fields);
			}
			return fields;
		};

		const push = (json: IDataObject, itemIndex: number) =>
			out.push({ json, pairedItem: { item: itemIndex } });

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'entity') {
					if (operation === 'list') {
						for (const e of await listEntities.call(this)) push({ ...e }, i);
					} else {
						const entity = entitySlug(this, i);
						for (const f of await fieldsOf(entity, i)) push({ entity, ...f }, i);
					}
					continue;
				}

				const entity = entitySlug(this, i);
				const recordsPath = `/v1/records/${encodeURIComponent(entity)}`;

				if (operation === 'create' || operation === 'upsert' || operation === 'update') {
					const param = operation === 'update' ? 'fieldsToUpdate' : 'fields';
					const mapper = this.getNodeParameter(param, i) as ResourceMapperValue;
					const opts = this.getNodeParameter('writeOptions', i, {}) as { keepEmpty?: boolean };
					const fields = await fieldsOf(entity, i);
					const removed = new Set((mapper.schema ?? []).filter((f) => f.removed).map((f) => f.id));
					const source: IDataObject =
						mapper.mappingMode === 'autoMapInputData'
							? { ...items[i].json }
							: { ...((mapper.value ?? {}) as IDataObject) };
					for (const id of removed) delete source[id];
					const body = buildWriteBody(source, fields, { keepEmpty: opts.keepEmpty });

					let res;
					if (operation === 'update') {
						if (Object.keys(body).length === 0) {
							throw new NodeOperationError(
								this.getNode(),
								'No field to update: map at least one field',
								{
									itemIndex: i,
								},
							);
						}
						res = await coreApiRequest.call(
							this,
							'PATCH',
							`${recordsPath}/${encodeURIComponent(recordId(this, i))}`,
							{
								body,
								itemIndex: i,
							},
						);
					} else if (operation === 'upsert') {
						const matchField = this.getNodeParameter('matchField', i) as string;
						if (
							body[matchField] === undefined ||
							body[matchField] === null ||
							body[matchField] === ''
						) {
							throw new NodeOperationError(
								this.getNode(),
								`The field to match on ("${matchField}") has no value`,
								{ itemIndex: i, description: 'Map a value for it in Fields.' },
							);
						}
						res = await coreApiRequest.call(this, 'POST', recordsPath, {
							body,
							query: [['upsert_on', matchField]],
							itemIndex: i,
						});
					} else {
						res = await coreApiRequest.call(this, 'POST', recordsPath, { body, itemIndex: i });
					}
					push(flattenRecord(res.body as unknown as CoreRecord), i);
				} else if (operation === 'get') {
					const res = await coreApiRequest.call(
						this,
						'GET',
						`${recordsPath}/${encodeURIComponent(recordId(this, i))}`,
						{ itemIndex: i },
					);
					push(flattenRecord(res.body as unknown as CoreRecord), i);
				} else if (operation === 'delete') {
					const res = await coreApiRequest.call(
						this,
						'DELETE',
						`${recordsPath}/${encodeURIComponent(recordId(this, i))}`,
						{ itemIndex: i },
					);
					push(res.body as IDataObject, i);
				} else if (operation === 'search') {
					for (const record of await searchRecords(this, recordsPath, i))
						push(flattenRecord(record), i);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({
						json: {
							error: (error as Error).message,
							...((error as NodeApiError).description
								? { description: (error as NodeApiError).description }
								: {}),
						},
						pairedItem: { item: i },
					});
					continue;
				}
				// A NodeApiError keeps the API's HTTP code and message; anything else is wrapped
				// (NodeOperationError returns an existing NodeOperationError as is).
				throw error instanceof NodeApiError
					? error
					: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}

function entitySlug(ctx: IExecuteFunctions, itemIndex: number): string {
	const value = String(
		ctx.getNodeParameter('entity', itemIndex, '', { extractValue: true }) ?? '',
	).trim();
	if (!value) throw new NodeOperationError(ctx.getNode(), 'Choose an entity', { itemIndex });
	return value;
}

function recordId(ctx: IExecuteFunctions, itemIndex: number): string {
	const value = String(ctx.getNodeParameter('recordId', itemIndex, '') ?? '').trim();
	if (!value) throw new NodeOperationError(ctx.getNode(), 'Record ID is required', { itemIndex });
	return value;
}

async function searchRecords(
	ctx: IExecuteFunctions,
	path: string,
	itemIndex: number,
): Promise<CoreRecord[]> {
	const returnAll = ctx.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (ctx.getNodeParameter('limit', itemIndex, 50) as number);
	const filters =
		(ctx.getNodeParameter('filters', itemIndex, {}) as { conditions?: SearchFilter[] })
			.conditions ?? [];
	const opts = ctx.getNodeParameter('searchOptions', itemIndex, {}) as {
		sortField?: string;
		sortDirection?: string;
	};

	let base: Array<[string, string]>;
	try {
		base = filtersToQuery(filters);
	} catch (e) {
		throw new NodeOperationError(ctx.getNode(), (e as Error).message, { itemIndex });
	}
	const sort = sortParam(opts.sortField, opts.sortDirection);
	if (sort) base.push(['sort', sort]);

	const records: CoreRecord[] = [];
	let cursor: string | null = null;
	do {
		const pageSize = Math.min(PAGE_SIZE, limit - records.length);
		const query: Array<[string, string]> = [...base, ['limit', String(pageSize)]];
		if (cursor) query.push(['cursor', cursor]);
		const res = await coreApiRequest.call(ctx, 'GET', path, { query, itemIndex });
		const body = res.body as { records?: CoreRecord[]; next_cursor?: string | null };
		records.push(...(body.records ?? []));
		cursor = body.next_cursor ?? null;
	} while (cursor && records.length < limit);

	return records.slice(0, limit === Infinity ? undefined : limit);
}
