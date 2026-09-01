import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="login-wrap">
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        <h1>Page not found</h1>
        <p style={{ color: 'var(--muted)', margin: '8px 0 22px' }}>
          That page does not exist, or you no longer have access to it.
        </p>
        <Link href="/" className="btn">
          Go back
        </Link>
      </div>
    </div>
  );
}
