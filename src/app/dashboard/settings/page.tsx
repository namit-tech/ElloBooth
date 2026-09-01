import { requireTenant } from '@/lib/rbac';
import { PROVIDERS, providerOf, type Provider } from '@/lib/ai';
import ApiKeyCard from './ApiKeyCard';
import SettingsForm from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { tenant } = await requireTenant('tenant_admin');
  const provider = providerOf(tenant);

  // Only masked hints cross to the client - never a key, not even encrypted.
  const keys = Object.fromEntries(
    PROVIDERS.map((p) => {
      const sealed = tenant.apiKeys?.[p];
      return [
        p,
        sealed?.ciphertext
          ? {
              hint: sealed.hint,
              verifiedAt: sealed.verifiedAt ? new Date(sealed.verifiedAt).toLocaleString('en-IN') : null,
            }
          : null,
      ];
    }),
  ) as Record<Provider, { hint: string; verifiedAt: string | null } | null>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Applies to every booth on this account.</p>
        </div>
      </div>

      <SettingsForm
        keyMode={tenant.keyMode}
        settings={{
          provider,
          model: tenant.settings.model,
          imageSize: tenant.settings.imageSize,
          autoCaptureSeconds: tenant.settings.autoCaptureSeconds,
          countdownSeconds: tenant.settings.countdownSeconds,
          resultDisplaySeconds: tenant.settings.resultDisplaySeconds,
          retentionDays: tenant.settings.retentionDays,
          identityLock: tenant.settings.identityLock,
          realFace: tenant.settings.realFace,
          consentText: tenant.settings.consentText,
          idleTitle: tenant.branding.idleTitle ?? '',
          idleSubtitle: tenant.branding.idleSubtitle ?? '',
          accent: tenant.branding.accent,
        }}
      />

      <ApiKeyCard keyMode={tenant.keyMode} provider={provider} keys={keys} credits={tenant.credits} />
    </>
  );
}
