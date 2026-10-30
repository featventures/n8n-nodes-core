import type { INodeProperties } from 'n8n-workflow';

/** The entity picker shared by CORE and CORE Trigger: from the list, or by slug. */
export const entityLocator: INodeProperties = {
	displayName: 'Entity',
	name: 'entity',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The CORE entity (table) to work with',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchEntities', searchable: true },
		},
		{
			displayName: 'By Slug',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. clienti',
			validation: [
				{
					type: 'regex',
					properties: { regex: '^[a-z0-9_\\-]+$', errorMessage: 'Not a valid entity slug' },
				},
			],
		},
	],
};
