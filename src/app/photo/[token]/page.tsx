import { notFound } from 'next/navigation';
import { connectDB } from '@/lib/db';
import { Generation, Tenant, type IGeneration, type ITenant } from '@/models';

/** The page a visitor lands on after scanning the booth's QR code. */

export const dynamic = 'force-dynamic';

export default async function PhotoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[\w-]{20,64}$/.test(token)) notFound();

  await connectDB();
  const generation = await Generation.findOne({ shareToken: token, status: 'ok' }).lean<IGeneration>();
  if (!generation) notFound();

  const expired = generation.expiresAt && new Date(generation.expiresAt) < new Date();
  const tenant = await Tenant.findById(generation.tenantId, { name: 1, branding: 1 }).lean<ITenant>();
  const accent = tenant?.branding?.accent ?? '#e0a63c';

  return (
    <div className="photo-page">
      <style>{`
        .photo-page {
          min-height: 100vh; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 20px;
          padding: 24px; background: #0d0c0b; color: #f3ece2;
          font-family: "Segoe UI", system-ui, sans-serif; text-align: center;
        }
        .photo-page img { max-width: 100%; max-height: 68vh; border-radius: 12px; box-shadow: 0 10px 44px #000a; }
        .photo-page .dl {
          background: ${accent}; color: #14110d; padding: 14px 36px; border-radius: 999px;
          font-weight: 700; text-decoration: none; font-size: 17px;
        }
        .photo-page .hint { opacity: .5; font-size: 13px; margin: 0; }
        .photo-page h1 { font-size: 20px; margin: 0; }
      `}</style>

      {expired ? (
        <>
          <h1>This photo has expired</h1>
          <p className="hint">
            {tenant?.name ?? 'The organiser'} keeps booth photos for a limited time, and this one has now been
            deleted.
          </p>
        </>
      ) : (
        <>
          <img src={`/api/photo/${token}`} alt="Your booth photo" />
          <a className="dl" href={`/api/photo/${token}`} download={`photo-${token.slice(0, 8)}.png`}>
            Download
          </a>
          <p className="hint">
            Image par der tak dabakar bhi save kar sakte hain
            {tenant?.name ? ` · ${tenant.name}` : ''}
          </p>
        </>
      )}
    </div>
  );
}
