'use client';

/** Last-resort boundary. It replaces the root layout, so it renders its own <html>. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#0d0c0b',
          color: '#f3ece2',
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          padding: 24,
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ color: '#a39a8e', fontSize: 14, margin: '0 0 22px', lineHeight: 1.6 }}>
            The page could not be loaded. Try again, and if it keeps happening contact Elloindia support.
          </p>
          <button
            onClick={reset}
            style={{
              background: '#e0a63c',
              color: '#14110d',
              border: 0,
              borderRadius: 8,
              padding: '10px 22px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
