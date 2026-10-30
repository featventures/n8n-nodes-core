import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { entityLocator } from '../Core/entityLocator';
import type { CoreRecord } from '../Core/helpers';
import { flattenRecord } from '../Core/helpers';
import { getAllFields, searchEntities } from '../Core/methods';
import { coreApiRequest } from '../Core/transport';
import { headerValue, verifySignature } from './signature';

interface TriggerStaticData extends IDataObject {
	subscriptionId?: string;
	secret?: string;
}

interface CoreDelivery {
	event?: string;
	delivery_id?: string;
	occurred_at?: string;
	entity?: { slug?: string; name?: string };
	record?: CoreRecord;
	changed_fields?: string[];
}

export class CoreTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CORE Trigger',
		name: 'coreTrigger',
		icon: { light: 'file:core.svg', dark: 'file:core.dark.svg' },
		group: ['trigger'],
		version: [1],
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when a CORE record is created, updated or deleted',
		defaults: { name: 'CORE Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'coreApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			entityLocator,
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['record.created'],
				options: [
					{ name: 'Record Created', value: 'record.created' },
					{
						name: 'Record Deleted',
						value: 'record.deleted',
						description: 'Also when it is moved to the trash',
					},
					{ name: 'Record Updated', value: 'record.updated' },
				],
			},
			{
				displayName: 'Only When These Fields Change Names or IDs',
				name: 'fields',
				type: 'multiOptions',
				default: [],
				typeOptions: { loadOptionsMethod: 'getAllFields', loadOptionsDependsOn: ['entity.value'] },
				displayOptions: { show: { events: ['record.updated'] } },
				description:
					'For "Record Updated": start only when one of these fields changes. Empty: any change. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		listSearch: { searchEntities },
		loadOptions: { getAllFields },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as TriggerStaticData;
				if (!data.subscriptionId) return false;
				const res = await coreApiRequest.call(this, 'GET', '/v1/subscriptions');
				const list =
					(res.body as { subscriptions?: Array<{ id: string; url?: string }> }).subscriptions ?? [];
				const url = this.getNodeWebhookUrl('default');
				const found = list.find((s) => s.id === data.subscriptionId);
				if (found && (!url || !found.url || found.url === url) && data.secret) return true;
				if (found) {
					// Still in CORE but pointing to another URL (or its secret is lost): remove it
					// rather than leave an orphan subscription behind.
					try {
						await coreApiRequest.call(
							this,
							'DELETE',
							`/v1/subscriptions/${encodeURIComponent(found.id)}`,
						);
					} catch (error) {
						// Best effort: create() registers the new one either way.
						this.logger.warn(`CORE Trigger: could not remove the old subscription ${found.id}`, {
							error: (error as Error).message,
						});
					}
				}
				// Gone on the CORE side (or pointing elsewhere): forget it so create() makes a new one.
				delete data.subscriptionId;
				delete data.secret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				if (!url)
					throw new NodeOperationError(this.getNode(), 'n8n has no webhook URL for this node');
				const entity = String(
					this.getNodeParameter('entity', '', { extractValue: true }) ?? '',
				).trim();
				if (!entity) throw new NodeOperationError(this.getNode(), 'Choose an entity');
				const events = this.getNodeParameter('events', []) as string[];
				if (events.length === 0)
					throw new NodeOperationError(this.getNode(), 'Choose at least one event');
				const fields = events.includes('record.updated')
					? (this.getNodeParameter('fields', []) as string[])
					: [];
				const body: IDataObject = {
					entity,
					events,
					url,
					name: `n8n · ${this.getWorkflow().name ?? this.getWorkflow().id ?? 'workflow'}`.slice(
						0,
						120,
					),
				};
				if (fields.length > 0) body.fields = fields;
				const res = await coreApiRequest.call(this, 'POST', '/v1/subscriptions', { body });
				const created = res.body as { id?: string; secret?: string };
				if (!created.id || !created.secret) {
					throw new NodeOperationError(
						this.getNode(),
						'CORE did not return the subscription id and secret',
					);
				}
				const data = this.getWorkflowStaticData('node') as TriggerStaticData;
				data.subscriptionId = created.id;
				data.secret = created.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as TriggerStaticData;
				if (data.subscriptionId) {
					try {
						await coreApiRequest.call(
							this,
							'DELETE',
							`/v1/subscriptions/${encodeURIComponent(data.subscriptionId)}`,
						);
					} catch (error) {
						// Already removed in CORE: nothing left to clean up.
						if ((error as { httpCode?: string }).httpCode !== '404') return false;
					}
				}
				delete data.subscriptionId;
				delete data.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const data = this.getWorkflowStaticData('node') as TriggerStaticData;
		const body = this.getBodyData() as CoreDelivery;

		const raw = (req as unknown as { rawBody?: Buffer | string }).rawBody;
		const rawBody = raw !== undefined && raw !== null ? raw.toString() : JSON.stringify(body);
		const check = verifySignature({
			secret: data.secret ?? '',
			timestamp: headerValue(req.headers['x-core-timestamp']),
			signature: headerValue(req.headers['x-core-signature']),
			rawBody,
		});
		if (!check.valid) {
			res.status(401).json({ error: { code: 'invalid_signature', message: check.reason } });
			return { noWebhookResponse: true };
		}

		const event = body.event ?? headerValue(req.headers['x-core-event']);
		// Same shape as the CORE node's output, plus the delivery metadata; a data field that
		// clashes with any of these keys is kept under `data_<slug>`.
		const json = flattenRecord(
			{ ...(body.record ?? { id: '' }), entity: body.entity?.slug },
			{
				event,
				delivery_id: body.delivery_id ?? headerValue(req.headers['x-core-delivery']),
				occurred_at: body.occurred_at,
				entity_name: body.entity?.name,
				changed_fields: body.changed_fields ?? [],
			},
		);

		return { workflowData: [this.helpers.returnJsonArray([json])] };
	}
}
