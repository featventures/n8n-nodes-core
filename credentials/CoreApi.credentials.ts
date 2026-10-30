import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CoreApi implements ICredentialType {
	name = 'coreApi';

	displayName = 'CORE API';

	icon: Icon = { light: 'file:../nodes/Core/core.svg', dark: 'file:../nodes/Core/core.dark.svg' };

	documentationUrl = 'https://github.com/featventures/n8n-nodes-core#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Connect URL',
			name: 'connectUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://<project>.supabase.co/functions/v1/connect',
			description: 'The Connect URL shown in CORE › Integrations › n8n',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'core_…',
			description:
				'The API key of the n8n connection (starts with core_). CORE shows it once, when the connection is created.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			// Same as `{{$credentials.connectUrl}}/v1/me`, tolerating a trailing slash in the URL.
			url: '={{$credentials.connectUrl.replace(/\\/+$/, "")}}/v1/me',
			method: 'GET',
		},
	};
}
