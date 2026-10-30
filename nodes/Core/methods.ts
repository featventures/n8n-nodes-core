import type {
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';

import { canMatchOn, mapFieldType } from './helpers';
import { listEntities, listFields } from './transport';

/** Slug of the entity picked in the `entity` resource locator. */
export function selectedEntity(this: ILoadOptionsFunctions): string {
	const value = this.getNodeParameter('entity', undefined, { extractValue: true }) as string;
	return String(value ?? '').trim();
}

export async function searchEntities(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const entities = await listEntities.call(this);
	const q = (filter ?? '').trim().toLowerCase();
	return {
		results: entities
			.filter((e) => !q || e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((e) => ({ name: e.name, value: e.slug, description: e.description ?? undefined })),
	};
}

async function fieldOptions(
	this: ILoadOptionsFunctions,
	keep: (f: Awaited<ReturnType<typeof listFields>>[number]) => boolean,
): Promise<INodePropertyOptions[]> {
	const entity = selectedEntity.call(this);
	if (!entity) return [];
	const fields = await listFields.call(this, entity);
	return fields
		.filter(keep)
		.map((f) => ({ name: f.name, value: f.slug, description: `${f.slug} · ${f.type}` }));
}

/** Fields that can identify a record for "Create or Update". */
export async function getMatchFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await fieldOptions.call(this, canMatchOn);
}

/** Every field, for filters, the trigger's field filter and sorting. */
export async function getAllFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await fieldOptions.call(this, () => true);
}

export async function getSortFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const fields = await fieldOptions.call(this, () => true);
	return [
		{ name: 'Created At', value: 'created_at' },
		{ name: 'Updated At', value: 'updated_at' },
		...fields,
	];
}

/** Resource mapper schema: writable fields, CORE types mapped to n8n types, select options. */
export async function getMappingFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const entity = selectedEntity.call(this);
	if (!entity) return { fields: [], emptyFieldsNotice: 'Choose an entity first' };
	const operation = this.getNodeParameter('operation', '') as string;
	const fields = await listFields.call(this, entity);
	const out: ResourceMapperField[] = fields
		.filter((f) => !f.read_only)
		.map((f) => {
			const type = mapFieldType(f);
			return {
				id: f.slug,
				displayName: f.name,
				// An update only touches what is mapped: nothing is mandatory there.
				required: operation === 'update' ? false : !!f.required,
				defaultMatch: false,
				canBeUsedToMatch: canMatchOn(f),
				display: true,
				type,
				...(type === 'options'
					? { options: (f.options ?? []).map((o) => ({ name: o.label, value: o.value })) }
					: {}),
			};
		});
	return { fields: out };
}
