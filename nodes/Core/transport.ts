import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

import type { CoreField } from './helpers';
import { describeApiError, encodeQuery, normalizeBaseUrl, retryAfterSeconds } from './helpers';

type CoreContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

export interface CoreResponse<T = IDataObject> {
	body: T;
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
}

/**
 * One call to the Connect API with the CORE credential. A 429 is retried once after
 * Retry-After (at most 30 s); any other error becomes a NodeApiError with the API's message.
 */
export async function coreApiRequest<T = IDataObject>(
	this: CoreContext,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; query?: Array<[string, string]>; itemIndex?: number } = {},
): Promise<CoreResponse<T>> {
	const credentials = await this.getCredentials<{ connectUrl: string }>('coreApi');
	const base = normalizeBaseUrl(credentials.connectUrl);
	const qs = options.query && options.query.length > 0 ? `?${encodeQuery(options.query)}` : '';
	const request: IHttpRequestOptions = {
		method,
		url: `${base}${path}${qs}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		headers: { Accept: 'application/json' },
	};
	if (options.body !== undefined) request.body = options.body;

	let response = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'coreApi',
		request,
	)) as CoreResponse<T>;

	if (response.statusCode === 429) {
		await sleep(retryAfterSeconds(response.headers?.['retry-after']) * 1000);
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'coreApi',
			request,
		)) as CoreResponse<T>;
	}

	if (response.statusCode >= 400) {
		const info = describeApiError(response.body);
		throw new NodeApiError(this.getNode(), (response.body ?? {}) as JsonObject, {
			message: info.message ?? `CORE answered HTTP ${response.statusCode}`,
			description: info.description,
			httpCode: String(response.statusCode),
			itemIndex: options.itemIndex,
		});
	}
	return response;
}

export interface CoreEntity {
	slug: string;
	name: string;
	description?: string | null;
	can_create?: boolean;
	can_update?: boolean;
	can_delete?: boolean;
}

export async function listEntities(this: CoreContext): Promise<CoreEntity[]> {
	const res = await coreApiRequest.call(this, 'GET', '/v1/entities');
	return ((res.body as { entities?: CoreEntity[] }).entities ?? []) as CoreEntity[];
}

export async function listFields(
	this: CoreContext,
	entity: string,
	itemIndex?: number,
): Promise<CoreField[]> {
	const res = await coreApiRequest.call(
		this,
		'GET',
		`/v1/entities/${encodeURIComponent(entity)}/fields`,
		{ itemIndex },
	);
	return ((res.body as { fields?: CoreField[] }).fields ?? []) as CoreField[];
}
