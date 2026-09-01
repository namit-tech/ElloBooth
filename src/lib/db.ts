import mongoose from 'mongoose';

/**
 * Next.js hot-reloads modules in dev, which would otherwise open a new
 * connection pool on every edit. Cache the promise on globalThis.
 */

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ello_booth';

type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };

const globalCache = globalThis as unknown as { _mongoose?: Cache };
const cached: Cache = globalCache._mongoose ?? { conn: null, promise: null };
globalCache._mongoose = cached;

export async function connectDB(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 8000,
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null; // let the next request retry instead of caching a failure
    throw err;
  }
  return cached.conn;
}
