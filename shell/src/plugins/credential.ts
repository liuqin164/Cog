import type { CredentialService } from '../credentials.ts';
import type { NativePlugin, ToolOutcome } from './host.ts';

export function credentialPlugin(): NativePlugin {
  return {
    name: 'credential-requests',
    inject: ['credentials'],
    apply(ctx) {
      const credentials = ctx.getService<CredentialService>('credentials');
      ctx.registerTool({
        name: 'request_credential',
        description: 'Ask the owner for credentials in the trusted terminal or observatory form. Give the service, the purpose and the exact fields you need. The owner enters the values outside the conversation; this tool returns only a reference name, never the values. Use that reference as `credential` on bash to have the host inject the fields as environment variables.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            service: { type: 'string', description: 'Service the credential belongs to, e.g. "demo-api"' },
            purpose: { type: 'string', description: 'One line telling the owner what the credential will be used for' },
            fields: {
              type: 'array',
              description: 'Fields to collect, in order',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Machine name, e.g. "account" or "password"' },
                  label: { type: 'string', description: 'Prompt shown to the owner' },
                  secret: { type: 'boolean', description: 'True when the field must never be echoed' },
                },
                required: ['name'],
              },
            },
          },
          required: ['service', 'purpose', 'fields'],
        },
        async execute({ args, signal }): Promise<ToolOutcome> {
          const outcome = await credentials.request({
            service: args?.service,
            purpose: args?.purpose,
            fields: args?.fields,
          }, signal);
          if (outcome.outcome === 'cancelled') {
            return { output: 'credential_cancelled: the owner cancelled the request; nothing was saved.', isError: false };
          }
          return {
            output: `credential_saved: saved as "${outcome.ref}". Pass that name as the bash tool's credential argument; the host injects the fields as environment variables named COGMEM_CRED_<REF>_<FIELD>. Do not print them.`,
            isError: false,
          };
        },
      });
    },
  };
}
